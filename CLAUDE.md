# Interfacer — Contributor Guide

## ⚠ CHECKLIST: Update these on every feature change

When you add, remove, or rename **any** user-facing feature, go through this list before closing the PR / ending the session. Skipping items will cause the in-extension help to drift from reality.

| # | What changed? | What to update |
|---|---|---|
| 1 | New command registered in `activate()` | Add to `package.json` → `contributes.commands` |
| 2 | New command | Add entry to the **Commands** section of the info view in `buildWebviewHtml()` |
| 3 | New keyboard shortcut | Add to `package.json` → `contributes.keybindings` AND to **Keyboard Shortcuts** in info view |
| 4 | New toolbar button in the webview | Add to **Toolbar Buttons** in info view |
| 5 | New context menu entry (`editor/context`, `editor/title/context`, etc.) | Add to `package.json` → `contributes.menus` AND to **Editor Menus** in info view |
| 6 | New VS Code setting | Add to `package.json` → `contributes.configuration.properties` AND to **Settings** in info view |
| 7 | Change to the system prompt | Update **System Prompt** section in info view |
| 8 | New model added to `MODELS[]` | Update **Models** section in info view |
| 9 | Behaviour change to an existing feature | Update the relevant description in the info view |
| 10 | New or changed preset | Update `DEFAULT_PRESETS` array if it's a shipped default; remind user in CHANGELOG |
| 11 | System prompt default changed | Update `DEFAULT_SYSTEM_PROMPT` constant AND the reset button target in `svResetPrompt` listener |
| 12 | Any of the above | Re-read the full info view to check for stale text |

The info view lives entirely inside `buildWebviewHtml()` in [src/extension.ts](src/extension.ts),
in the `<div id="info-view">` block. It is plain HTML — edit it directly.

---

## Architecture

```
src/extension.ts          — everything: activation, commands, API client, webview HTML
media/icon.svg            — activity bar icon (monochrome SVG)
package.json              — manifest: commands, menus, keybindings, settings, views
CLAUDE.md                 — this file
```

**No bundler. No framework.** TypeScript compiles directly to `out/extension.js` via `tsc`.
The webview is a self-contained HTML string returned by `buildWebviewHtml()` with an inline
`<script nonce="...">` block. All CSS is inline `<style>`. No external resources.

## Key invariants

- **No autonomous behaviour.** Every API call is triggered by an explicit user action.
- **No file editing.** The extension is read-only with respect to the workspace.
- **Context is additive and explicit.** Nothing is sent without the user attaching it.
- **Secrets never touch `settings.json`.** API key goes through `context.secrets` (OS keychain).

## Build & run

```bash
npm install       # first time only
npm run compile   # tsc → out/
# Press F5 in VS Code to launch Extension Development Host
```

## Adding a new Claude model

1. Add `{ id, label, description }` to the `MODELS` array in `extension.ts`
2. Update the **Models** section of the info view in `buildWebviewHtml()`
3. That's it — the QuickPick and status bar pick it up automatically
