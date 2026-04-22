import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';

const SYSTEM_PROMPT =
	'You are a code analysis assistant. ' +
	'Only analyze the provided context — do not assume missing code. ' +
	'Be concise and direct. ' +
	'Do not rewrite entire files unless explicitly asked. ' +
	'Do not suggest changes outside the provided scope.';

const MODELS: { id: string; label: string; description: string }[] = [
	{ id: 'claude-haiku-4-5-20251001', label: 'Haiku',  description: 'Fast · cheapest' },
	{ id: 'claude-sonnet-4-6',         label: 'Sonnet', description: 'Balanced' },
	{ id: 'claude-opus-4-7',           label: 'Opus',   description: 'Most capable · most expensive' },
];

const SECRET_KEY = 'interfacer.apiKey';

let secrets: vscode.SecretStorage;
let statusBarItem: vscode.StatusBarItem;
let provider: InterfacerViewProvider;

// ─── Sidebar view provider ────────────────────────────────────────────────────

class InterfacerViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'interfacer.chatView';
	private _view?: vscode.WebviewView;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_ctx: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = buildWebviewHtml();

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'send': {
					const text = await callLLM(
						msg.prompt as string,
						msg.contexts as ContextItem[]
					);
					this.post({ type: 'response', text });
					break;
				}
				case 'getSelection':
					await injectSelectionContext();
					break;
				case 'pickFile':
					await injectFileContext();
					break;
				case 'listOpenFiles':
					await vscode.commands.executeCommand('interfacer.addOpenFiles');
					break;
				case 'setApiKey':
					await vscode.commands.executeCommand('interfacer.setApiKey');
					break;
				case 'selectModel':
					await vscode.commands.executeCommand('interfacer.selectModel');
					break;
			}
		}, null, this.context.subscriptions);
	}

	post(msg: object) { this._view?.webview.postMessage(msg); }

	focus() { vscode.commands.executeCommand('interfacer.chatView.focus'); }
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
	secrets = context.secrets;

	provider = new InterfacerViewProvider(context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			InterfacerViewProvider.viewType,
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.command = 'interfacer.selectModel';
	statusBarItem.tooltip = 'Interfacer: click to switch model';
	refreshStatusBar();
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('interfacer.model')) { refreshStatusBar(); }
		}),

		vscode.commands.registerCommand('interfacer.openChat', () => {
			provider.focus();
		}),

		vscode.commands.registerCommand('interfacer.askLLM', async () => {
			await injectSelectionContext();
			provider.focus();
		}),

		vscode.commands.registerCommand('interfacer.selectModel', async () => {
			const config = vscode.workspace.getConfiguration('interfacer');
			const current = config.get<string>('model') || MODELS[0].id;
			const items = MODELS.map((m) => ({
				label: m.label,
				description: m.description,
				detail: m.id,
				picked: m.id === current,
			}));
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'Select Claude model',
				title: 'Interfacer — switch model',
			});
			if (picked) {
				const model = MODELS.find((m) => m.label === picked.label)!;
				await config.update('model', model.id, vscode.ConfigurationTarget.Global);
				refreshStatusBar();
				provider.post({ type: 'modelChanged', label: model.label });
			}
		}),

		vscode.commands.registerCommand('interfacer.addOpenFiles', async () => {
			// Collect unique text-file tabs across all tab groups
			const seen = new Set<string>();
			const files: { label: string; uri: vscode.Uri }[] = [];

			for (const group of vscode.window.tabGroups.all) {
				for (const tab of group.tabs) {
					if (!(tab.input instanceof vscode.TabInputText)) { continue; }
					const uri = tab.input.uri;
					const key = uri.toString();
					if (seen.has(key)) { continue; }
					seen.add(key);
					files.push({ label: uri.path.split('/').pop() ?? uri.fsPath, uri });
				}
			}

			if (files.length === 0) {
				vscode.window.showInformationMessage('Interfacer: no text files are currently open.');
				return;
			}

			files.sort((a, b) => a.label.localeCompare(b.label));

			const picked = await vscode.window.showQuickPick(
				files.map((f) => ({ label: f.label, description: f.uri.fsPath, uri: f.uri })),
				{ canPickMany: true, placeHolder: 'Select files to add as context', title: 'Interfacer — add open files' }
			);
			if (!picked || picked.length === 0) { return; }
			for (const item of picked) { await addUriToContext(item.uri); }
			provider.focus();
		}),

		// Called from editor/title/context (right-click on tab) — uri is passed by VS Code
		vscode.commands.registerCommand('interfacer.addActiveFile', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) {
				vscode.window.showWarningMessage('Interfacer: no file to add.');
				return;
			}
			await addUriToContext(target);
			provider.focus();
		}),

		vscode.commands.registerCommand('interfacer.setApiKey', async () => {
			const current = await secrets.get(SECRET_KEY);
			const input = await vscode.window.showInputBox({
				title: 'Interfacer — set Anthropic API key',
				prompt: 'Stored securely in the OS keychain, not in settings.json',
				placeHolder: 'sk-ant-...',
				value: current ?? '',
				password: true,
				ignoreFocusOut: true,
			});
			if (input === undefined) { return; }
			if (input === '') {
				await secrets.delete(SECRET_KEY);
				vscode.window.showInformationMessage('Interfacer: API key cleared.');
			} else {
				await secrets.store(SECRET_KEY, input);
				vscode.window.showInformationMessage('Interfacer: API key saved to keychain.');
			}
		})
	);
}

// ─── Context helpers ──────────────────────────────────────────────────────────

interface ContextItem {
	label: string;
	content: string;
	kind: 'file' | 'selection';
	lineStart: number;
	lineEnd: number;
}

async function injectSelectionContext() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('Interfacer: no active editor.');
		return;
	}

	const config = vscode.workspace.getConfiguration('interfacer');
	const maxChars = config.get<number>('maxContextChars') ?? 40000;

	const sel = editor.selection;
	const isWholeFile = sel.isEmpty;
	let text = isWholeFile ? editor.document.getText() : editor.document.getText(sel);

	let truncated = false;
	if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

	const fileName = editor.document.fileName.split(/[/\\]/).pop() ?? 'file';

	if (isWholeFile) {
		const confirm = await vscode.window.showQuickPick(
			['Send whole file', 'Cancel'],
			{ placeHolder: `No selection — send entire ${fileName}?` }
		);
		if (confirm !== 'Send whole file') { return; }
	}

	const lineStart = isWholeFile ? 1 : sel.start.line + 1;
	const lineEnd   = isWholeFile ? editor.document.lineCount : sel.end.line + 1;
	const label     = fileName + (isWholeFile ? '' : ' (selection)') + (truncated ? ' — truncated' : '');

	const item: ContextItem = {
		label, content: text,
		kind: isWholeFile ? 'file' : 'selection',
		lineStart, lineEnd,
	};
	provider.post({ type: 'addContext', item });
}

async function injectFileContext() {
	const uris = await vscode.window.showOpenDialog({
		canSelectMany: true,
		openLabel: 'Add to context',
		title: 'Interfacer — add files as context',
	});
	if (!uris || uris.length === 0) { return; }
	for (const uri of uris) { await addUriToContext(uri); }
}

async function addUriToContext(uri: vscode.Uri) {
	const config = vscode.workspace.getConfiguration('interfacer');
	const maxChars = config.get<number>('maxContextChars') ?? 40000;

	const bytes = await vscode.workspace.fs.readFile(uri);
	let text = Buffer.from(bytes).toString('utf8');
	let truncated = false;
	if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

	const fileName = uri.path.split('/').pop() ?? 'file';
	const lineCount = text.split('\n').length;
	provider.post({
		type: 'addContext',
		item: {
			label: fileName + (truncated ? ' — truncated' : ''),
			content: text,
			kind: 'file',
			lineStart: 1,
			lineEnd: lineCount,
		} satisfies ContextItem,
	});
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM(prompt: string, contexts: ContextItem[]): Promise<string> {
	const config = vscode.workspace.getConfiguration('interfacer');
	const apiKey =
		(await secrets.get(SECRET_KEY)) ||
		config.get<string>('apiKey') ||
		process.env.ANTHROPIC_API_KEY ||
		'';
	const model = config.get<string>('model') || MODELS[0].id;

	if (!apiKey) {
		return (
			'No API key configured.\n' +
			'Click 🔑 or run the command Interfacer: Set API Key.'
		);
	}

	let userContent = '';
	if (contexts.length > 0) {
		userContent = contexts
			.map((c) => `### ${c.label}\n\`\`\`\n${c.content}\n\`\`\``)
			.join('\n\n') + '\n\n';
	}
	userContent += prompt;

	const body = JSON.stringify({
		model,
		max_tokens: 1024,
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content: userContent }],
	});

	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname: 'api.anthropic.com',
				path: '/v1/messages',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'Content-Length': Buffer.byteLength(body),
				},
			},
			(res) => {
				let raw = '';
				res.on('data', (chunk) => { raw += chunk; });
				res.on('end', () => {
					try {
						const parsed = JSON.parse(raw);
						if (parsed.content?.[0]?.text) {
							resolve(parsed.content[0].text as string);
						} else if (parsed.error) {
							resolve(`API error: ${parsed.error.message}`);
						} else {
							resolve('Unexpected response:\n' + raw.slice(0, 300));
						}
					} catch {
						resolve('Failed to parse API response:\n' + raw.slice(0, 300));
					}
				});
			}
		);
		req.on('error', (e: Error) => resolve(`Request failed: ${e.message}`));
		req.write(body);
		req.end();
	});
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function refreshStatusBar() {
	const config = vscode.workspace.getConfiguration('interfacer');
	const modelId = config.get<string>('model') || MODELS[0].id;
	const match = MODELS.find((m) => m.id === modelId);
	statusBarItem.text = `$(hubot) ${match?.label ?? 'Interfacer'}`;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function buildWebviewHtml(): string {
	const nonce = crypto.randomBytes(16).toString('hex');
	// Embed the system prompt so the preview is always accurate
	const escapedSystemPrompt = SYSTEM_PROMPT.replace(/`/g, '\\`');

	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Interfacer</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }

  /* ── toolbar ── */
  #toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 8px;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 2px;
    font-family: inherit;
    font-size: 0.85em;
    white-space: nowrap;
    line-height: 1.4;
  }
  .tool-btn.primary  { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tool-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .tool-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tool-btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tool-btn.ghost { background: transparent; color: var(--vscode-descriptionForeground); }
  .tool-btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tool-btn:disabled { opacity: 0.45; cursor: default; }

  .tb-spacer { flex: 1; }

  /* ── log ── */
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .msg { white-space: pre-wrap; word-break: break-word; padding: 6px 10px; border-radius: 3px; line-height: 1.5; }
  .msg-label { font-size: 0.72em; opacity: 0.5; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
  .msg.user      { background: var(--vscode-input-background); border-left: 2px solid var(--vscode-focusBorder); }
  .msg.assistant { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 2px solid var(--vscode-textLink-foreground); }

  /* ── input area ── */
  #input-area {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--vscode-widget-border, #444);
  }

  /* context list */
  #ctx-header {
    display: none;
    align-items: center;
    gap: 4px;
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    padding-bottom: 2px;
  }
  #ctx-header.visible { display: flex; }
  #ctx-header-label { flex: 1; font-weight: 600; }

  #ctx-list { display: flex; flex-direction: column; gap: 2px; }

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px 6px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 2px;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }
  .ctx-item-icon { flex-shrink: 0; }
  .ctx-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-item-meta { flex-shrink: 0; opacity: 0.6; font-size: 0.9em; }
  .ctx-item-rm {
    flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 0 2px;
    color: var(--vscode-descriptionForeground); opacity: 0.6; font-size: 1em; line-height: 1;
  }
  .ctx-item-rm:hover { opacity: 1; }

  /* preview */
  #preview-wrap { border-top: 1px solid var(--vscode-widget-border, #333); margin-top: 2px; }

  #btn-preview {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 4px 6px;
    font-family: inherit;
    font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }
  #btn-preview:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

  #preview-panel {
    display: none;
    flex-direction: column;
    gap: 0;
    font-size: 0.78em;
    background: var(--vscode-textBlockQuote-background, var(--vscode-editor-inactiveSelectionBackground));
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 2px;
  }
  #preview-panel.open { display: flex; }

  .pv-section {
    padding: 5px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
  }
  .pv-section:last-child { border-bottom: none; }
  .pv-section-label {
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.5;
    margin-bottom: 3px;
  }
  .pv-text {
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.8;
    line-height: 1.4;
    max-height: 60px;
    overflow: hidden;
  }
  .pv-ctx-row { display: flex; align-items: center; gap: 5px; padding: 1px 0; opacity: 0.85; }
  .pv-ctx-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv-ctx-row-meta { flex-shrink: 0; opacity: 0.6; }
  #pv-stats { padding: 4px 8px; font-size: 0.85em; opacity: 0.55; text-align: right; }
  #pv-empty-note { padding: 5px 8px; opacity: 0.5; font-style: italic; }

  /* prompt */
  #prompt {
    resize: vertical;
    min-height: 60px;
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555);
    border-radius: 2px;
    padding: 5px 6px;
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
  }
  #prompt:focus { outline: 1px solid var(--vscode-focusBorder); }

  #send-row { display: flex; align-items: center; gap: 4px; }
  #status    { font-size: 0.78em; opacity: 0.5; margin-left: 4px; }
  #model-label { font-size: 0.72em; opacity: 0.4; margin-left: auto; padding-right: 2px; }
  #hint { font-size: 0.72em; opacity: 0.35; text-align: right; padding-top: 1px; }

  /* ── info view ── */
  #info-view { font-size: 0.85em; line-height: 1.5; }
  .iv-section { display: flex; flex-direction: column; gap: 3px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  .iv-section:last-child { border-bottom: none; }
  .iv-title { font-size: 1.1em; font-weight: 700; margin-bottom: 2px; }
  .iv-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.5; font-weight: 600; margin-bottom: 2px; }
  .iv-hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .iv-desc { opacity: 0.75; }
  .iv-row { display: flex; gap: 8px; padding: 2px 0; }
  .iv-key {
    flex-shrink: 0; width: 46%;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
    color: var(--vscode-textLink-foreground);
    word-break: break-word;
  }
  .iv-val { flex: 1; opacity: 0.8; }
  .iv-val code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 0 3px;
    border-radius: 2px;
  }
  .iv-system-prompt {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15));
    padding: 6px 8px;
    border-radius: 3px;
    opacity: 0.85;
  }
  #btn-info.active { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>

<!-- toolbar -->
<div id="toolbar">
  <button class="tool-btn secondary" id="btn-selection" title="Attach current editor selection (or whole file)">✂ Add Selection</button>
  <button class="tool-btn secondary" id="btn-open"      title="Choose from currently open files">📋 Open Files</button>
  <button class="tool-btn secondary" id="btn-file"      title="Pick one or more files from disk">📂 Browse…</button>
  <div class="tb-spacer"></div>
  <button class="tool-btn ghost" id="btn-model"  title="Switch model"></button>
  <button class="tool-btn ghost" id="btn-apikey" title="Set API key">🔑</button>
  <button class="tool-btn ghost" id="btn-clrlog" title="Clear conversation log">🗑</button>
  <button class="tool-btn ghost" id="btn-info"   title="Extension info / help">ℹ</button>
</div>

<!-- ── info view (toggled by ℹ button) ── -->
<div id="info-view" style="display:none;flex:1;overflow-y:auto;padding:10px 12px;flex-direction:column;gap:16px;">

  <div class="iv-section">
    <div class="iv-title">Interfacer</div>
    <div class="iv-desc">A user-controlled LLM analysis panel. Every request is explicitly triggered — no background scanning, no autonomous edits.</div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Commands <span class="iv-hint">(Ctrl+Shift+P)</span></div>
    <div class="iv-row"><span class="iv-key">Interfacer: Open Chat Panel</span><span class="iv-val">Focus the sidebar panel</span></div>
    <div class="iv-row"><span class="iv-key">Interfacer: Send Selection to LLM</span><span class="iv-val">Attach current selection (or whole file with confirmation) and focus panel</span></div>
    <div class="iv-row"><span class="iv-key">Interfacer: Add Open File(s) to Context</span><span class="iv-val">Multi-select QuickPick of all currently open text files</span></div>
    <div class="iv-row"><span class="iv-key">Interfacer: Switch Model</span><span class="iv-val">Choose between Haiku, Sonnet, and Opus</span></div>
    <div class="iv-row"><span class="iv-key">Interfacer: Set API Key</span><span class="iv-val">Store Anthropic API key in the OS keychain (never written to settings.json)</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Keyboard Shortcuts</div>
    <div class="iv-row"><span class="iv-key">Ctrl+Shift+I</span><span class="iv-val">Send selection to LLM (editor must be focused)</span></div>
    <div class="iv-row"><span class="iv-key">Ctrl+Enter</span><span class="iv-val">Send message (chat textarea must be focused)</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Toolbar Buttons</div>
    <div class="iv-row"><span class="iv-key">✂ Add Selection</span><span class="iv-val">Attach the active editor's selection. If nothing is selected, prompts to send the whole file.</span></div>
    <div class="iv-row"><span class="iv-key">📋 Open Files</span><span class="iv-val">Multi-select QuickPick of all open tabs, sorted A–Z. Files open in multiple split groups appear once.</span></div>
    <div class="iv-row"><span class="iv-key">📂 Browse…</span><span class="iv-val">OS file picker — add files not currently open. Supports multi-select.</span></div>
    <div class="iv-row"><span class="iv-key">⊙ [Model]</span><span class="iv-val">Open model switcher QuickPick. Also clickable in the status bar (bottom-right).</span></div>
    <div class="iv-row"><span class="iv-key">🔑</span><span class="iv-val">Set or update the Anthropic API key.</span></div>
    <div class="iv-row"><span class="iv-key">🗑</span><span class="iv-val">Clear the conversation log for this session. Does not affect the API.</span></div>
    <div class="iv-row"><span class="iv-key">ℹ</span><span class="iv-val">Toggle this info view.</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Editor Menus</div>
    <div class="iv-row"><span class="iv-key">Right-click selected text</span><span class="iv-val">"Interfacer: Send Selection to LLM" — visible only when text is selected</span></div>
    <div class="iv-row"><span class="iv-key">Right-click on a tab</span><span class="iv-val">"Add to Interfacer Context" — adds that file directly, no picker needed</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Context System</div>
    <div class="iv-desc">Context items are additive — each "Add" call appends to the list. Nothing is sent implicitly.</div>
    <div class="iv-row"><span class="iv-key">📄 file icon</span><span class="iv-val">Whole file — shows total line count</span></div>
    <div class="iv-row"><span class="iv-key">✂ scissors icon</span><span class="iv-val">Selection — shows "lines N–M (X lines)"</span></div>
    <div class="iv-row"><span class="iv-key">✕ per item</span><span class="iv-val">Remove that item from context</span></div>
    <div class="iv-row"><span class="iv-key">Clear all</span><span class="iv-val">Remove all attached context at once</span></div>
    <div class="iv-row"><span class="iv-key">Truncation</span><span class="iv-val">Files exceeding <code>interfacer.maxContextChars</code> (default 40,000) are cut and labelled "— truncated"</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Payload Preview</div>
    <div class="iv-desc">Click "▶ Preview full payload" above the textarea to expand a live view of exactly what will be sent.</div>
    <div class="iv-row"><span class="iv-key">System prompt</span><span class="iv-val">The fixed instruction block prepended to every request</span></div>
    <div class="iv-row"><span class="iv-key">Context items</span><span class="iv-val">Each attached file/selection with its line range</span></div>
    <div class="iv-row"><span class="iv-key">Your prompt</span><span class="iv-val">Live echo of what you're typing</span></div>
    <div class="iv-row"><span class="iv-key">Stats line</span><span class="iv-val">Total chars and estimated tokens (chars ÷ 4)</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">Models</div>
    <div class="iv-row"><span class="iv-key">Haiku</span><span class="iv-val"><code>claude-haiku-4-5-20251001</code> — fastest, cheapest. Default.</span></div>
    <div class="iv-row"><span class="iv-key">Sonnet</span><span class="iv-val"><code>claude-sonnet-4-6</code> — balanced capability and cost</span></div>
    <div class="iv-row"><span class="iv-key">Opus</span><span class="iv-val"><code>claude-opus-4-7</code> — most capable, most expensive</span></div>
    <div class="iv-desc" style="margin-top:4px;">Selection is saved globally (all projects). Visible in the status bar bottom-right.</div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">API Key &amp; Settings</div>
    <div class="iv-row"><span class="iv-key">OS keychain</span><span class="iv-val">Preferred. Set via 🔑 button. Stored by VS Code in libsecret / GNOME Keyring.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.apiKey</span><span class="iv-val">VS Code setting fallback. Plaintext — not recommended for production keys.</span></div>
    <div class="iv-row"><span class="iv-key">ANTHROPIC_API_KEY</span><span class="iv-val">Environment variable fallback. Checked last.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.model</span><span class="iv-val">Persisted model ID. Updated automatically by the model switcher.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.maxContextChars</span><span class="iv-val">Per-file character cap before truncation. Default: 40,000.</span></div>
  </div>

  <div class="iv-section">
    <div class="iv-heading">System Prompt (sent with every request)</div>
    <div class="iv-system-prompt" id="iv-system-prompt-text"></div>
  </div>

</div>

<!-- chat view -->
<div id="chat-view" style="display:flex;flex:1;flex-direction:column;overflow:hidden;">

<!-- log -->
<div id="log"></div>

<!-- input area -->
<div id="input-area">

  <!-- context list -->
  <div id="ctx-header">
    <span id="ctx-header-label">Context</span>
    <button class="tool-btn ghost" style="font-size:0.85em;padding:1px 5px;" id="btn-clr-all-ctx" title="Remove all context">Clear all</button>
  </div>
  <div id="ctx-list"></div>

  <!-- preview -->
  <div id="preview-wrap">
    <button id="btn-preview">▶ Preview full payload</button>
    <div id="preview-panel">
      <div class="pv-section">
        <div class="pv-section-label">System prompt</div>
        <div class="pv-text" id="pv-system"></div>
      </div>
      <div class="pv-section" id="pv-ctx-section">
        <div class="pv-section-label">Context items</div>
        <div id="pv-ctx-rows"></div>
        <div id="pv-empty-note">No context attached.</div>
      </div>
      <div class="pv-section">
        <div class="pv-section-label">Your prompt</div>
        <div class="pv-text" id="pv-prompt-echo">[type below]</div>
      </div>
      <div id="pv-stats"></div>
    </div>
  </div>

  <textarea id="prompt" placeholder="Ask about the code…" rows="3"></textarea>

  <div id="send-row">
    <button class="tool-btn primary" id="btn-send">Send</button>
    <span id="status"></span>
    <span id="model-label"></span>
  </div>
  <div id="hint">Ctrl+Enter to send</div>
</div>

</div> <!-- end #chat-view -->

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  const logEl        = document.getElementById('log');
  const promptEl     = document.getElementById('prompt');
  const statusEl     = document.getElementById('status');
  const modelLabel   = document.getElementById('model-label');
  const ctxHeader    = document.getElementById('ctx-header');
  const ctxList      = document.getElementById('ctx-list');
  const btnSend      = document.getElementById('btn-send');
  const btnSelection = document.getElementById('btn-selection');
  const btnOpen      = document.getElementById('btn-open');
  const btnFile      = document.getElementById('btn-file');
  const btnModel     = document.getElementById('btn-model');
  const btnApiKey    = document.getElementById('btn-apikey');
  const btnClrLog    = document.getElementById('btn-clrlog');
  const btnInfo      = document.getElementById('btn-info');
  const btnClrAllCtx = document.getElementById('btn-clr-all-ctx');
  const btnPreview   = document.getElementById('btn-preview');
  const previewPanel = document.getElementById('preview-panel');
  const infoView     = document.getElementById('info-view');
  const chatView     = document.getElementById('chat-view');
  const pvSystem     = document.getElementById('pv-system');
  const pvCtxRows    = document.getElementById('pv-ctx-rows');
  const pvEmptyNote  = document.getElementById('pv-empty-note');
  const pvPromptEcho = document.getElementById('pv-prompt-echo');
  const pvStats      = document.getElementById('pv-stats');

  const SYSTEM_PROMPT = \`${escapedSystemPrompt}\`;

  // populate the system prompt display in the info view
  document.getElementById('iv-system-prompt-text').textContent = SYSTEM_PROMPT;

  let infoOpen = false;
  let contexts = [];   // { id, label, content, kind, lineStart, lineEnd }
  let nextId   = 0;
  let waiting  = false;
  let previewOpen = false;

  pvSystem.textContent = SYSTEM_PROMPT;

  // ── model label ──────────────────────────────────────────────────────────
  function setModel(label) {
    btnModel.textContent = '⊙ ' + label;
    modelLabel.textContent = label;
  }
  setModel('Haiku');

  // ── context list ─────────────────────────────────────────────────────────
  function addContext(item) {
    const id = nextId++;
    contexts.push({ id, ...item });
    renderCtxList();
    updatePreview();
  }

  function removeContext(id) {
    contexts = contexts.filter((c) => c.id !== id);
    renderCtxList();
    updatePreview();
  }

  function clearAllContexts() {
    contexts = [];
    renderCtxList();
    updatePreview();
  }

  function renderCtxList() {
    ctxList.innerHTML = '';
    const visible = contexts.length > 0;
    ctxHeader.classList.toggle('visible', visible);

    contexts.forEach((c) => {
      const lineCount = c.lineEnd - c.lineStart + 1;
      const metaText  = c.kind === 'selection'
        ? \`lines \${c.lineStart}–\${c.lineEnd} (\${lineCount} lines)\`
        : \`\${lineCount} lines\`;

      const row = document.createElement('div');
      row.className = 'ctx-item';
      row.innerHTML =
        \`<span class="ctx-item-icon">\${c.kind === 'selection' ? '✂' : '📄'}</span>\` +
        \`<span class="ctx-item-name" title="\${c.label}">\${c.label}</span>\` +
        \`<span class="ctx-item-meta">\${metaText}</span>\` +
        \`<button class="ctx-item-rm" title="Remove">✕</button>\`;
      row.querySelector('.ctx-item-rm').addEventListener('click', () => removeContext(c.id));
      ctxList.appendChild(row);
    });
  }

  // ── preview ──────────────────────────────────────────────────────────────
  function updatePreview() {
    if (!previewOpen) { return; }
    renderPreview();
  }

  function renderPreview() {
    // context rows
    pvCtxRows.innerHTML = '';
    pvEmptyNote.style.display = contexts.length === 0 ? 'block' : 'none';
    contexts.forEach((c) => {
      const lineCount = c.lineEnd - c.lineStart + 1;
      const meta = c.kind === 'selection'
        ? \`lines \${c.lineStart}–\${c.lineEnd} (\${lineCount})\`
        : \`\${lineCount} lines\`;
      const row = document.createElement('div');
      row.className = 'pv-ctx-row';
      row.innerHTML =
        \`<span>\${c.kind === 'selection' ? '✂' : '📄'}</span>\` +
        \`<span class="pv-ctx-row-name" title="\${c.label}">\${c.label}</span>\` +
        \`<span class="pv-ctx-row-meta">\${meta}</span>\`;
      pvCtxRows.appendChild(row);
    });

    // prompt echo
    const promptText = promptEl.value.trim();
    pvPromptEcho.textContent = promptText || '[type below]';

    // stats
    const ctxChars  = contexts.reduce((s, c) => s + c.content.length, 0);
    const totalChars = SYSTEM_PROMPT.length + ctxChars + promptText.length;
    const estTokens  = Math.ceil(totalChars / 4);
    pvStats.textContent =
      \`~\${totalChars.toLocaleString()} chars · ~\${estTokens.toLocaleString()} tokens est.\`;
  }

  btnPreview.addEventListener('click', () => {
    previewOpen = !previewOpen;
    previewPanel.classList.toggle('open', previewOpen);
    btnPreview.textContent = (previewOpen ? '▼' : '▶') + ' Preview full payload';
    if (previewOpen) { renderPreview(); }
  });

  // keep prompt echo live when preview is open
  promptEl.addEventListener('input', () => {
    if (previewOpen) { renderPreview(); }
  });

  // ── send ─────────────────────────────────────────────────────────────────
  function send() {
    if (waiting) { return; }
    const prompt = promptEl.value.trim();
    if (!prompt) { return; }

    const snapshot = contexts.slice();
    const ctxSummary = snapshot.length > 0
      ? snapshot.map((c) => c.label).join(', ')
      : null;

    addMessage('user', prompt, ctxSummary);
    promptEl.value = '';
    clearAllContexts();
    if (previewOpen) { renderPreview(); }

    waiting = true;
    btnSend.disabled = true;
    statusEl.textContent = 'Waiting…';

    vscode.postMessage({
      type: 'send',
      prompt,
      contexts: snapshot.map(({ label, content, kind, lineStart, lineEnd }) =>
        ({ label, content, kind, lineStart, lineEnd })
      ),
    });
  }

  // ── log ──────────────────────────────────────────────────────────────────
  function addMessage(role, text, ctxSummary) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg ' + role;

    const lbl = document.createElement('div');
    lbl.className = 'msg-label';
    lbl.textContent = (role === 'user' ? 'You' : 'Assistant') + (ctxSummary ? ' · ' + ctxSummary : '');
    wrapper.appendChild(lbl);

    const body = document.createElement('div');
    body.textContent = text;
    wrapper.appendChild(body);

    logEl.appendChild(wrapper);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ── events ───────────────────────────────────────────────────────────────
  btnSend.addEventListener('click', send);
  btnSelection.addEventListener('click', () => vscode.postMessage({ type: 'getSelection' }));
  btnOpen.addEventListener('click',      () => vscode.postMessage({ type: 'listOpenFiles' }));
  btnFile.addEventListener('click',      () => vscode.postMessage({ type: 'pickFile' }));
  btnModel.addEventListener('click',     () => vscode.postMessage({ type: 'selectModel' }));
  btnApiKey.addEventListener('click',    () => vscode.postMessage({ type: 'setApiKey' }));
  btnClrLog.addEventListener('click',    () => { logEl.innerHTML = ''; });
  btnInfo.addEventListener('click', () => {
    infoOpen = !infoOpen;
    infoView.style.display  = infoOpen ? 'flex' : 'none';
    chatView.style.display  = infoOpen ? 'none' : 'flex';
    btnInfo.classList.toggle('active', infoOpen);
  });
  btnClrAllCtx.addEventListener('click', clearAllContexts);

  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  // ── messages from extension ──────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'response') {
      waiting = false;
      btnSend.disabled = false;
      statusEl.textContent = '';
      addMessage('assistant', msg.text, null);
    } else if (msg.type === 'addContext') {
      addContext(msg.item);
    } else if (msg.type === 'modelChanged') {
      setModel(msg.label);
    }
  });
</script>
</body>
</html>`;
}

export function deactivate() {}
