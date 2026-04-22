#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Interfacer — uninstall from VS Code and clean build artifacts
# Usage: ./uninstall.sh [--keep-vsix] [--keep-deps]
#   --keep-vsix   Do not delete the packaged interfacer.vsix
#   --keep-deps   Do not delete node_modules/ or out/
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
EXTENSION_ID="interfacer.interfacer"
VSIX_FILE="interfacer.vsix"

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
    echo -e "${RED}Uninstall failed. See the message above.${NC}" >&2
    exit 1
}

# ── Argument parsing ──────────────────────────────────────────────────────────
KEEP_VSIX=false
KEEP_DEPS=false
for arg in "$@"; do
    case "$arg" in
        --keep-vsix) KEEP_VSIX=true ;;
        --keep-deps) KEEP_DEPS=true ;;
        --help|-h)
            echo "Usage: $0 [--keep-vsix] [--keep-deps]"
            echo "  --keep-vsix   Keep the packaged interfacer.vsix file"
            echo "  --keep-deps   Keep node_modules/ and out/ build artifacts"
            exit 0
            ;;
        *) die "Unknown argument: $arg" ;;
    esac
done

# ── Header ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}Interfacer — uninstall${NC}"
echo "Extension ID : $EXTENSION_ID"
echo "---"

# ── Step 1: Find VS Code CLI ──────────────────────────────────────────────────
log_section "Locating VS Code CLI"

CODE_CMD=""
for candidate in code code-insiders codium; do
    if command -v "$candidate" &>/dev/null; then
        CODE_CMD="$candidate"
        break
    fi
done

if [ -z "$CODE_CMD" ]; then
    log_warn "VS Code CLI not found in PATH — cannot uninstall via CLI."
    log_warn "Remove manually: Extensions view → Interfacer → gear icon → Uninstall"
    log_warn "Extension ID to look for: $EXTENSION_ID"
else
    log_info "Found CLI: $CODE_CMD"
fi

# ── Step 2: Uninstall from VS Code ────────────────────────────────────────────
if [ -n "$CODE_CMD" ]; then
    log_section "Uninstalling extension from VS Code"

    # Check if it's actually installed first
    if "$CODE_CMD" --list-extensions 2>/dev/null | grep -qi "^${EXTENSION_ID}$"; then
        if ! "$CODE_CMD" --uninstall-extension "$EXTENSION_ID"; then
            die "VS Code reported an error while uninstalling $EXTENSION_ID.
       Try manually: Extensions view → Interfacer → Uninstall"
        fi
        log_info "Extension $EXTENSION_ID uninstalled."
    else
        log_warn "Extension $EXTENSION_ID does not appear to be installed — skipping."
    fi
fi

# ── Step 3: Remove build artifacts ───────────────────────────────────────────
log_section "Cleaning build artifacts"

if [ "$KEEP_DEPS" = false ]; then
    if [ -d "out" ]; then
        rm -rf out/
        log_info "Removed out/"
    else
        log_warn "out/ not found — already clean."
    fi
    if [ -d "node_modules" ]; then
        rm -rf node_modules/
        log_info "Removed node_modules/"
    else
        log_warn "node_modules/ not found — already clean."
    fi
else
    log_info "--keep-deps: leaving out/ and node_modules/ in place."
fi

if [ "$KEEP_VSIX" = false ]; then
    if [ -f "$VSIX_FILE" ]; then
        rm -f "$VSIX_FILE"
        log_info "Removed $VSIX_FILE"
    else
        log_warn "$VSIX_FILE not found — already clean."
    fi
else
    log_info "--keep-vsix: leaving $VSIX_FILE in place."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✔ Uninstall complete.${NC}"
if [ -n "$CODE_CMD" ]; then
    echo -e "  Reload VS Code (Ctrl+Shift+P → 'Reload Window') to finish removing the extension."
fi
