# Interfacer

A user-controlled LLM analysis panel for VS Code.  
Send code selections, files, and terminal output to Claude — nothing happens without your explicit action.

## Features

- **Chat panel** docked in the VS Code sidebar
- **Attach context explicitly**: selected text, whole files, open tabs, or terminal output
- **Header presets**: named instruction snippets selectable per-message
- **Customisable system prompt** via the ⚙ Settings view
- **Model switcher**: Haiku / Sonnet / Opus (status bar, one click)
- **Payload preview**: see exactly what will be sent before you hit Send
- **API key stored in OS keychain** — never written to settings.json

## Requirements

- VS Code >= 1.80.0
- An [Anthropic API key](https://console.anthropic.com)

## Setup

1. Install the extension
2. Open the Interfacer panel (robot icon in the activity bar)
3. Click **🔑** and paste your Anthropic API key
4. Select code → **Ctrl+Shift+I** (or right-click → *Interfacer: Send Selection to LLM*)

## Settings

| Setting | Default | Description |
|---|---|---|
| `interfacer.apiKey` | — | Plaintext fallback (prefer the keychain via 🔑) |
| `interfacer.model` | `claude-haiku-4-5-20251001` | Active Claude model |
| `interfacer.systemPrompt` | built-in | Base instruction sent with every request |
| `interfacer.promptPresets` | `[]` | Named header presets (managed in ⚙ Settings) |
| `interfacer.maxContextChars` | `40000` | Per-file character cap before truncation |

## Building from source

```bash
./install.sh               # build + install into VS Code
./install.sh --build-only  # produce interfacer.vsix without installing
./uninstall.sh             # uninstall + clean build artefacts
make help                  # see all Makefile targets
```

Requires **Node.js >= 20**.

## Design principles

- No autonomous behaviour — every API call is user-triggered
- No file editing — read-only with respect to your workspace
- Context is always explicit — nothing is sent without you attaching it
- Secrets never touch `settings.json` — API key lives in the OS keychain
