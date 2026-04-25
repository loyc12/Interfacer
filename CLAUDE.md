# Interfacer — Contributor Guide

## ⚠ READ FIRST: Resume any in-flight work

If [WORK_IN_PROGRESS.md](.claude/WORK_IN_PROGRESS.md) exists at the repo root, **read it before doing anything else**. It is the live handoff from a previous session — it names the active feature, points at the relevant plan in `*_PLAN.md` (or `DevPlans for Interfacer.txt`), lists the ordered task checklist with completion status, and flags any partial-state hazards.

While you work on a multi-step task:
- Update `WORK_IN_PROGRESS.md` after each completed step (check the box, update **Last touched**).
- Add gotchas / decisions to the **Notes** section as you discover them.
- Keep it short — it's a handoff document, not a journal. If a section is no longer load-bearing, trim it.

When the work is fully merged / the user confirms it's done, **delete** `WORK_IN_PROGRESS.md`. A stale WIP file is worse than none.

## ⚠ CHECKLIST: Update these on every feature change

When you add, remove, or rename **any** user-facing feature, go through this list before closing the PR / ending the session. Skipping items will cause the in-extension help to drift from reality.

|  # | What changed? | What to update |
|----|---------------|----------------|
|  1 | New command registered in `activate()` | Add to `package.json` → `contributes.commands` |
|  2 | New command | Add entry to the **Commands** section of the info view in `buildWebviewHtml()` |
|  3 | New keyboard shortcut | Add to `package.json` → `contributes.keybindings` AND to **Keyboard Shortcuts** in info view |
|  4 | New toolbar button in the webview | Add to **Toolbar Buttons** in info view |
|  5 | New context menu entry (`editor/context`, `editor/title/context`, etc.) | Add to `package.json` → `contributes.menus` AND to **Editor Menus** in info view |
|  6 | New VS Code setting | Add to `package.json` → `contributes.configuration.properties` AND to **Settings** in info view |
|  7 | Change to the system prompt | Update **System Prompt** section in info view |
|  8 | New model added to `MODELS[]` | Update **Models** section in info view |
|  9 | Behaviour change to an existing feature | Update the relevant description in the info view |
| 10 | New or changed preset | Update `DEFAULT_PRESETS` array if it's a shipped default; remind user in CHANGELOG |
| 11 | System prompt default changed | Update `DEFAULT_SYSTEM_PROMPT` constant AND the reset button target in `svResetPrompt` listener |
| 12 | Any of the above | Re-read the full info view to check for stale text |

The info view lives entirely inside `buildWebviewHtml()` in [src/extension.ts](src/extension.ts),
in the `<div id="info-view">` block. It is plain HTML — edit it directly.

## ⚠ INVARIANT: Every setting must be both a VS Code setting AND have a UI entry point

Every user-configurable value **must** satisfy both of the following, without exception:

1. **Registered in `package.json` → `contributes.configuration.properties`** with a type, default, and description. This makes it discoverable in the VS Code settings UI, persistable in `settings.json`, and readable via `vscode.workspace.getConfiguration()`.

2. **Editable from within the extension's own UI** — either through the ⚙ Settings panel (preferred for free-form values), a dedicated command/button (e.g. model switcher via status bar, API key via 🔑), or a QuickPick. Users should never need to open `settings.json` to configure Interfacer.

When adding a new configurable value: add the `package.json` entry first, then add the panel UI, then wire `sendSettings()` and `updateSettings` so the panel stays in sync when the value is changed externally (e.g. via settings.json).

---

## Architecture

```
src/extension.ts          — everything: activation, commands, API client, webview HTML
media/icon.svg            — activity bar icon (monochrome SVG)
package.json              — manifest: commands, menus, keybindings, settings, views
CLAUDE.md                 — this file
.claude/*                 - other claude.relevant files or info
```

**No bundler. No framework.** TypeScript compiles directly to `out/extension.js` via `tsc`.
The webview is a self-contained HTML string returned by `buildWebviewHtml()` with an inline
`<script nonce="...">` block. All CSS is inline `<style>`. No external resources.

## ⚠ Webview script gotchas — read before editing the `<script>` block

The entire webview is built as a TypeScript template literal. **The `<script>` body is
plain text inside that template literal** — it is not source code from `tsc`'s perspective,
so `tsc` cannot catch syntax errors in it. Worse, the template literal silently transforms
some characters at runtime, which has caused multiple total-UI freezes:

- **`\n`, `\t`, `\r`, `\b`, `\f`, `\v`, `\0`** in the template become real control chars.
  A `// "\n\n" join` comment becomes a comment terminated at the `"`, then a literal newline,
  then dangling text — unterminated string, parse error, dead webview.
- **`\X` for any other letter (`\d`, `\w`, `\s`, `\*`, `\.`, `\[`, `\]`, `\(`, `\)`, …)**
  is a "NonEscapeCharacter": the backslash is **silently dropped**, leaving just `X`. So
  `/\*\*\*(.+?)\*\*\*/g` becomes `/***(.+?)***/g` at runtime — invalid regex, parse error,
  dead webview.

**The rule:** inside the `<script>` block of `buildWebviewHtml()`, every backslash you
write in source must be `\\`. Doubled. Always. Yes, even in regex literals. Yes, even in
comments. Yes, even when it "looks fine."

| You want at runtime              | Write in source              |
|----------------------------------|------------------------------|
| `\n` (newline char)              | `'\\n'`                      |
| `\d+` (regex digit)              | `/\\d+/`                     |
| `\*\*` (literal asterisks)       | `/\\*\\*/`                   |
| `\\` (literal backslash)         | `'\\\\'`                     |
| `${expr}` (template interp)      | `\\${expr}` (to suppress)    |
| `` ` `` (literal backtick)       | `` \\` ``                    |

**The safety net:** `npm run compile` runs `scripts/validate-webview.js` after `tsc`. It
extracts the `<script>` body from the generated webview HTML and pipes it through
`node --check`. Any syntax error fails the build with a pointer to this section. Run
manually any time with `npm run check-webview`.

## Markdown rendering

The webview has a small hand-rolled markdown renderer (`renderMarkdown` / `inlineMd` in
`buildWebviewHtml`). It currently handles: headings (h1–h3), paragraphs (with line-break
coalescing), bullet/numbered lists, blockquotes, fenced code, inline code, bold/italic,
inline links (`[text](url)`, http(s)/mailto/anchor/relative URLs only — javascript:/data:
rejected for XSS).

It does **not** handle: tables, nested lists, footnotes, task lists, image refs, setext
headings.

**When to switch to a library** (likely `marked`): if more than one of the above starts
mattering, replace the hand-rolled code rather than extending it. Tables alone justify
the swap. `marked` is dependency-free and works inline as a string — no bundler needed,
just inline the UMD/IIFE at activation time.

## Key invariants

- **No autonomous behaviour.** Every API call is triggered by an explicit user action.
- **No file editing.** The extension is read-only with respect to the workspace.
- **Context is additive and explicit.** Nothing is sent without the user attaching it.
- **Secrets never touch `settings.json`.** API key goes through `context.secrets` (OS keychain).

## Working priority — fix bugs before adding features

Before starting a new feature, check the **TO FIX** section of `DevPlans for Interfacer.txt`.
Resolve any pending bugs first. Shipping new behaviour on top of known-broken behaviour
multiplies the surface area of debugging later, and the "no autonomous behaviour" invariant
above means users immediately notice when something they just clicked misbehaves.

## Build & run

```bash
npm install         # first time only
npm run compile     # tsc → out/, then validate the webview <script>
npm run check-webview # standalone: just re-run the webview validator
# Press F5 in VS Code to launch Extension Development Host
```

## Adding a new Claude model

1. Add `{ id, label, description }` to the `MODELS` array in `extension.ts` ( confirm this is still valid, update if not )
2. Update the **Models** section of the info view in `buildWebviewHtml()`
3. That's it — the QuickPick and status bar pick it up automatically
