#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Interfacer — build from source and install into VS Code
# Usage: ./install.sh [--build-only]
#   --build-only   Package the .vsix but do not install it
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
EXTENSION_ID="interfacer.interfacer"
VSIX_FILE="interfacer.vsix"
# @vscode/vsce ^3.x and its deps require Node >= 20.
# Node 18 reached EOL in April 2025 — upgrade via nvm or NodeSource.
MIN_NODE_MAJOR=20

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_section() { echo -e "\n${CYAN}${BOLD}▶ $*${NC}"; }
die() {
    log_error "$*"
    echo -e "${RED}Installation failed. See the message above for details.${NC}" >&2
    exit 1
}

# ── Argument parsing ──────────────────────────────────────────────────────────
BUILD_ONLY=false
PROFILE=""
for arg in "$@"; do
    case "$arg" in
        --build-only) BUILD_ONLY=true ;;
        --profile=*) PROFILE="${arg#--profile=}" ;;
        --help|-h)
            echo "Usage: $0 [--build-only] [--profile=<name>]"
            echo "  --build-only       Build and package the .vsix without installing it"
            echo "  --profile=<name>   Install into a specific VS Code profile (default: default profile)"
            echo ""
            echo "  Non-default profiles require --profile or manual install via:"
            echo "  Extensions view → '...' → 'Install from VSIX…'"
            exit 0
            ;;
        *) die "Unknown argument: $arg" ;;
    esac
done

# ── Header ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Interfacer — install from source${NC}"
echo "Extension ID : $EXTENSION_ID"
echo "Output file  : $VSIX_FILE"
echo "Build only   : $BUILD_ONLY"
echo "Profile      : ${PROFILE:-default}"
echo "---"

# ── Step 1: Check prerequisites ───────────────────────────────────────────────
log_section "Checking prerequisites"

# Node.js
if ! command -v node &>/dev/null; then
    die "node is not installed or not in PATH.
       Install Node.js >= ${MIN_NODE_MAJOR} from https://nodejs.org
       On Ubuntu/Debian: sudo apt-get install nodejs
       Via nvm:          curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash"
fi
NODE_VERSION_FULL=$(node --version)
NODE_MAJOR=$(echo "$NODE_VERSION_FULL" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node.js >= ${MIN_NODE_MAJOR} is required, but found $NODE_VERSION_FULL.
       Node 18 reached end-of-life in April 2025. Please upgrade:

       Option A — nvm (recommended, no sudo needed):
         curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash
         source ~/.bashrc   # or restart your shell
         nvm install ${MIN_NODE_MAJOR}
         nvm use ${MIN_NODE_MAJOR}

       Option B — NodeSource APT repository:
         curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | sudo -E bash -
         sudo apt-get install -y nodejs"
fi
log_info "node $NODE_VERSION_FULL — OK"

# npm
if ! command -v npm &>/dev/null; then
    die "npm is not installed. It normally ships with Node.js.
       Try: sudo apt-get install npm"
fi
log_info "npm $(npm --version) — OK"

# VS Code CLI (only required if not build-only)
CODE_CMD=""
if [ "$BUILD_ONLY" = false ]; then
    for candidate in code code-insiders codium; do
        if command -v "$candidate" &>/dev/null; then
            CODE_CMD="$candidate"
            break
        fi
    done
    if [ -z "$CODE_CMD" ]; then
        die "VS Code CLI ('code') not found in PATH.
       Possible fixes:
         • Open VS Code → Ctrl+Shift+P → 'Shell Command: Install code in PATH'
         • Or run this script with --build-only, then install the .vsix manually:
             Extensions view → '...' menu → 'Install from VSIX…'
         • Snap installs: ensure /snap/bin is in your PATH"
    fi
    log_info "$CODE_CMD $(${CODE_CMD} --version 2>/dev/null | head -1) — OK"
fi

# ── Step 2: Install npm dependencies ─────────────────────────────────────────
log_section "Installing npm dependencies"

if ! npm install; then
    die "npm install failed.
       Common causes:
         • No internet connection
         • Corrupt node_modules — try: rm -rf node_modules package-lock.json && npm install
         • Permission issues   — do NOT use sudo; fix ownership instead"
fi
log_info "npm install — OK"

# ── Step 3: Compile TypeScript ────────────────────────────────────────────────
log_section "Compiling TypeScript"

if ! npm run compile; then
    die "TypeScript compilation failed.
       Check the errors above. Common causes:
         • Type errors introduced by a recent edit
         • Outdated @types/vscode — try: npm update @types/vscode
         • Wrong tsconfig.json   — compare with the original in the repo"
fi
log_info "TypeScript compile — OK"

# ── Step 4: Package the extension ─────────────────────────────────────────────
log_section "Packaging extension (.vsix)"

VSCE="./node_modules/.bin/vsce"
if [ ! -x "$VSCE" ]; then
    die "@vscode/vsce not found at $VSCE.
       It should have been installed in Step 2. Try running: npm install"
fi

if ! "$VSCE" package --no-dependencies --allow-missing-repository --out "$VSIX_FILE"; then
    die "vsce packaging failed.
       Common causes:
         • Missing 'publisher' field in package.json (should be 'interfacer')
         • Missing required fields (name, version, engines.vscode)
         • The 'main' file (out/extension.js) doesn't exist — did Step 3 succeed?"
fi

VSIX_SIZE=$(du -sh "$VSIX_FILE" 2>/dev/null | cut -f1)
log_info "Packaged → $VSIX_FILE ($VSIX_SIZE)"

# ── Step 5: Install into VS Code ──────────────────────────────────────────────
if [ "$BUILD_ONLY" = true ]; then
    echo ""
    log_info "Build-only mode — skipping install."
    log_info "To install manually:"
    log_info "  code --install-extension $VSIX_FILE"
    log_info "  — or — Extensions view → '...' → 'Install from VSIX…'"
    exit 0
fi

log_section "Installing extension into VS Code"

PROFILE_FLAG=()
if [ -n "$PROFILE" ]; then
    PROFILE_FLAG=(--profile "$PROFILE")
    log_info "Target profile: $PROFILE"
else
    log_warn "No --profile specified — installing into the default profile."
    log_warn "If you use a non-default profile, re-run with --profile=<name>"
    log_warn "or install manually: Extensions view → '...' → 'Install from VSIX…'"
fi

if ! "$CODE_CMD" "${PROFILE_FLAG[@]}" --install-extension "$VSIX_FILE" --force; then
    die "VS Code extension install failed.
       Try installing manually:
         $CODE_CMD ${PROFILE_FLAG[*]} --install-extension $VSIX_FILE
       Or via the UI: Extensions view → '...' menu → 'Install from VSIX…'"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✔ Interfacer installed successfully.${NC}"
echo -e "  Reload VS Code (Ctrl+Shift+P → 'Reload Window') to activate."
echo -e "  Extension ID: ${CYAN}$EXTENSION_ID${NC}"
echo -e "  To uninstall: ${CYAN}./uninstall.sh${NC}"
