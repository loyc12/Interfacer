#!/usr/bin/env node
// Post-compile sanity check.
//
// The webview's <script> body lives inside a TS template literal in
// extension.ts, so any single backslash like \n, \*, \d gets silently
// processed by the template literal at runtime (NonEscapeCharacter rule).
// That has bitten us multiple times — the script silently breaks, the
// webview shows but no buttons work, and tsc gives no warning.
//
// This script reproduces what the runtime sees: it loads the compiled JS,
// extracts the webview HTML, pulls out the <script> block, and runs
// `node --check` on it. Exits non-zero on syntax error.
//
// Wired up via `package.json` → "compile" script (runs after tsc).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COMPILED = path.resolve(__dirname, '..', 'out', 'extension.js');
if (!fs.existsSync(COMPILED)) {
	console.error('[validate-webview] ' + COMPILED + ' not found — run tsc first.');
	process.exit(1);
}
const compiled = fs.readFileSync(COMPILED, 'utf8');

// Pull out DEFAULT_SYSTEM_PROMPT (multi-line concatenation in source) so we can
// invoke buildWebviewHtml in isolation.
const dspMatch = compiled.match(/const DEFAULT_SYSTEM_PROMPT = ([\s\S]*?);\n/);
if (!dspMatch) { console.error('[validate-webview] DEFAULT_SYSTEM_PROMPT not found'); process.exit(1); }

// Brace-match the buildWebviewHtml function body.
const fnStart = compiled.indexOf('function buildWebviewHtml');
if (fnStart < 0) { console.error('[validate-webview] buildWebviewHtml not found'); process.exit(1); }
let i = compiled.indexOf('{', fnStart);
let depth = 1, j = i + 1;
while (depth > 0 && j < compiled.length) {
	const ch = compiled[j];
	if (ch === '{') depth++;
	else if (ch === '}') depth--;
	j++;
}
const fnSrc = compiled.slice(fnStart, j);

// Wrap into a tiny module that exports buildWebviewHtml. We have to stub any
// module-scope identifiers buildWebviewHtml references — keep this list in
// sync when extension.ts adds new top-level state surfaced into the webview.
const wrapperPath = path.join(require('os').tmpdir(), 'interfacer-build-fn.js');
fs.writeFileSync(wrapperPath, [
	"const crypto = require('crypto');",
	'const DEFAULT_SYSTEM_PROMPT = ' + dspMatch[1] + ';',
	'const MODELS = [{ id: "x", label: "x", pricing: { input:1, output:1, cacheRead:0.1, cacheWrite:1.25 }, cacheMinTokens: 1024 }];',
	'let observedItpm = 50000;',
	'let sessionCostUsd = 0;',
	fnSrc,
	'module.exports = buildWebviewHtml;',
].join('\n'));

const buildFn = require(wrapperPath);
const SAMPLE_SETTINGS = {
	model: 'claude-haiku-4-5-20251001',
	apiKey: '', maxChars: 40000, maxOutputTokens: 8192,
	systemPrompt: 'sample',
	presets: [{ name: 'p', content: 'c' }],
	blocklist: [], allowlist: [], extraTextExts: [],
	respectIgnore: true, filterProfiles: [],
};
const html = buildFn(SAMPLE_SETTINGS);

// Extract the <script nonce="...">...</script> block.
const scriptMatch = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('[validate-webview] <script> block not found'); process.exit(1); }

const scriptPath = path.join(require('os').tmpdir(), 'interfacer-webview-script.js');
fs.writeFileSync(scriptPath, scriptMatch[1]);

try {
	execFileSync(process.execPath, ['--check', scriptPath], { stdio: 'pipe' });
	console.log('[validate-webview] OK (' + scriptMatch[1].length + ' bytes)');
} catch (e) {
	console.error('[validate-webview] WEBVIEW SCRIPT HAS A SYNTAX ERROR.');
	console.error('This usually means a single backslash inside the template literal got');
	console.error('stripped at runtime. See CLAUDE.md → "Webview script gotchas".');
	console.error('');
	console.error(e.stderr ? e.stderr.toString() : e.message);
	process.exit(1);
}
