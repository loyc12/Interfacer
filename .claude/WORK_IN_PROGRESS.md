# Work In Progress

> **Read this first if resuming a previous session.** Update it as you work — this file is the handoff to the next Claude.

**Active work**: Tier 1 of [TOKEN_EFFICIENCY_PLAN.md](TOKEN_EFFICIENCY_PLAN.md) — prompt caching + cost estimation.

**Last touched**: step 6 done (cache-hit + cost footer renders under each assistant reply). Compile is **green** (`npm run compile` → `[validate-webview] OK`). No partial-state hazards. Safe to resume from step 7.

---

## Resume context

The plan is fully approved by the user. Just keep executing the task list below in order.

Key files:
- All extension code is in [src/extension.ts](../src/extension.ts) (~2400 lines now).
- [package.json](../package.json) only changes for the new `interfacer.sessionCostSoftLimit` setting in step 8.
- [scripts/validate-webview.js](../scripts/validate-webview.js) was updated to stub `MODELS`, `observedItpm`, `sessionCostUsd` so the in-isolation `buildWebviewHtml` invocation succeeds. **If you add another module-scope identifier referenced by `buildWebviewHtml`, add a stub in the same place** (right after the `DEFAULT_SYSTEM_PROMPT` injection).

CLAUDE.md webview gotcha: any backslash inside the `<script>` block in `buildWebviewHtml()` must be doubled (`\\`). `npm run compile` runs `scripts/validate-webview.js` and catches breakage.

---

## Task list (ordered)

- [x] **1.** Per-model pricing on `MODELS` array. Added `pricing` and `cacheMinTokens` fields, plus `FALLBACK_ITPM = 50000`.
- [x] **2.** Request body refactor: `system: string` → `SystemBlock[]` with `cache_control`. Helpers added: `SystemBlock`, `lastSystemBlocks`. `streamRequest` signature updated.
- [x] **3.** Pinned-context state in `context.workspaceState`. `pinnedHashes: Set<string>` loaded in `activate()`, `pinChanged` message handler persists. FNV-1a 32-bit hash via `fnv1aHash`. `decoratePin()` helper used at all 3 extension-side context-creation sites.
- [x] **4.** 📌 toggle UI on context items. CSS classes `.ctx-item-pin`, `.ctx-item.pinned`, `.ctx-item-pin.pinned`. Webview `togglePin()` posts `pinChanged`. Mirror `fnv1aHashJs()` in webview for response captures. `addContext()` auto-fills hash if missing. Send payload now includes `hash` and `pinned`. `callLLM()` splits contexts: pinned → cached system blocks (breakpoint #2), unpinned → user message.
- [x] **5.** Capture `usage.cache_*` (`message_start.usage`, `message_delta.usage`) and `anthropic-ratelimit-input-tokens-limit` header in `streamRequest`. Computes USD cost from `MODELS[i].pricing`, accumulates into `sessionCostUsd`, posts `{usage, costUsd, sessionCostUsd}` in `responseEnd` / `maxTokensReached`. New `updateItpm` message pushed when header changes.
- [x] **6.** Cache + cost footer rendered under each assistant reply. `buildCostFooter()` and `fmtNum`/`fmtCost` helpers in webview. `finalizeStreamingMessage(wrapper, body, rawText, usage, costUsd)` accepts the new args; both call sites (responseEnd and Done button) pass them through. Continue button intentionally does **not** finalize — it re-enters streaming.
- [ ] **7.** Pre-send token+cost estimate in preview panel **with color-coding** (steps 7+8 merged here). *Touch points: `renderPreview()` in webview script. Sum chars/4 across system + active preset + pinned + unpinned + prompt. Multiply by pricing of the active model. Show `~12,400 tok · ~$0.012`. Color-code: yellow ≥60%, red ≥85% input vs `observedItpm`; yellow ≥60%, red ≥90% `sessionCostUsd` vs `sessionCostSoftLimit`. Render `COST_DISCLAIMER` (already declared) one line below the estimate.* **Snag**: webview only knows `currentModelLabel` (via `setModel`/`modelChanged`), not the model **id**. Easiest fix: include id in those messages, OR look up by label since labels are unique in `MODELS`.
- [ ] **8.** `interfacer.sessionCostSoftLimit` setting + Settings UI. *`package.json` → `contributes.configuration.properties`, type `number`, default `1.0`, description "USD soft cap on cumulative session cost — controls when the cost indicator turns yellow/red. Estimates only; never blocks a send." Add to `readSettings()` + `InterfacerSettings`, push via `sendSettings()`. Add a Reset/Save row in Settings → Limits next to Max Output Tokens. Wire `saveSessionCostSoftLimit` message handler. Don't forget the CLAUDE.md INVARIANT.*
- [ ] **9.** Update info view + CLAUDE.md note. *Add a "Prompt Caching" section to the info view documenting the cache mechanics summary from TOKEN_EFFICIENCY_PLAN.md (the table). One-line note that pinned context is per-workspace. Cost disclaimer in the Settings section. Mention the new 📌 toggle in the **Context** subsection. CLAUDE.md ⚠ CHECKLIST table doesn't strictly need an update (items #6 + #9 cover this) — but add: "**Pinned context state**: stored in `context.workspaceState`, keyed by FNV-1a content hash. Per-workspace; never global. Settings (system prompt, presets) remain global."*
- [ ] **10.** `npm run compile` passes (already verified at step 6 boundary); manually verify cache hits on second send within 5 min.

---

## Notes / gotchas

- Pricing constants in `MODELS` are **best-guess** as of 2026-04-25 (Haiku $1/$5, Sonnet $3/$15, Opus $15/$75 per MTok). Real Anthropic pricing may differ; the UI disclaimer (`COST_DISCLAIMER`, already declared in webview script) covers this.
- The existing manual Continue button at extension.ts (`continueGeneration`) stays unchanged in Tier 1. Tier 2C will rework it into auto-chunking.
- `lastConversation` is overwritten per send (single-shot model). Don't add multi-turn here — out of scope.
- ContextItem `id` is webview-only (per-session). The `hash` field is what persists across sessions for pin matching.
- Webview-side `sessionCostSoftLimit` defaults to 1.0 in the script body but is currently never updated by the extension. The `updateSettings` handler is wired to receive it; the extension's `sendSettings()` doesn't push it yet — step 8 closes the loop.
- `MODELS` passed to webview includes only `{id, label, pricing, cacheMinTokens}` (deliberately omits `description`). Constant declared as `jsModels` in TS.
- Cache breakpoint #3 (end of user message, for Tier 2C chunked streaming) is **not** placed yet. Currently only #1 (system+preset) and #2 (pinned context). Add #3 only when implementing Tier 2C.
- `responseEnd` and `maxTokensReached` payloads now carry `{usage, costUsd, sessionCostUsd}`. Anything that posts these (today only the streamRequest emitDone path) must include them; if you add a new terminal path, mirror the shape.

## Verifying step 10 (cache-read sanity check)

1. F5 to launch Extension Development Host.
2. Set a non-trivial system prompt (≥ 2048 chars for Haiku — try pasting a few paragraphs).
3. Send any short message twice within 5 minutes.
4. Second message's footer should show `📦 NNNN cached · NN new` where NNNN > 0.
5. If `cached = 0` on second send, suspect: (a) prefix < model's `cacheMinTokens`, (b) prefix differs byte-for-byte (e.g., timestamp/random in prompt), (c) > 5 min between sends.
