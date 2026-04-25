# Token-Efficiency Roadmap for Interfacer

> **Status**: approved by user. Implementation in progress. Live progress lives in [WORK_IN_PROGRESS.md](WORK_IN_PROGRESS.md).

## Context

Interfacer today makes single-shot Claude API calls with **no prompt caching**, concatenating the system prompt + active preset + all context items into one request body and sending the result fresh every time. Research the user shared:

- **Prompt caching** gives ~10% read price on cached prefix (1.25× write price). Pays off after the 2nd send within the 5-min TTL — potentially 5–10× effective throughput on cached portion.
- **ITPM rate limits** (input tokens/min) bite earlier than the monthly budget cap.
- **`max_tokens` counts against OTPM upfront**, even if response is shorter.
- **Cached tokens often don't count toward ITPM** (model-dependent).

Goal: keep Interfacer a **minimal assistant**, not a full agent.

User-locked decisions:
- Pinned context items: **per-workspace** (`context.workspaceState`).
- Cost display: **always-on**, color-coded as it approaches limits.
- Output handling: **chunked streaming** (soft, hidden auto-continue) — keep visible Continue button only when **total** output cap is reached.
- Replace per-preset `max_tokens` with a global **per-request input-token cap**.
- Structure-only file context: **future / non-urgent**.
- API tier: auto-detect from `anthropic-ratelimit-*` headers (no setting).
- Pricing: hardcoded with `// pricing last verified: YYYY-MM-DD` + UI disclaimer "All cost values are estimates based on built-in rates — verify against your Anthropic dashboard."
- Session cost: **auto-resets on extension activation**.

---

## Cache Mechanics — Reference

| Question | Answer |
|---|---|
| **Add to cache** | Attach `cache_control: {type: "ephemeral"}` to a content block. Everything **up to and including** that block is written to cache. Up to **4 breakpoints per request**. |
| **Read from cache** | Automatic longest-prefix byte-match. Just send the same prefix again within TTL. |
| **Edit the cache** | Cannot. Entries are immutable. Different content = new cache entry (1.25× write cost). |
| **Flush the cache** | No manual API. TTL expires it (5 min default, 1 hr with `extended-cache-ttl-2025-04-11` beta header). |
| **Cache status from API** | `usage.cache_creation_input_tokens` (written, 1.25×) and `usage.cache_read_input_tokens` (read, 0.1×). In streaming, surface from `message_delta`. |
| **Tedium** | Low for reads (zero work). Moderate for writes (must place breakpoints carefully — byte-exact prefix matching). |
| **Min size** | ~1024 tokens (Sonnet/Opus), ~2048 (Haiku). Below threshold = `cache_control` silently no-op. |

User-facing mental model: *"If you send the exact same start-of-prompt as last time within 5 minutes, you get the discount."*

---

## Tier 1 — Implement next (highest leverage)

### A. Prompt caching with user-pinnable context items

Three cache breakpoints, in order:
1. **End of `system_prompt + active_preset` block** — cached across every send with same prompt+preset.
2. **End of pinned-context items block** — cached across every send within a workspace with same pin set.
3. **End of user message** — only relevant when chunked streaming (Tier 2C) is active.

Implementation:
- Convert `system: string` → `system: [{type:'text', text:..., cache_control:{type:'ephemeral'}}, ...]`.
- 📌 toggle on each ContextItem row. Pinned items become extra cached system blocks.
- Pin persistence: `pinnedContextHashes: string[]` in `context.workspaceState`, keyed by content hash so re-adding the same file picks up the pin automatically.
- Render `📦 12,400 cached · 320 new` under each assistant reply, sourced from `usage` fields in streamed `message_delta`.
- Warning in preview panel when candidate cached prefix is below model's min threshold.

### B. Token cost estimation with color-coded warnings

- `pricing: {input, output, cacheRead, cacheWrite}` per `MODELS` entry. ✅ done.
- **Pre-send estimate** in preview: chars/4 × pricing. Show as `~12,400 tok · ~$0.012`.
- **Post-send actual** from streamed `usage`, rendered next to cache footer.
- **Color coding**: white → yellow (60%) → red (85% input vs ITPM, 90% session vs soft cap) → banner above 100%.
  - Per-request input vs ITPM: tier auto-detected from `anthropic-ratelimit-input-tokens-limit` header. Fallback `FALLBACK_ITPM = 50000`.
  - Cumulative session cost vs `interfacer.sessionCostSoftLimit` (default $1.00).
- Settings additions: only `interfacer.sessionCostSoftLimit` (number) — needs `package.json` + Settings → Limits UI per CLAUDE.md INVARIANT.

---

## Tier 2 — Smaller wins, after Tier 1

### C. Chunked streaming (soft auto-continue)

- New setting `interfacer.outputTokenChunkSize` (default 2048, range 256 to `maxOutputTokens`). Sent as `max_tokens` per call.
- Existing `interfacer.maxOutputTokens` becomes **total cap across whole logical send**.
- On `stop_reason: max_tokens` AND total output `< maxOutputTokens`: silently fire another call via existing continuation pattern at extension.ts:746. User sees one continuous reply.
- **Final-chunk truncation**: per-call `max_tokens = min(outputTokenChunkSize, maxOutputTokens − alreadyEmitted)`.
- Stop conditions: `stop_reason: end_turn`, total ≥ `maxOutputTokens` (then surface Continue/Done as today), error / rate-limit / abort.
- Requires Tier 1A breakpoint #3 to be efficient.

**Cost-of-chunking display**: extra ≈ `(0.25 + 0.1(K−1))·N·i + (K(K−1)/2)·chunkSize·i`. For N=10k, chunk=2k, K=2 (Sonnet): +15–20%. K=4: +40–60%. Show as `chunked: ~+X%` in preview.

### D. Per-request input-token cap
- New setting `interfacer.maxInputTokensPerRequest` (default 50,000). Sibling to per-file `maxContextChars`.
- Over-budget: block send with modal — drop unpinned, drop largest, or raise cap. Pinned items never auto-dropped.

### E. Context-item deduplication
- Hash content on add; drop exact duplicates. No UI surface.

### F. 1-hour cache TTL toggle
- Single checkbox in Settings → Limits. Adds `extended-cache-ttl-2025-04-11` beta header.

---

## Future / non-urgent (tracked, not planned)

- **Structure-only file context** (AST signatures, no bodies). Needs tree-sitter or LSP.
- **History compression / rolling summaries**. Only relevant if multi-turn conversations are added.

---

## Files to modify (Tier 1 scope)

- `src/extension.ts:767-769` — request body: `system: string` → array of cached blocks
- `src/extension.ts:730` — system + preset assembly produces a cached block
- `src/extension.ts:733-738` — context assembly: pinned → cached system blocks; unpinned → user message
- `src/extension.ts` `MODELS` array (~line 43) — pricing field added ✅
- `src/extension.ts` ContextItem rendering (~line 1799) — add 📌 toggle
- `src/extension.ts` streaming response handler (~line 824–844) — capture `usage.cache_*` from `message_delta`, capture `anthropic-ratelimit-*` headers from response
- `src/extension.ts` provider state + activation — `pinnedContextHashes` in `context.workspaceState`, cumulative session cost in extension memory
- `src/extension.ts` info view + settings view — caching reference, cost disclaimer, render cache footer, render cost estimate with color-coding
- `package.json` `contributes.configuration.properties` — `interfacer.sessionCostSoftLimit` (number)
- `CLAUDE.md` — note that pinned context is per-workspace

CLAUDE.md webview-script gotcha applies: every backslash in the `<script>` block must be `\\`. `npm run check-webview` catches breakage.

## Verification

1. Send non-trivial system prompt twice within 5 min → second response footer reports `cache_read_input_tokens > 0`.
2. Pin a context item, send 3 times → cache reads scale; un-pin drops them next send.
3. Pre-send estimate vs post-send actual within ±20%.
4. Pricing constants match Anthropic's currently published rates (manual sanity check).
5. Switch workspaces → pinned items don't leak across.
6. Cost color-coding: simulate near-cap, confirm yellow → red transitions.
7. (Tier 2C) `outputTokenChunkSize=512`, `maxOutputTokens=2048`, long reply → user sees one response, multiple API calls each with `max_tokens ≤ 512`, total ≤ 2048, last call's `max_tokens` = remaining budget.
8. (Tier 2D) `maxInputTokensPerRequest=1000`, attach 5000-token file → over-budget modal.
9. `npm run compile` passes (tsc + webview validator) clean.
