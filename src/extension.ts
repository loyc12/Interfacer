import * as vscode from 'vscode';
import * as https from 'https';
import * as crypto from 'crypto';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT =
	'You are a code analysis assistant. ' +
	'Only analyze the provided context — do not assume missing code. ' +
	'Be concise and direct. ' +
	'Do not rewrite entire files unless explicitly asked. ' +
	'Do not suggest changes outside the provided scope.';

const DEFAULT_PRESETS: Preset[] = [
	{
		name: 'Code Analysis (default)',
		content:
			'Focus on correctness, clarity, and potential bugs. ' +
			'Flag any logic errors, edge cases, or unclear variable names.',
	},
	{
		name: 'Security Review',
		content:
			'Focus on security vulnerabilities: injection risks, improper input validation, ' +
			'insecure defaults, exposed secrets, and OWASP top-10 patterns.',
	},
	{
		name: 'Performance',
		content:
			'Focus on performance: unnecessary allocations, inefficient loops, ' +
			'blocking calls, and opportunities for caching or early exit.',
	},
];

const MODELS: { id: string; label: string; description: string }[] = [
	{ id: 'claude-haiku-4-5-20251001', label: 'Haiku',  description: 'Fast · cheapest' },
	{ id: 'claude-sonnet-4-6',         label: 'Sonnet', description: 'Balanced' },
	{ id: 'claude-opus-4-7',           label: 'Opus',   description: 'Most capable · most expensive' },
];

const SECRET_KEY = 'interfacer.apiKey';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Preset { name: string; content: string; }
interface FilterProfile { name: string; blocklist: string[]; allowlist: string[]; }

interface ContextItem {
	label: string;
	content: string;
	kind: 'file' | 'selection' | 'terminal';
	lineStart: number;
	lineEnd: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Module state ─────────────────────────────────────────────────────────────

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

		const config = vscode.workspace.getConfiguration('interfacer');
		const initSystemPrompt = config.get<string>('systemPrompt') || DEFAULT_SYSTEM_PROMPT;
		const initPresets      = config.get<Preset[]>('promptPresets') ?? DEFAULT_PRESETS;
		const initBlocklist      = config.get<string[]>('fileBlocklist') ?? [];
		const initAllowlist      = config.get<string[]>('fileAllowlist') ?? [];
		const initExtraExts      = config.get<string[]>('extraTextExtensions') ?? [];
		const initMaxChars       = config.get<number>('maxContextChars') ?? 40000;
		const initFilterProfiles = config.get<FilterProfile[]>('filterProfiles') ?? [];
		const initRespectIgnore  = config.get<boolean>('respectIgnoreFiles') ?? true;

		webviewView.webview.html = buildWebviewHtml(initSystemPrompt, initPresets, initBlocklist, initAllowlist, initExtraExts, initMaxChars, initFilterProfiles, initRespectIgnore);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'send': {
					const text = await callLLM(
						msg.prompt as string,
						msg.contexts as ContextItem[],
						msg.preset as string | undefined
					);
					this.post({ type: 'response', text });
					break;
				}
				case 'getSelection':    await injectSelectionContext(); break;
				case 'pickFile':        await injectFileContext(); break;
				case 'listOpenFiles':      await vscode.commands.executeCommand('interfacer.addOpenFiles'); break;
				case 'getTerminalOutput':  await addTerminalOutput(); break;
				case 'setApiKey':       await vscode.commands.executeCommand('interfacer.setApiKey'); break;
				case 'selectModel':     await vscode.commands.executeCommand('interfacer.selectModel'); break;
				case 'saveSystemPrompt': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					await cfg.update('systemPrompt', msg.value as string, vscode.ConfigurationTarget.Global);
					break;
				}
				case 'savePresets': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					await cfg.update('promptPresets', msg.presets as Preset[], vscode.ConfigurationTarget.Global);
					break;
				}
				case 'saveFilters': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					await cfg.update('fileBlocklist', msg.blocklist as string[], vscode.ConfigurationTarget.Global);
					await cfg.update('fileAllowlist', msg.allowlist as string[], vscode.ConfigurationTarget.Global);
					await cfg.update('extraTextExtensions', msg.extraTextExts as string[], vscode.ConfigurationTarget.Global);
					break;
				}
				case 'saveFilterProfiles': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					await cfg.update('filterProfiles', msg.profiles as FilterProfile[], vscode.ConfigurationTarget.Global);
					break;
				}
				case 'saveRespectIgnore': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					await cfg.update('respectIgnoreFiles', msg.value as boolean, vscode.ConfigurationTarget.Global);
					break;
				}
				case 'saveMaxChars': {
					const cfg = vscode.workspace.getConfiguration('interfacer');
					const val = Number(msg.value);
					if (Number.isFinite(val) && val > 0) {
						await cfg.update('maxContextChars', val, vscode.ConfigurationTarget.Global);
					}
					break;
				}
			}
		}, null, this.context.subscriptions);
	}

	post(msg: object) { this._view?.webview.postMessage(msg); }

	focus() { vscode.commands.executeCommand('interfacer.chatView.focus'); }

	sendSettings() {
		const config = vscode.workspace.getConfiguration('interfacer');
		this.post({
			type: 'updateSettings',
			systemPrompt:     config.get<string>('systemPrompt') || DEFAULT_SYSTEM_PROMPT,
			presets:          config.get<Preset[]>('promptPresets') ?? DEFAULT_PRESETS,
			blocklist:        config.get<string[]>('fileBlocklist') ?? [],
			allowlist:        config.get<string[]>('fileAllowlist') ?? [],
			extraTextExts:    config.get<string[]>('extraTextExtensions') ?? [],
			maxChars:         config.get<number>('maxContextChars') ?? 40000,
			filterProfiles:   config.get<FilterProfile[]>('filterProfiles') ?? [],
			respectIgnore:    config.get<boolean>('respectIgnoreFiles') ?? true,
		});
	}
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
			if (e.affectsConfiguration('interfacer.model')) {
				refreshStatusBar();
				const cfg = vscode.workspace.getConfiguration('interfacer');
				const modelId = cfg.get<string>('model') || MODELS[0].id;
				const match = MODELS.find((m) => m.id === modelId);
				provider.post({ type: 'modelChanged', label: match?.label ?? 'Haiku' });
			}
			if (e.affectsConfiguration('interfacer.systemPrompt') ||
			    e.affectsConfiguration('interfacer.promptPresets') ||
			    e.affectsConfiguration('interfacer.fileBlocklist') ||
			    e.affectsConfiguration('interfacer.fileAllowlist') ||
			    e.affectsConfiguration('interfacer.extraTextExtensions') ||
			    e.affectsConfiguration('interfacer.maxContextChars') ||
			    e.affectsConfiguration('interfacer.filterProfiles') ||
			    e.affectsConfiguration('interfacer.respectIgnoreFiles')) {
				provider.sendSettings();
			}
		}),

		vscode.commands.registerCommand('interfacer.openChat', () => provider.focus()),

		vscode.commands.registerCommand('interfacer.askLLM', async () => {
			await injectSelectionContext();
			provider.focus();
		}),

		vscode.commands.registerCommand('interfacer.selectModel', async () => {
			const config = vscode.workspace.getConfiguration('interfacer');
			const current = config.get<string>('model') || MODELS[0].id;
			const picked = await vscode.window.showQuickPick(
				MODELS.map((m) => ({ label: m.label, description: m.description, detail: m.id, picked: m.id === current })),
				{ placeHolder: 'Select Claude model', title: 'Interfacer — switch model' }
			);
			if (picked) {
				const model = MODELS.find((m) => m.label === picked.label)!;
				await config.update('model', model.id, vscode.ConfigurationTarget.Global);
			}
		}),

		vscode.commands.registerCommand('interfacer.addOpenFiles', async () => {
			const seen  = new Set<string>();
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

		vscode.commands.registerCommand('interfacer.addTerminalOutput', async () => {
			await addTerminalOutput();
		}),

		vscode.commands.registerCommand('interfacer.addActiveFile', async (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!target) { vscode.window.showWarningMessage('Interfacer: no file to add.'); return; }
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

async function addTerminalOutput() {
	const terminals = vscode.window.terminals;
	if (terminals.length === 0) {
		vscode.window.showWarningMessage('Interfacer: no terminals open.');
		return;
	}

	// If multiple terminals exist, let the user pick one
	let terminal: vscode.Terminal;
	if (terminals.length === 1) {
		terminal = terminals[0];
	} else {
		const items = [...terminals].map((t) => ({ label: t.name, terminal: t }));
		const picked = await vscode.window.showQuickPick(items, {
			title: 'Interfacer — select terminal',
			placeHolder: 'Which terminal?',
		});
		if (!picked) { return; }
		terminal = picked.terminal;
	}

	// Pick how many lines to capture
	const lineOpts = [
		{ label: 'Last 20 lines',  lines: 20 },
		{ label: 'Last 50 lines',  lines: 50 },
		{ label: 'Last 100 lines', lines: 100 },
		{ label: 'Last 200 lines', lines: 200 },
		{ label: 'Custom…',        lines: -1 },
	];
	const linePick = await vscode.window.showQuickPick(lineOpts, {
		title: 'Interfacer — terminal output',
		placeHolder: 'How many lines to capture?',
	});
	if (!linePick) { return; }

	let nLines = linePick.lines;
	if (nLines === -1) {
		const input = await vscode.window.showInputBox({
			title: 'Interfacer — custom line count',
			prompt: 'Number of lines to capture from the terminal',
			value: '100',
			validateInput: (v) => (!v || isNaN(parseInt(v)) || parseInt(v) < 1)
				? 'Enter a positive integer'
				: undefined,
		});
		if (!input) { return; }
		nLines = parseInt(input);
	}

	// Capture via clipboard: select-all → copy → restore clipboard
	const prevClipboard = await vscode.env.clipboard.readText();
	terminal.show(false);
	await sleep(150);
	await vscode.commands.executeCommand('workbench.action.terminal.selectAll');
	await sleep(100);
	await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
	await vscode.commands.executeCommand('workbench.action.terminal.clearSelection');
	await sleep(50);
	const raw = await vscode.env.clipboard.readText();
	await vscode.env.clipboard.writeText(prevClipboard);

	if (!raw) {
		vscode.window.showWarningMessage('Interfacer: terminal appears empty.');
		provider.focus();
		return;
	}

	const allLines = raw.split('\n');
	const sliced   = allLines.slice(-nLines).join('\n');
	const label    = `${terminal.name} (last ${Math.min(nLines, allLines.length)} lines)`;

	provider.post({
		type: 'addContext',
		item: {
			label, content: sliced, kind: 'terminal',
			lineStart: Math.max(1, allLines.length - nLines + 1),
			lineEnd:   allLines.length,
		} satisfies ContextItem,
	});
	provider.focus();
}

async function injectSelectionContext() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) { vscode.window.showWarningMessage('Interfacer: no active editor.'); return; }

	const config   = vscode.workspace.getConfiguration('interfacer');
	const maxChars = config.get<number>('maxContextChars') ?? 40000;
	const sel      = editor.selection;
	const isWhole  = sel.isEmpty;
	let text       = isWhole ? editor.document.getText() : editor.document.getText(sel);

	let truncated = false;
	if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

	const fileName = editor.document.fileName.split(/[/\\]/).pop() ?? 'file';

	if (isWhole) {
		const confirm = await vscode.window.showQuickPick(
			['Send whole file', 'Cancel'],
			{ placeHolder: `No selection — send entire ${fileName}?` }
		);
		if (confirm !== 'Send whole file') { return; }
	}

	provider.post({
		type: 'addContext',
		item: {
			label:     fileName + (isWhole ? '' : ' (selection)') + (truncated ? ' — truncated' : ''),
			content:   text,
			kind:      isWhole ? 'file' : 'selection',
			lineStart: isWhole ? 1 : sel.start.line + 1,
			lineEnd:   isWhole ? editor.document.lineCount : sel.end.line + 1,
		} satisfies ContextItem,
	});
}

async function injectFileContext() {
	const mode = await vscode.window.showQuickPick(
		[
			{ label: '📄 Pick files',   description: 'Choose one or more individual files', value: 'files' },
			{ label: '📁 Pick folder',  description: 'Add all text files inside a folder (recursive)', value: 'folder' },
		],
		{ title: 'Interfacer — add to context', placeHolder: 'What do you want to add?' }
	);
	if (!mode) { return; }

	if (mode.value === 'files') {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			openLabel: 'Add to context',
			title: 'Interfacer — pick files',
		});
		if (!uris || uris.length === 0) { return; }
		for (const uri of uris) { await addUriToContext(uri); }

	} else {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: false,
			canSelectFiles: false,
			canSelectFolders: true,
			openLabel: 'Add all files in folder',
			title: 'Interfacer — pick folder',
		});
		if (!uris || uris.length === 0) { return; }
		await addFolderToContext(uris[0]);
	}
}

// Text file extensions considered safe to read as UTF-8
const TEXT_EXTENSIONS = new Set([
	'ts','tsx','js','jsx','mjs','cjs','json','jsonc',
	'html','htm','css','scss','less','svelte','vue',
	'py','pyi','rb','rs','go','java','kt','kts','swift','c','h','cpp','hpp','cc','hh','cs',
	'zig','lua','dart','ex','exs','erl','hrl','elm','ml','mli','fs','fsx','fsi',
	'r','rmd','jl','scala','clj','cljs','cljc','groovy','gradle',
	'php','pl','pm','tcl','awk','sed',
	'sh','bash','zsh','fish','ps1','bat','cmd',
	'md','mdx','txt','rst','yaml','yml','toml','ini','env','cfg','conf','properties',
	'sql','graphql','gql','proto','xml','csv','tsv','log',
	'makefile','dockerfile','gitignore','editorconfig','prettierrc','eslintrc','babelrc',
	'tf','tfvars','bicep','nix','cmake','lock',
]);

function isTextFile(uri: vscode.Uri, extra: Set<string> = new Set()): boolean {
	const name = uri.path.split('/').pop() ?? '';
	if (['makefile','dockerfile','.gitignore','.editorconfig','.env'].includes(name.toLowerCase())) { return true; }
	const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
	return TEXT_EXTENSIONS.has(ext) || extra.has(ext);
}

// Parses lines from a .gitignore / .vscodeignore file into glob patterns,
// stripping comments, blank lines, and negation patterns.
function parseIgnoreLines(lines: string[]): string[] {
	return lines
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'));
}

// Reads .gitignore and .vscodeignore from the workspace root(s) and the
// given folder, merges the patterns, and deduplicates them.
async function readIgnorePatterns(folderUri: vscode.Uri): Promise<string[]> {
	const patterns: string[] = [];
	const roots = new Set<string>([folderUri.toString()]);
	for (const wsFolder of vscode.workspace.workspaceFolders ?? []) {
		roots.add(wsFolder.uri.toString());
	}
	for (const rootStr of roots) {
		const rootUri = vscode.Uri.parse(rootStr);
		for (const file of ['.gitignore', '.vscodeignore']) {
			try {
				const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(rootUri, file));
				patterns.push(...parseIgnoreLines(Buffer.from(bytes).toString('utf8').split('\n')));
			} catch { /* not found */ }
		}
	}
	return [...new Set(patterns)];
}

// Converts a gitignore-style glob pattern to a RegExp.
// * matches any chars except /; ** matches across / boundaries.
function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '\x00')
		.replace(/\*/g, '[^/]*')
		.replace(/\x00/g, '.*');
	return new RegExp('^' + escaped + '$', 'i');
}

// Returns true if any pattern matches the file. Patterns without a '/' are
// matched against the filename only; patterns with '/' are matched against
// the path relative to the folder root (relPath).
function matchesAnyPattern(patterns: string[], name: string, relPath: string): boolean {
	return patterns.some((p) => {
		const target = p.includes('/') ? relPath : name;
		return globToRegex(p).test(target);
	});
}

// Decides whether a file should be included. Accepts an optional effective
// blocklist/allowlist (used by addFolderToContext after merging ignore files);
// falls back to reading from config when called for single-file adds.
function filePassesFilters(uri: vscode.Uri, relPath: string, effectiveBlocklist?: string[], effectiveAllowlist?: string[]): boolean {
	if (!effectiveBlocklist || !effectiveAllowlist) {
		const config = vscode.workspace.getConfiguration('interfacer');
		effectiveBlocklist = effectiveBlocklist ?? config.get<string[]>('fileBlocklist') ?? [];
		effectiveAllowlist = effectiveAllowlist ?? config.get<string[]>('fileAllowlist') ?? [];
	}
	const name = uri.path.split('/').pop() ?? '';
	if (effectiveBlocklist.length > 0 && matchesAnyPattern(effectiveBlocklist, name, relPath)) { return false; }
	if (effectiveAllowlist.length > 0) { return matchesAnyPattern(effectiveAllowlist, name, relPath); }
	return true;
}

// Returns true if a directory should be skipped entirely before recursing.
function dirIsBlocked(dirName: string, dirRelPath: string, effectiveBlocklist?: string[]): boolean {
	effectiveBlocklist = effectiveBlocklist ?? vscode.workspace.getConfiguration('interfacer').get<string[]>('fileBlocklist') ?? [];
	return effectiveBlocklist.some((p) => {
		const stripped = p.endsWith('/**') ? p.slice(0, -3) : p.endsWith('/*') ? p.slice(0, -2) : null;
		if (!stripped) { return false; }
		const target = stripped.includes('/') ? dirRelPath : dirName;
		return globToRegex(stripped).test(target);
	});
}

async function addFolderToContext(folderUri: vscode.Uri) {
	const config        = vscode.workspace.getConfiguration('interfacer');
	const maxChars      = config.get<number>('maxContextChars') ?? 40000;
	const userBlocklist = config.get<string[]>('fileBlocklist') ?? [];
	const allowlist     = config.get<string[]>('fileAllowlist') ?? [];
	const respectIgnore = config.get<boolean>('respectIgnoreFiles') ?? true;
	const extraExts     = new Set(
		(config.get<string[]>('extraTextExtensions') ?? []).map((e) => e.replace(/^\./, '').toLowerCase())
	);

	// Merge user blocklist with .gitignore/.vscodeignore patterns (computed now,
	// not stored — stays in sync with ignore files without touching user settings).
	let effectiveBlocklist = userBlocklist;
	if (respectIgnore) {
		const ignorePatterns = await readIgnorePatterns(folderUri);
		effectiveBlocklist = [...new Set([...userBlocklist, ...ignorePatterns])];
	}

	// Recursively collect all files
	const collect = async (dir: vscode.Uri): Promise<vscode.Uri[]> => {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const results: vscode.Uri[] = [];
		for (const [name, type] of entries) {
			if (name.startsWith('.')) { continue; } // skip hidden
			const child   = vscode.Uri.joinPath(dir, name);
			const relPath = child.path.substring(folderUri.path.length + 1);
			if (type === vscode.FileType.Directory) {
				if (dirIsBlocked(name, relPath, effectiveBlocklist)) { continue; }
				results.push(...await collect(child));
			} else if (type === vscode.FileType.File) {
				const passesBuiltin = allowlist.length > 0 ? true : isTextFile(child, extraExts);
				if (passesBuiltin && filePassesFilters(child, relPath, effectiveBlocklist, allowlist)) {
					results.push(child);
				}
			}
		}
		return results;
	};

	const files = await collect(folderUri);
	if (files.length === 0) {
		const action = await vscode.window.showWarningMessage(
			'Interfacer: no text files found in that folder. Unknown file extensions are excluded by default.',
			'Open File Filters'
		);
		if (action === 'Open File Filters') {
			provider.focus();
			provider.post({ type: 'openSettings', section: 'filters' });
		}
		return;
	}

	// Confirm if large
	const folderName = folderUri.path.split('/').pop() ?? 'folder';
	if (files.length > 10) {
		const confirm = await vscode.window.showQuickPick(
			[`Add all ${files.length} files`, 'Cancel'],
			{ placeHolder: `${folderName} contains ${files.length} text files. Continue?` }
		);
		if (confirm !== `Add all ${files.length} files`) { return; }
	}

	for (const uri of files.sort((a, b) => a.path.localeCompare(b.path))) {
		const bytes = await vscode.workspace.fs.readFile(uri);
		let text    = Buffer.from(bytes).toString('utf8');
		let truncated = false;
		if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
		const name      = uri.path.split('/').pop() ?? 'file';
		const lineCount = text.split('\n').length;
		provider.post({
			type: 'addContext',
			item: {
				label: name + (truncated ? ' — truncated' : ''),
				content: text, kind: 'file',
				lineStart: 1, lineEnd: lineCount,
			} satisfies ContextItem,
		});
	}
}

async function addUriToContext(uri: vscode.Uri) {
	if (!filePassesFilters(uri, '')) {
		vscode.window.showInformationMessage(`Interfacer: "${uri.path.split('/').pop()}" is excluded by your file filter settings.`);
		return;
	}
	const config   = vscode.workspace.getConfiguration('interfacer');
	const maxChars = config.get<number>('maxContextChars') ?? 40000;

	const bytes = await vscode.workspace.fs.readFile(uri);
	let text    = Buffer.from(bytes).toString('utf8');
	let truncated = false;
	if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

	const fileName  = uri.path.split('/').pop() ?? 'file';
	const lineCount = text.split('\n').length;
	provider.post({
		type: 'addContext',
		item: {
			label: fileName + (truncated ? ' — truncated' : ''),
			content: text, kind: 'file',
			lineStart: 1, lineEnd: lineCount,
		} satisfies ContextItem,
	});
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM(prompt: string, contexts: ContextItem[], preset?: string): Promise<string> {
	const config   = vscode.workspace.getConfiguration('interfacer');
	const apiKey   =
		(await secrets.get(SECRET_KEY)) ||
		config.get<string>('apiKey') ||
		process.env.ANTHROPIC_API_KEY || '';
	const model    = config.get<string>('model') || MODELS[0].id;
	const baseSys  = config.get<string>('systemPrompt') || DEFAULT_SYSTEM_PROMPT;
	const systemPrompt = preset ? baseSys + '\n\n' + preset : baseSys;

	if (!apiKey) {
		return 'No API key configured.\nClick 🔑 or run the command Interfacer: Set API Key.';
	}

	let userContent = '';
	if (contexts.length > 0) {
		userContent = contexts
			.map((c) => `### ${c.label}\n\`\`\`\n${c.content}\n\`\`\``)
			.join('\n\n') + '\n\n';
	}
	userContent += prompt;

	const body = JSON.stringify({
		model, max_tokens: 1024, system: systemPrompt,
		messages: [{ role: 'user', content: userContent }],
	});

	return new Promise((resolve) => {
		const req = https.request(
			{
				hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
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
						if (parsed.content?.[0]?.text) { resolve(parsed.content[0].text as string); }
						else if (parsed.error)         { resolve(`API error: ${parsed.error.message}`); }
						else                           { resolve('Unexpected response:\n' + raw.slice(0, 300)); }
					} catch { resolve('Failed to parse API response:\n' + raw.slice(0, 300)); }
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
	const config  = vscode.workspace.getConfiguration('interfacer');
	const modelId = config.get<string>('model') || MODELS[0].id;
	const match   = MODELS.find((m) => m.id === modelId);
	statusBarItem.text = `$(hubot) ${match?.label ?? 'Interfacer'}`;
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function buildWebviewHtml(initSystemPrompt: string, initPresets: Preset[], initBlocklist: string[], initAllowlist: string[], initExtraExts: string[], initMaxChars: number, initFilterProfiles: FilterProfile[], initRespectIgnore: boolean): string {
	const nonce = crypto.randomBytes(16).toString('hex');

	// Safely embed JS values
	const jsSystemPrompt    = JSON.stringify(initSystemPrompt);
	const jsPresets         = JSON.stringify(initPresets);
	const jsDefaultSys      = JSON.stringify(DEFAULT_SYSTEM_PROMPT);
	const jsBlocklist       = JSON.stringify(initBlocklist);
	const jsAllowlist       = JSON.stringify(initAllowlist);
	const jsExtraExts       = JSON.stringify(initExtraExts);
	const jsMaxChars        = JSON.stringify(initMaxChars);
	const jsFilterProfiles  = JSON.stringify(initFilterProfiles);
	const jsRespectIgnore   = JSON.stringify(initRespectIgnore);

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
    display: flex; flex-direction: column; height: 100vh;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }

  /* toolbar */
  #toolbar {
    display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
    flex-shrink: 0;
  }
  .tool-btn {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 3px 8px; cursor: pointer; border: 1px solid transparent;
    border-radius: 2px; font-family: inherit; font-size: 0.85em; white-space: nowrap; line-height: 1.4;
  }
  .tool-btn.primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tool-btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .tool-btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .tool-btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .tool-btn.ghost     { background: transparent; color: var(--vscode-descriptionForeground); }
  .tool-btn.ghost:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tool-btn:disabled  { opacity: 0.45; cursor: default; }
  .tool-btn.active    { color: var(--vscode-textLink-foreground); }

  /* back bar (shown at top of info / settings views) */
  .back-bar {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px; flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-widget-border, #444);
    background: var(--vscode-sideBarSectionHeader-background, transparent);
  }
  .back-btn {
    background: none; border: none; cursor: pointer;
    padding: 3px 6px; border-radius: 2px;
    font-family: inherit; font-size: 0.85em;
    color: var(--vscode-textLink-foreground);
    display: flex; align-items: center; gap: 4px;
  }
  .back-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .back-bar-title {
    font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em;
    opacity: 0.45; font-weight: 600;
  }
  .tb-spacer { flex: 1; }

  /* shared view styles */
  .view { display: none; flex: 1; overflow-y: auto; flex-direction: column; }
  .view.active { display: flex; }

  /* log */
  #log { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 10px; }
  .msg { white-space: pre-wrap; word-break: break-word; padding: 6px 10px; border-radius: 3px; line-height: 1.5; }
  .msg-label { font-size: 0.72em; opacity: 0.5; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.04em; }
  .msg.user      { background: var(--vscode-input-background); border-left: 2px solid var(--vscode-focusBorder); }
  .msg.assistant { background: var(--vscode-editor-inactiveSelectionBackground); border-left: 2px solid var(--vscode-textLink-foreground); }

  /* input area */
  #input-area {
    display: flex; flex-direction: column; gap: 4px;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--vscode-widget-border, #444);
    flex-shrink: 0;
  }
  /* preset selector */
  #preset-row { display: flex; align-items: center; gap: 6px; }
  #preset-select {
    flex: 1; padding: 3px 5px; font-family: inherit; font-size: 0.82em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 2px;
  }
  #preset-active-label {
    font-size: 0.75em; opacity: 0.6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
  }
  /* context list */
  #ctx-header { display: none; align-items: center; gap: 4px; font-size: 0.78em; color: var(--vscode-descriptionForeground); padding-bottom: 2px; }
  #ctx-header.visible { display: flex; }
  #ctx-header-label { flex: 1; font-weight: 600; }
  #ctx-list { display: flex; flex-direction: column; gap: 2px; }
  .ctx-item { display: flex; align-items: center; gap: 5px; padding: 2px 6px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 2px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .ctx-item-icon { flex-shrink: 0; }
  .ctx-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx-item-meta { flex-shrink: 0; opacity: 0.6; font-size: 0.9em; }
  .ctx-item-rm { flex-shrink: 0; background: none; border: none; cursor: pointer; padding: 0 2px; color: var(--vscode-descriptionForeground); opacity: 0.6; font-size: 1em; line-height: 1; }
  .ctx-item-rm:hover { opacity: 1; }
  /* preview */
  #preview-wrap { border-top: 1px solid var(--vscode-widget-border, #333); margin-top: 2px; }
  #btn-preview { width: 100%; text-align: left; background: transparent; border: none; cursor: pointer; padding: 4px 6px; font-family: inherit; font-size: 0.78em; color: var(--vscode-descriptionForeground); opacity: 0.7; }
  #btn-preview:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  #preview-panel { display: none; flex-direction: column; font-size: 0.78em; background: var(--vscode-textBlockQuote-background, var(--vscode-editor-inactiveSelectionBackground)); border-radius: 3px; overflow: hidden; margin-bottom: 2px; }
  #preview-panel.open { display: flex; }
  .pv-section { padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  .pv-section:last-child { border-bottom: none; }
  .pv-section-label { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.5; margin-bottom: 3px; }
  .pv-text { white-space: pre-wrap; word-break: break-word; opacity: 0.8; line-height: 1.4; max-height: 60px; overflow: hidden; }
  .pv-ctx-row { display: flex; align-items: center; gap: 5px; padding: 1px 0; opacity: 0.85; }
  .pv-ctx-row-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pv-ctx-row-meta { flex-shrink: 0; opacity: 0.6; }
  #pv-stats { padding: 4px 8px; font-size: 0.85em; opacity: 0.55; text-align: right; }
  #pv-empty-note { padding: 5px 8px; opacity: 0.5; font-style: italic; }
  /* prompt */
  #prompt { resize: vertical; min-height: 60px; width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); border-radius: 2px; padding: 5px 6px; font-family: inherit; font-size: inherit; line-height: 1.4; }
  #prompt:focus { outline: 1px solid var(--vscode-focusBorder); }
  #send-row { display: flex; align-items: center; gap: 4px; }
  #status { font-size: 0.78em; opacity: 0.5; margin-left: 4px; }
  #model-label { font-size: 0.72em; opacity: 0.4; margin-left: auto; padding-right: 2px; }
  #hint { font-size: 0.72em; opacity: 0.35; text-align: right; padding-top: 1px; }

  /* ── info view ── */
  #info-view { padding: 10px 12px; gap: 16px; }
  .iv-section { display: flex; flex-direction: column; gap: 3px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-widget-border, #333); font-size: 0.85em; }
  .iv-section:last-child { border-bottom: none; }
  .iv-title   { font-size: 1.1em; font-weight: 700; margin-bottom: 2px; }
  .iv-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.5; font-weight: 600; margin-bottom: 2px; }
  .iv-hint    { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .iv-desc    { opacity: 0.75; }
  .iv-row     { display: flex; gap: 8px; padding: 2px 0; }
  .iv-key     { flex-shrink: 0; width: 46%; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; color: var(--vscode-textLink-foreground); word-break: break-word; }
  .iv-val     { flex: 1; opacity: 0.8; }
  .iv-val code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 0 3px; border-radius: 2px; }
  .iv-system-prompt { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)); padding: 6px 8px; border-radius: 3px; opacity: 0.85; }

  /* ── settings view ── */
  #settings-view { padding: 10px 12px; gap: 16px; }
  .sv-section { display: flex; flex-direction: column; gap: 6px; padding-bottom: 14px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  .sv-section:last-child { border-bottom: none; }
  .sv-heading { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.5; font-weight: 600; }
  .sv-desc    { font-size: 0.82em; opacity: 0.65; }
  .sv-textarea {
    width: 100%; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 2px;
    padding: 5px 6px; line-height: 1.5; min-height: 80px;
  }
  .sv-textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .sv-input {
    width: 100%; padding: 4px 6px; font-family: inherit; font-size: 0.88em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 2px;
  }
  .sv-input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .sv-btn-row { display: flex; gap: 5px; align-items: center; }
  .sv-btn-row .spacer { flex: 1; }
  /* preset list */
  #sv-preset-list { display: flex; flex-direction: column; gap: 4px; }
  .sv-preset-item { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; }
  .sv-preset-info { flex: 1; min-width: 0; }
  .sv-preset-name { font-size: 0.88em; font-weight: 600; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-preset-preview { font-size: 0.78em; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sv-preset-actions { display: flex; gap: 3px; flex-shrink: 0; }
  /* inline edit form */
  #sv-preset-form { display: none; flex-direction: column; gap: 6px; padding: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; border: 1px solid var(--vscode-focusBorder); }
  #sv-preset-form.open { display: flex; }
  .sv-form-label { font-size: 0.78em; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 1px; }
  .sv-saved-notice { font-size: 0.78em; opacity: 0.6; font-style: italic; align-self: center; }
</style>
</head>
<body>

<!-- toolbar -->
<div id="toolbar">
  <button class="tool-btn secondary" id="btn-selection" title="Attach current editor selection">✂ Add Selection</button>
  <button class="tool-btn secondary" id="btn-open"      title="Choose from currently open files">📋 Open Files</button>
  <button class="tool-btn secondary" id="btn-file"      title="Pick files from disk">📂 Browse…</button>
  <button class="tool-btn secondary" id="btn-terminal"  title="Capture last N lines from a terminal">⬡ Terminal</button>
  <div class="tb-spacer"></div>
  <button class="tool-btn ghost" id="btn-model"    title="Switch model"></button>
  <button class="tool-btn ghost" id="btn-apikey"   title="Set API key">🔑</button>
  <button class="tool-btn ghost" id="btn-clrlog"   title="Clear conversation log">🗑</button>
  <button class="tool-btn ghost" id="btn-settings" title="Settings">⚙</button>
  <button class="tool-btn ghost" id="btn-info"     title="Extension info">ℹ</button>
</div>

<!-- ── chat view ── -->
<div id="chat-view" class="view active" style="flex-direction: column;">
  <div id="log"></div>
  <div id="input-area">
    <!-- preset selector -->
    <div id="preset-row">
      <select id="preset-select" title="Optional header preset appended to the system prompt">
        <option value="">— no header preset —</option>
      </select>
    </div>
    <!-- context list -->
    <div id="ctx-header">
      <span id="ctx-header-label">Context</span>
      <button class="tool-btn ghost" style="font-size:0.85em;padding:1px 5px;" id="btn-clr-all-ctx">Clear all</button>
    </div>
    <div id="ctx-list"></div>
    <!-- preview -->
    <div id="preview-wrap">
      <button id="btn-preview">▶ Preview full payload</button>
      <div id="preview-panel">
        <div class="pv-section">
          <div class="pv-section-label">System prompt <span id="pv-preset-badge" style="display:none;opacity:0.6;">+ preset</span></div>
          <div class="pv-text" id="pv-system"></div>
        </div>
        <div class="pv-section">
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
</div>

<!-- ── info view ── -->
<div id="info-view" class="view" style="flex-direction:column;">
  <div class="back-bar">
    <button class="back-btn back-to-chat" title="Return to chat">← Back</button>
    <span class="back-bar-title">Info</span>
  </div>
  <div style="overflow-y:auto;flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:16px;">
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
    <div class="iv-row"><span class="iv-key">Interfacer: Set API Key</span><span class="iv-val">Store Anthropic API key in the OS keychain</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">Keyboard Shortcuts</div>
    <div class="iv-row"><span class="iv-key">Ctrl+Shift+I</span><span class="iv-val">Send selection to LLM (editor must be focused)</span></div>
    <div class="iv-row"><span class="iv-key">Ctrl+Enter</span><span class="iv-val">Send message (chat textarea must be focused)</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">Toolbar Buttons</div>
    <div class="iv-row"><span class="iv-key">✂ Add Selection</span><span class="iv-val">Attach the active editor's selection. If nothing is selected, prompts to send the whole file.</span></div>
    <div class="iv-row"><span class="iv-key">📋 Open Files</span><span class="iv-val">Multi-select QuickPick of all open tabs, sorted A–Z.</span></div>
    <div class="iv-row"><span class="iv-key">📂 Browse…</span><span class="iv-val">OS file picker — add files not currently open. Supports multi-select.</span></div>
    <div class="iv-row"><span class="iv-key">&gt;_ Terminal</span><span class="iv-val">Capture the last N lines from any open terminal. Prompts to pick terminal (if multiple) and line count (20 / 50 / 100 / 200 / custom). Clipboard is temporarily used and immediately restored.</span></div>
    <div class="iv-row"><span class="iv-key">⊙ [Model]</span><span class="iv-val">Open model switcher QuickPick. Also clickable in the status bar (bottom-right).</span></div>
    <div class="iv-row"><span class="iv-key">🔑</span><span class="iv-val">Set or update the Anthropic API key.</span></div>
    <div class="iv-row"><span class="iv-key">🗑</span><span class="iv-val">Clear the conversation log for this session.</span></div>
    <div class="iv-row"><span class="iv-key">⚙</span><span class="iv-val">Open the Settings view — edit system prompt and manage header presets.</span></div>
    <div class="iv-row"><span class="iv-key">ℹ</span><span class="iv-val">Toggle this info view.</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">Editor Menus</div>
    <div class="iv-row"><span class="iv-key">Right-click selected text</span><span class="iv-val">"Interfacer: Send Selection to LLM" — visible only when text is selected</span></div>
    <div class="iv-row"><span class="iv-key">Right-click on a tab</span><span class="iv-val">"Add to Interfacer Context" — adds that file directly</span></div>
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
    <div class="iv-heading">Header Presets</div>
    <div class="iv-desc">Named instruction snippets, selectable per-message from the dropdown above the textarea. The selected preset is appended to the system prompt for that request only. Managed in ⚙ Settings.</div>
    <div class="iv-row"><span class="iv-key">Dropdown</span><span class="iv-val">Select a preset before sending. Stays selected until changed.</span></div>
    <div class="iv-row"><span class="iv-key">Preview</span><span class="iv-val">The preview panel shows "System prompt + preset" when one is active.</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">Payload Preview</div>
    <div class="iv-desc">Click "▶ Preview full payload" above the textarea to expand a live view of exactly what will be sent.</div>
    <div class="iv-row"><span class="iv-key">System prompt</span><span class="iv-val">The configured system prompt (plus active preset, if any)</span></div>
    <div class="iv-row"><span class="iv-key">Context items</span><span class="iv-val">Each attached file/selection with its line range</span></div>
    <div class="iv-row"><span class="iv-key">Your prompt</span><span class="iv-val">Live echo of what you're typing</span></div>
    <div class="iv-row"><span class="iv-key">Stats line</span><span class="iv-val">Total chars and estimated tokens (chars ÷ 4)</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">Models</div>
    <div class="iv-row"><span class="iv-key">Haiku</span><span class="iv-val"><code>claude-haiku-4-5-20251001</code> — fastest, cheapest. Default.</span></div>
    <div class="iv-row"><span class="iv-key">Sonnet</span><span class="iv-val"><code>claude-sonnet-4-6</code> — balanced capability and cost</span></div>
    <div class="iv-row"><span class="iv-key">Opus</span><span class="iv-val"><code>claude-opus-4-7</code> — most capable, most expensive</span></div>
    <div class="iv-desc" style="margin-top:4px;">Selection is saved globally. Visible in the status bar bottom-right.</div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">API Key &amp; Settings</div>
    <div class="iv-row"><span class="iv-key">OS keychain</span><span class="iv-val">Preferred. Set via 🔑 button. Never written to settings.json.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.apiKey</span><span class="iv-val">VS Code setting fallback. Plaintext — not recommended.</span></div>
    <div class="iv-row"><span class="iv-key">ANTHROPIC_API_KEY</span><span class="iv-val">Environment variable fallback.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.model</span><span class="iv-val">Persisted model ID.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.systemPrompt</span><span class="iv-val">Editable system prompt. Reset to default available in ⚙ Settings.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.promptPresets</span><span class="iv-val">Array of <code>{ name, content }</code> preset objects. Managed in ⚙ Settings.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.maxContextChars</span><span class="iv-val">Per-file character cap. Default: 40,000. Editable in ⚙ Settings → Context Limits.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.fileBlocklist</span><span class="iv-val">Glob patterns for files to always exclude (e.g. <code>*.log</code>, <code>dist/**</code>). Managed in ⚙ Settings.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.fileAllowlist</span><span class="iv-val">Glob patterns for files to include when adding folders. Non-empty replaces the built-in text-extension filter. Managed in ⚙ Settings.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.extraTextExtensions</span><span class="iv-val">Extra file extensions (e.g. <code>zig</code>, <code>lua</code>) to treat as text. Files with unknown extensions are skipped unless listed here. Managed in ⚙ Settings → File Filters.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.respectIgnoreFiles</span><span class="iv-val">When adding a folder, merge <code>.gitignore</code>/<code>.vscodeignore</code> patterns into the blocklist on use (not stored). Toggle in ⚙ Settings → File Filters.</span></div>
    <div class="iv-row"><span class="iv-key">interfacer.filterProfiles</span><span class="iv-val">Named blocklist/allowlist combinations. Managed in ⚙ Settings → Filter Profiles.</span></div>
  </div>
  <div class="iv-section">
    <div class="iv-heading">System Prompt (current)</div>
    <div class="iv-system-prompt" id="iv-system-prompt-text"></div>
  </div>
  </div> <!-- end scroll wrapper -->
</div>

<!-- ── settings view ── -->
<div id="settings-view" class="view" style="flex-direction:column;">
  <div class="back-bar">
    <button class="back-btn back-to-chat" title="Return to chat">← Back</button>
    <span class="back-bar-title">Settings</span>
  </div>
  <div style="overflow-y:auto;flex:1;padding:10px 12px;display:flex;flex-direction:column;gap:16px;">

  <div class="sv-section">
    <div class="sv-heading">System Prompt</div>
    <div class="sv-desc">Sent with every request as the base instruction. The active header preset (if any) is appended after this for that message only.</div>
    <textarea id="sv-sysprompt" class="sv-textarea" rows="6"></textarea>
    <div class="sv-btn-row">
      <button class="tool-btn ghost" id="sv-reset-prompt">Reset to default</button>
      <div class="spacer"></div>
      <span class="sv-saved-notice" id="sv-prompt-saved" style="display:none;">Saved.</span>
      <button class="tool-btn primary" id="sv-save-prompt">Save</button>
    </div>
  </div>

  <div class="sv-section">
    <div class="sv-heading">Header Presets</div>
    <div class="sv-desc">Select a preset in the chat dropdown to append its instructions to the system prompt for that message. Useful for switching between analysis modes without editing the base prompt.</div>
    <div id="sv-preset-list"></div>
    <button class="tool-btn secondary" id="sv-add-preset" style="align-self:flex-start;">+ Add Preset</button>
    <!-- inline edit/add form -->
    <div id="sv-preset-form">
      <div>
        <div class="sv-form-label">Name</div>
        <input id="sv-form-name" class="sv-input" placeholder="e.g. Security Review" />
      </div>
      <div>
        <div class="sv-form-label">Instructions</div>
        <textarea id="sv-form-content" class="sv-textarea" rows="4" placeholder="Additional instructions appended to the system prompt…"></textarea>
      </div>
      <div class="sv-btn-row">
        <button class="tool-btn ghost" id="sv-form-cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="tool-btn primary" id="sv-form-save">Save Preset</button>
      </div>
    </div>
  </div>

  <div class="sv-section">
    <div class="sv-heading">File Filters</div>
    <div class="sv-desc">Applied when adding files or folders to context. One glob pattern per line. <code>*</code> matches anything except <code>/</code>; <code>**</code> matches across directories. Patterns without <code>/</code> match the filename only; patterns with <code>/</code> match the path relative to the picked folder.</div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-top:8px;">
      <input type="checkbox" id="sv-respect-ignore" />
      <span style="font-size:0.88em;">Respect <code>.gitignore</code> and <code>.vscodeignore</code> — patterns are merged with the blocklist on use, not stored</span>
    </label>
    <div class="sv-form-label" style="margin-top:10px;">Blocklist — always exclude matching files</div>
    <textarea id="sv-blocklist" class="sv-textarea" rows="4" placeholder="*.log&#10;dist/**&#10;node_modules/**&#10;**/*.min.js"></textarea>
    <div class="sv-form-label" style="margin-top:8px;">Allowlist — if non-empty, only include matching files (overrides built-in extension check)</div>
    <textarea id="sv-allowlist" class="sv-textarea" rows="4" placeholder="src/**&#10;*.ts&#10;*.py"></textarea>
    <div class="sv-form-label" style="margin-top:8px;">Extra file extensions — extend the built-in text-file list (one per line, with or without leading dot)</div>
    <div class="sv-desc" style="margin-bottom:4px;">Files with unknown extensions are skipped unless listed here or matched by the allowlist above. If folder add returns no files, this is the likely cause.</div>
    <textarea id="sv-extra-exts" class="sv-textarea" rows="3" placeholder=".zig&#10;.lua&#10;.v"></textarea>
    <div class="sv-btn-row">
      <button class="tool-btn ghost" id="sv-reset-filters">Reset to defaults</button>
      <div class="spacer"></div>
      <span class="sv-saved-notice" id="sv-filters-saved" style="display:none;">Saved.</span>
      <button class="tool-btn primary" id="sv-save-filters">Save</button>
    </div>
  </div>

  <div class="sv-section">
    <div class="sv-heading">Filter Profiles</div>
    <div class="sv-desc">Named blocklist / allowlist combinations. Loading a profile fills the textareas above — review and click Save to apply.</div>
    <div id="sv-fp-list"></div>
    <button class="tool-btn secondary" id="sv-save-fp" style="align-self:flex-start;margin-top:4px;">↑ Save current filters as profile</button>
    <div id="sv-fp-form">
      <div class="sv-form-label">Profile name</div>
      <input id="sv-fp-name" class="sv-input" placeholder="e.g. Python project, ignore tests…" />
      <div class="sv-btn-row">
        <button class="tool-btn ghost" id="sv-fp-cancel">Cancel</button>
        <div class="spacer"></div>
        <button class="tool-btn primary" id="sv-fp-save-btn">Save Profile</button>
      </div>
    </div>
  </div>

  <div class="sv-section">
    <div class="sv-heading">Context Limits</div>
    <div class="sv-desc">Per-file character cap. Files longer than this limit are truncated and labelled "— truncated" when added to context.</div>
    <div class="sv-form-label">Max characters per file</div>
    <input type="number" id="sv-max-chars" class="sv-input" min="1000" max="2000000" step="1000" style="width:140px;" />
    <div class="sv-btn-row" style="margin-top:6px;">
      <button class="tool-btn ghost" id="sv-reset-maxchars">Reset to default (40,000)</button>
      <div class="spacer"></div>
      <span class="sv-saved-notice" id="sv-maxchars-saved" style="display:none;">Saved.</span>
      <button class="tool-btn primary" id="sv-save-maxchars">Save</button>
    </div>
  </div>

  </div> <!-- end scroll wrapper -->
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();

  // ── DOM refs ────────────────────────────────────────────────────────────────
  const logEl         = document.getElementById('log');
  const promptEl      = document.getElementById('prompt');
  const statusEl      = document.getElementById('status');
  const modelLabel    = document.getElementById('model-label');
  const presetSelect  = document.getElementById('preset-select');
  const ctxHeader     = document.getElementById('ctx-header');
  const ctxList       = document.getElementById('ctx-list');
  const btnSend       = document.getElementById('btn-send');
  const btnSelection  = document.getElementById('btn-selection');
  const btnOpen       = document.getElementById('btn-open');
  const btnFile       = document.getElementById('btn-file');
  const btnTerminal   = document.getElementById('btn-terminal');
  const btnModel      = document.getElementById('btn-model');
  const btnApiKey     = document.getElementById('btn-apikey');
  const btnClrLog     = document.getElementById('btn-clrlog');
  const btnSettings   = document.getElementById('btn-settings');
  const btnInfo       = document.getElementById('btn-info');
  const btnClrAllCtx  = document.getElementById('btn-clr-all-ctx');
  const btnPreview    = document.getElementById('btn-preview');
  const previewPanel  = document.getElementById('preview-panel');
  const pvSystem      = document.getElementById('pv-system');
  const pvPresetBadge = document.getElementById('pv-preset-badge');
  const pvCtxRows     = document.getElementById('pv-ctx-rows');
  const pvEmptyNote   = document.getElementById('pv-empty-note');
  const pvPromptEcho  = document.getElementById('pv-prompt-echo');
  const pvStats       = document.getElementById('pv-stats');
  const chatView      = document.getElementById('chat-view');
  const infoView      = document.getElementById('info-view');
  const settingsView  = document.getElementById('settings-view');
  const ivSysPrompt   = document.getElementById('iv-system-prompt-text');
  // settings view
  const svSysprompt   = document.getElementById('sv-sysprompt');
  const svResetPrompt = document.getElementById('sv-reset-prompt');
  const svSavePrompt  = document.getElementById('sv-save-prompt');
  const svPromptSaved = document.getElementById('sv-prompt-saved');
  const svPresetList  = document.getElementById('sv-preset-list');
  const svAddPreset   = document.getElementById('sv-add-preset');
  const svPresetForm  = document.getElementById('sv-preset-form');
  const svFormName    = document.getElementById('sv-form-name');
  const svFormContent = document.getElementById('sv-form-content');
  const svFormCancel  = document.getElementById('sv-form-cancel');
  const svFormSave    = document.getElementById('sv-form-save');
  const svBlocklist    = document.getElementById('sv-blocklist');
  const svAllowlist    = document.getElementById('sv-allowlist');
  const svSaveFilters  = document.getElementById('sv-save-filters');
  const svResetFilters = document.getElementById('sv-reset-filters');
  const svFiltersSaved = document.getElementById('sv-filters-saved');
  const svRespectIgnore= document.getElementById('sv-respect-ignore');
  const svFpList       = document.getElementById('sv-fp-list');
  const svSaveFp       = document.getElementById('sv-save-fp');
  const svFpForm       = document.getElementById('sv-fp-form');
  const svFpName       = document.getElementById('sv-fp-name');
  const svFpCancel     = document.getElementById('sv-fp-cancel');
  const svFpSaveBtn    = document.getElementById('sv-fp-save-btn');
  const svMaxChars     = document.getElementById('sv-max-chars');
  const svSaveMaxChars = document.getElementById('sv-save-maxchars');
  const svResetMaxChars= document.getElementById('sv-reset-maxchars');
  const svMaxCharsSaved= document.getElementById('sv-maxchars-saved');

  // ── State ───────────────────────────────────────────────────────────────────
  let currentView  = 'chat';
  let waiting      = false;
  let previewOpen  = false;
  let contexts     = [];
  let nextId       = 0;
  let editingIndex = -1;  // -1 = adding new preset

  let systemPrompt   = ${jsSystemPrompt};
  let presets        = ${jsPresets};
  let blocklist      = ${jsBlocklist};
  let allowlist      = ${jsAllowlist};
  let extraTextExts  = ${jsExtraExts};
  let maxChars       = ${jsMaxChars};
  let filterProfiles = ${jsFilterProfiles};
  let respectIgnore  = ${jsRespectIgnore};
  const DEFAULT_SYSTEM_PROMPT = ${jsDefaultSys};
  const DEFAULT_MAX_CHARS = 40000;

  // ── View switching ──────────────────────────────────────────────────────────
  function showView(v) {
    currentView = v;
    chatView.classList.toggle('active', v === 'chat');
    infoView.classList.toggle('active', v === 'info');
    settingsView.classList.toggle('active', v === 'settings');
    btnInfo.classList.toggle('active', v === 'info');
    btnSettings.classList.toggle('active', v === 'settings');
  }

  btnInfo.addEventListener('click',     () => showView(currentView === 'info'     ? 'chat' : 'info'));
  btnSettings.addEventListener('click', () => showView(currentView === 'settings' ? 'chat' : 'settings'));
  document.querySelectorAll('.back-to-chat').forEach((btn) => btn.addEventListener('click', () => showView('chat')));

  // ── Model label ─────────────────────────────────────────────────────────────
  function setModel(label) {
    btnModel.textContent = '⊙ ' + label;
    modelLabel.textContent = label;
  }
  setModel('Haiku');

  // ── Info view ───────────────────────────────────────────────────────────────
  function syncInfoSystemPrompt() { ivSysPrompt.textContent = systemPrompt; }
  syncInfoSystemPrompt();

  // ── Settings view — system prompt ───────────────────────────────────────────
  function loadSettingsPrompt() { svSysprompt.value = systemPrompt; }
  loadSettingsPrompt();

  svResetPrompt.addEventListener('click', () => {
    svSysprompt.value = DEFAULT_SYSTEM_PROMPT;
  });

  svSavePrompt.addEventListener('click', () => {
    systemPrompt = svSysprompt.value.trim() || DEFAULT_SYSTEM_PROMPT;
    svSysprompt.value = systemPrompt;
    vscode.postMessage({ type: 'saveSystemPrompt', value: systemPrompt });
    syncInfoSystemPrompt();
    if (previewOpen) { renderPreview(); }
    // brief "Saved." notice
    svPromptSaved.style.display = 'inline';
    setTimeout(() => { svPromptSaved.style.display = 'none'; }, 1500);
  });

  // ── Settings view — presets ─────────────────────────────────────────────────
  function renderPresetList() {
    svPresetList.innerHTML = '';
    if (presets.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:0.82em;opacity:0.5;font-style:italic;padding:4px 0;';
      empty.textContent = 'No presets yet. Click + Add Preset to create one.';
      svPresetList.appendChild(empty);
      return;
    }
    presets.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'sv-preset-item';
      row.innerHTML =
        '<div class="sv-preset-info">' +
          '<div class="sv-preset-name">' + escHtml(p.name) + '</div>' +
          '<div class="sv-preset-preview">' + escHtml(p.content) + '</div>' +
        '</div>' +
        '<div class="sv-preset-actions">' +
          '<button class="tool-btn ghost" data-action="edit"   data-i="' + i + '" style="padding:2px 6px;font-size:0.85em;">Edit</button>' +
          '<button class="tool-btn ghost" data-action="delete" data-i="' + i + '" style="padding:2px 6px;font-size:0.85em;">✕</button>' +
        '</div>';
      svPresetList.appendChild(row);
    });
  }

  svPresetList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) { return; }
    const i = parseInt(btn.dataset.i);
    if (btn.dataset.action === 'delete') {
      presets.splice(i, 1);
      savePresetsToExtension();
      renderPresetList();
      refreshPresetSelect();
    } else if (btn.dataset.action === 'edit') {
      editingIndex = i;
      svFormName.value    = presets[i].name;
      svFormContent.value = presets[i].content;
      svPresetForm.classList.add('open');
      svFormName.focus();
    }
  });

  svAddPreset.addEventListener('click', () => {
    editingIndex = -1;
    svFormName.value    = '';
    svFormContent.value = '';
    svPresetForm.classList.add('open');
    svFormName.focus();
  });

  svFormCancel.addEventListener('click', () => {
    svPresetForm.classList.remove('open');
  });

  svFormSave.addEventListener('click', () => {
    const name    = svFormName.value.trim();
    const content = svFormContent.value.trim();
    if (!name || !content) { return; }
    if (editingIndex >= 0) {
      presets[editingIndex] = { name, content };
    } else {
      presets.push({ name, content });
    }
    svPresetForm.classList.remove('open');
    savePresetsToExtension();
    renderPresetList();
    refreshPresetSelect();
  });

  function savePresetsToExtension() {
    vscode.postMessage({ type: 'savePresets', presets });
  }

  // ── Settings view — file filters ────────────────────────────────────────────
  const svExtraExts = document.getElementById('sv-extra-exts');
  function loadFilters() {
    svBlocklist.value = blocklist.join('\\n');
    svAllowlist.value = allowlist.join('\\n');
    svExtraExts.value = extraTextExts.join('\\n');
    svRespectIgnore.checked = respectIgnore;
  }
  loadFilters();

  function parsePatterns(textarea) {
    return textarea.value.split('\\n').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('#'));
  }

  svRespectIgnore.addEventListener('change', () => {
    respectIgnore = svRespectIgnore.checked;
    vscode.postMessage({ type: 'saveRespectIgnore', value: respectIgnore });
  });

  svSaveFilters.addEventListener('click', () => {
    blocklist = parsePatterns(svBlocklist);
    allowlist = parsePatterns(svAllowlist);
    extraTextExts = svExtraExts.value.split('\\n').map((s) => s.trim().replace(/^\./, '')).filter((s) => s.length > 0);
    vscode.postMessage({ type: 'saveFilters', blocklist, allowlist, extraTextExts });
    svFiltersSaved.style.display = 'inline';
    setTimeout(() => { svFiltersSaved.style.display = 'none'; }, 1500);
  });

  svResetFilters.addEventListener('click', () => {
    svBlocklist.value = '';
    svAllowlist.value = '';
    svExtraExts.value = '';
  });

  // ── Settings view — filter profiles ────────────────────────────────────────
  function renderFpList() {
    svFpList.innerHTML = '';
    if (filterProfiles.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:0.82em;opacity:0.5;font-style:italic;padding:4px 0;';
      empty.textContent = 'No profiles yet. Click "↑ Save current filters as profile" to create one.';
      svFpList.appendChild(empty);
      return;
    }
    filterProfiles.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'sv-preset-item';
      row.innerHTML =
        '<div class="sv-preset-info">' +
          '<div class="sv-preset-name">' + escHtml(p.name) + '</div>' +
          '<div class="sv-preset-preview">Blocklist: ' + p.blocklist.length + ' pattern' + (p.blocklist.length !== 1 ? 's' : '') +
          ' · Allowlist: ' + p.allowlist.length + ' pattern' + (p.allowlist.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="sv-preset-actions">' +
          '<button class="tool-btn ghost" data-action="load"   data-i="' + i + '" style="padding:2px 6px;font-size:0.85em;">Load</button>' +
          '<button class="tool-btn ghost" data-action="delete" data-i="' + i + '" style="padding:2px 6px;font-size:0.85em;">✕</button>' +
        '</div>';
      svFpList.appendChild(row);
    });
  }
  renderFpList();

  svFpList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) { return; }
    const i = parseInt(btn.dataset.i);
    if (btn.dataset.action === 'load') {
      svBlocklist.value = filterProfiles[i].blocklist.join('\\n');
      svAllowlist.value = filterProfiles[i].allowlist.join('\\n');
      svFiltersSaved.style.display = 'inline';
      svFiltersSaved.textContent = 'Loaded — click Save to apply.';
      setTimeout(() => { svFiltersSaved.style.display = 'none'; svFiltersSaved.textContent = 'Saved.'; }, 2500);
    } else if (btn.dataset.action === 'delete') {
      filterProfiles.splice(i, 1);
      saveFilterProfiles();
      renderFpList();
    }
  });

  svSaveFp.addEventListener('click', () => {
    svFpName.value = '';
    svFpForm.classList.add('open');
    svFpName.focus();
  });

  svFpCancel.addEventListener('click', () => { svFpForm.classList.remove('open'); });

  svFpSaveBtn.addEventListener('click', () => {
    const name = svFpName.value.trim();
    if (!name) { return; }
    filterProfiles.push({ name, blocklist: parsePatterns(svBlocklist), allowlist: parsePatterns(svAllowlist) });
    svFpForm.classList.remove('open');
    saveFilterProfiles();
    renderFpList();
  });

  function saveFilterProfiles() {
    vscode.postMessage({ type: 'saveFilterProfiles', profiles: filterProfiles });
  }

  // ── Settings view — context limits ──────────────────────────────────────────
  function loadMaxChars() { svMaxChars.value = String(maxChars); }
  loadMaxChars();

  svSaveMaxChars.addEventListener('click', () => {
    const val = parseInt(svMaxChars.value, 10);
    if (!Number.isFinite(val) || val < 1) { return; }
    maxChars = val;
    vscode.postMessage({ type: 'saveMaxChars', value: maxChars });
    svMaxCharsSaved.style.display = 'inline';
    setTimeout(() => { svMaxCharsSaved.style.display = 'none'; }, 1500);
  });

  svResetMaxChars.addEventListener('click', () => {
    svMaxChars.value = String(DEFAULT_MAX_CHARS);
  });

  // ── Preset select in chat ───────────────────────────────────────────────────
  function refreshPresetSelect() {
    const current = presetSelect.value;
    while (presetSelect.options.length > 1) { presetSelect.remove(1); }
    presets.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    });
    // restore selection if still valid
    const idx = presets.findIndex((_, i) => String(i) === current);
    presetSelect.value = idx >= 0 ? String(idx) : '';
    if (previewOpen) { renderPreview(); }
  }

  function selectedPreset() {
    const val = presetSelect.value;
    if (!val) { return null; }
    return presets[parseInt(val)] ?? null;
  }

  // ── Context list ────────────────────────────────────────────────────────────
  function addContext(item) {
    contexts.push({ id: nextId++, ...item });
    renderCtxList();
    if (previewOpen) { renderPreview(); }
  }

  function removeContext(id) {
    contexts = contexts.filter((c) => c.id !== id);
    renderCtxList();
    if (previewOpen) { renderPreview(); }
  }

  function clearAllContexts() {
    contexts = [];
    renderCtxList();
    if (previewOpen) { renderPreview(); }
  }

  function renderCtxList() {
    ctxList.innerHTML = '';
    ctxHeader.classList.toggle('visible', contexts.length > 0);
    contexts.forEach((c) => {
      const lineCount = c.lineEnd - c.lineStart + 1;
      const metaText  = c.kind === 'selection'
        ? 'lines ' + c.lineStart + '–' + c.lineEnd + ' (' + lineCount + ')'
        : lineCount + ' lines';
      const row = document.createElement('div');
      row.className = 'ctx-item';
      row.innerHTML =
        '<span class="ctx-item-icon">' + (c.kind === 'selection' ? '✂' : c.kind === 'terminal' ? '>_' : '📄') + '</span>' +
        '<span class="ctx-item-name" title="' + escHtml(c.label) + '">' + escHtml(c.label) + '</span>' +
        '<span class="ctx-item-meta">' + metaText + '</span>' +
        '<button class="ctx-item-rm" title="Remove">✕</button>';
      row.querySelector('.ctx-item-rm').addEventListener('click', () => removeContext(c.id));
      ctxList.appendChild(row);
    });
  }

  // ── Preview ─────────────────────────────────────────────────────────────────
  function renderPreview() {
    const preset = selectedPreset();
    const effectiveSys = preset ? systemPrompt + '\\n\\n' + preset.content : systemPrompt;
    pvSystem.textContent = effectiveSys;
    pvPresetBadge.style.display = preset ? 'inline' : 'none';

    pvCtxRows.innerHTML = '';
    pvEmptyNote.style.display = contexts.length === 0 ? 'block' : 'none';
    contexts.forEach((c) => {
      const lineCount = c.lineEnd - c.lineStart + 1;
      const meta = c.kind === 'selection'
        ? 'lines ' + c.lineStart + '–' + c.lineEnd + ' (' + lineCount + ')'
        : lineCount + ' lines';
      const row = document.createElement('div');
      row.className = 'pv-ctx-row';
      row.innerHTML =
        '<span>' + (c.kind === 'selection' ? '✂' : c.kind === 'terminal' ? '>_' : '📄') + '</span>' +
        '<span class="pv-ctx-row-name">' + escHtml(c.label) + '</span>' +
        '<span class="pv-ctx-row-meta">' + meta + '</span>';
      pvCtxRows.appendChild(row);
    });

    const promptText = promptEl.value.trim();
    pvPromptEcho.textContent = promptText || '[type below]';

    const ctxChars   = contexts.reduce((s, c) => s + c.content.length, 0);
    const totalChars = effectiveSys.length + ctxChars + promptText.length;
    pvStats.textContent = '~' + totalChars.toLocaleString() + ' chars · ~' + Math.ceil(totalChars / 4).toLocaleString() + ' tokens est.';
  }

  btnPreview.addEventListener('click', () => {
    previewOpen = !previewOpen;
    previewPanel.classList.toggle('open', previewOpen);
    btnPreview.textContent = (previewOpen ? '▼' : '▶') + ' Preview full payload';
    if (previewOpen) { renderPreview(); }
  });

  promptEl.addEventListener('input', () => { if (previewOpen) { renderPreview(); } });
  presetSelect.addEventListener('change', () => { if (previewOpen) { renderPreview(); } });

  // ── Send ────────────────────────────────────────────────────────────────────
  function send() {
    if (waiting) { return; }
    const prompt = promptEl.value.trim();
    if (!prompt) { return; }

    const snapshot = contexts.slice();
    const preset   = selectedPreset();
    const ctxSummary = [
      ...(preset ? ['preset: ' + preset.name] : []),
      ...snapshot.map((c) => c.label),
    ].join(', ') || null;

    addMessage('user', prompt, ctxSummary);
    promptEl.value = '';
    clearAllContexts();

    waiting = true;
    btnSend.disabled = true;
    statusEl.textContent = 'Waiting…';

    vscode.postMessage({
      type: 'send', prompt,
      contexts: snapshot.map(({ label, content, kind, lineStart, lineEnd }) => ({ label, content, kind, lineStart, lineEnd })),
      preset: preset ? preset.content : undefined,
    });
  }

  // ── Log ─────────────────────────────────────────────────────────────────────
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

  // ── Events ───────────────────────────────────────────────────────────────────
  btnSend.addEventListener('click', send);
  btnSelection.addEventListener('click', () => vscode.postMessage({ type: 'getSelection' }));
  btnOpen.addEventListener('click',      () => vscode.postMessage({ type: 'listOpenFiles' }));
  btnFile.addEventListener('click',      () => vscode.postMessage({ type: 'pickFile' }));
  btnTerminal.addEventListener('click',  () => vscode.postMessage({ type: 'getTerminalOutput' }));
  btnModel.addEventListener('click',     () => vscode.postMessage({ type: 'selectModel' }));
  btnApiKey.addEventListener('click',    () => vscode.postMessage({ type: 'setApiKey' }));
  btnClrLog.addEventListener('click',    () => { logEl.innerHTML = ''; });
  btnClrAllCtx.addEventListener('click', clearAllContexts);

  promptEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  // ── Messages from extension ──────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if      (msg.type === 'response')       { waiting = false; btnSend.disabled = false; statusEl.textContent = ''; addMessage('assistant', msg.text, null); }
    else if (msg.type === 'addContext')     { addContext(msg.item); }
    else if (msg.type === 'modelChanged')   { setModel(msg.label); }
    else if (msg.type === 'openSettings')   { showView('settings'); if (msg.section === 'filters') { document.getElementById('sv-extra-exts')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
    else if (msg.type === 'updateSettings') {
      systemPrompt   = msg.systemPrompt;
      presets        = msg.presets;
      blocklist      = msg.blocklist ?? [];
      allowlist      = msg.allowlist ?? [];
      extraTextExts  = msg.extraTextExts ?? [];
      maxChars       = msg.maxChars ?? DEFAULT_MAX_CHARS;
      filterProfiles = msg.filterProfiles ?? [];
      respectIgnore  = msg.respectIgnore ?? true;
      loadSettingsPrompt();
      syncInfoSystemPrompt();
      renderPresetList();
      refreshPresetSelect();
      loadFilters();
      loadMaxChars();
      renderFpList();
      if (previewOpen) { renderPreview(); }
    }
  });

  // ── Init ────────────────────────────────────────────────────────────────────
  renderPresetList();
  refreshPresetSelect();

  // ── Utils ────────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
</script>
</body>
</html>`;
}

export function deactivate() {}
