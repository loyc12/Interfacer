# ─────────────────────────────────────────────────────────────────────────────
# Interfacer — Makefile
# ─────────────────────────────────────────────────────────────────────────────
.PHONY: all build install uninstall clean help

VSIX := interfacer.vsix

all: install

## install   Build from source and install into VS Code (default)
install:
	@chmod +x install.sh
	@./install.sh

## build      Compile and package the .vsix without installing
build:
	@chmod +x install.sh
	@./install.sh --build-only

## uninstall  Uninstall from VS Code and remove build artifacts
uninstall:
	@chmod +x uninstall.sh
	@./uninstall.sh

## clean      Remove build artifacts without touching VS Code
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf out/ node_modules/ $(VSIX)
	@echo "Done."

## help       Show this message
help:
	@echo "Usage: make [target]"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/^## /  /'
