#!/bin/sh
# Privateer installer — https://privateer.pro
#
#   curl -fsSL https://privateer.pro/install.sh | sh
#
# Installs the `privateer` terminal coding agent globally via npm.
# Requires Node.js >= 20 (the script checks, and points you at an installer
# if it's missing). No data leaves your machine; this only runs `npm install`.

set -eu

PKG="privateer-agent"
MIN_NODE_MAJOR=20

# --- pretty output (degrades to plain text when not a TTY) ----------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RESET=$(printf '\033[0m')
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s⚓ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

info "Installing Privateer"

# --- Node check -----------------------------------------------------------
if ! have node; then
  die "Node.js >= ${MIN_NODE_MAJOR} is required but 'node' was not found.
    Install it from https://nodejs.org (or 'brew install node', 'nvm install ${MIN_NODE_MAJOR}'),
    then re-run this installer."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node.js >= ${MIN_NODE_MAJOR} is required, but you have $(node -v).
    Upgrade from https://nodejs.org (or 'nvm install ${MIN_NODE_MAJOR}'), then re-run."
fi
ok "Node $(node -v) detected"

if ! have npm; then
  die "'npm' was not found. It normally ships with Node.js — reinstall Node from https://nodejs.org."
fi

# --- install --------------------------------------------------------------
say ""
info "Running: npm install -g ${PKG}"
say "${DIM}This may take a minute on first install.${RESET}"
say ""

if npm install -g "$PKG"; then
  :
else
  say ""
  warn "Global install failed — this is usually a permissions issue on the npm prefix."
  say  "Options:"
  say  "  • Re-run with a user-writable prefix:  npm config set prefix \"\$HOME/.npm-global\""
  say  "    then add \"\$HOME/.npm-global/bin\" to your PATH and retry."
  say  "  • Or skip installing and just run it on demand:  ${BOLD}npx ${PKG}${RESET}"
  die  "Installation did not complete."
fi

# --- verify ---------------------------------------------------------------
say ""
if have privateer; then
  ok "Installed $(privateer --version 2>/dev/null || echo "")"
  say ""
  say "${BOLD}Get started:${RESET}"
  say "  privateer                 ${DIM}# launch the interactive agent${RESET}"
  say "  privateer --onboard       ${DIM}# set up a provider / model${RESET}"
  say ""
  say "Bring your own key (e.g. ${BOLD}export OPENROUTER_API_KEY=sk-or-...${RESET}) or run ${BOLD}/login${RESET}"
  say "inside the app to bill inference to a Privateer account."
else
  warn "Installed, but 'privateer' isn't on your PATH yet."
  say  "Open a new terminal, or add your npm global bin to PATH:"
  say  "  ${DIM}export PATH=\"\$(npm prefix -g)/bin:\$PATH\"${RESET}"
fi
