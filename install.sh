#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# TrueCalling MCP — one-liner installer for macOS / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.sh | bash
#
# What it does (idempotent — safe to re-run):
#   1. Checks that Node.js >= 20 is on PATH.
#   2. Locates ~/.claude.json (creates an empty stub if missing).
#   3. Merges a `truecalling` entry into `mcpServers` without touching anything
#      else (uses Node for safe JSON manipulation; falls back to a pure-bash
#      append only if Node is somehow absent — which would have failed step 1).
#   4. Prints a clear "now reload Claude Code" instruction.
# ----------------------------------------------------------------------------

set -euo pipefail

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }

bold "Installing the TrueCalling MCP server for Claude Code…"
echo

# ----- 1. Node.js check ----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  red "✗ Node.js is not installed (or not on PATH)."
  echo "  Install Node.js 20 or newer from https://nodejs.org and re-run."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  red "✗ Node.js v${NODE_MAJOR} is too old. We need v20+."
  echo "  Upgrade Node.js (https://nodejs.org) and re-run."
  exit 1
fi
green "✓ Node.js $(node --version) detected."

# ----- 2. Locate ~/.claude.json -------------------------------------------
CLAUDE_JSON="${HOME}/.claude.json"
if [ ! -f "${CLAUDE_JSON}" ]; then
  yellow "  ~/.claude.json not found — creating an empty one."
  echo '{}' > "${CLAUDE_JSON}"
fi

# Back it up — once, with timestamp — so accidental damage is recoverable.
BACKUP="${CLAUDE_JSON}.bak.$(date +%Y%m%d%H%M%S)"
cp "${CLAUDE_JSON}" "${BACKUP}"
green "✓ Backed up existing config → ${BACKUP}"

# ----- 3. Merge the truecalling entry safely via Node ----------------------
node - "$CLAUDE_JSON" <<'NODE_SCRIPT'
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8') || '{}';
let json;
try { json = JSON.parse(raw); }
catch (e) {
  console.error('  ! Could not parse ' + path + ': ' + e.message);
  console.error('  ! Edit it manually or restore from the backup we just made.');
  process.exit(2);
}
json.mcpServers = json.mcpServers || {};
const existing = json.mcpServers.truecalling;
json.mcpServers.truecalling = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'github:Truecalling-ai/truecalling-mcp'],
};
fs.writeFileSync(path, JSON.stringify(json, null, 2));
if (existing) {
  console.log('  (Updated the existing "truecalling" entry.)');
} else {
  console.log('  (Added a new "truecalling" entry under mcpServers.)');
}
NODE_SCRIPT

green "✓ ~/.claude.json updated."

# ----- 4. Done -------------------------------------------------------------
echo
bold "Almost there — one last thing:"
echo
echo "  In VS Code (or Claude Code Desktop), reload the window:"
echo "    macOS:        Cmd  + Shift + P  →  Developer: Reload Window"
echo "    Win / Linux:  Ctrl + Shift + P  →  Developer: Reload Window"
echo
echo "Then start a new conversation and say something like:"
echo "  «Connecte-moi à TrueCalling avec l'outil tc_login.»"
echo "  «My email is X, my password is Y.»"
echo
green "All set."
