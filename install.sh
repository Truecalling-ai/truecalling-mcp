#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# TrueCalling MCP — one-liner installer for macOS / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.sh | bash
#
# What it does (idempotent — safe to re-run):
#   1. Detects Node.js >= 20 on PATH.
#   2. If missing or too old, bootstraps Node WITHOUT sudo:
#        - macOS + brew already installed → `brew install node`
#        - otherwise → install nvm and `nvm install --lts`
#   3. Resolves the ABSOLUTE path to node + npx (Claude Code's MCP child
#      processes inherit a minimal PATH — relative names break under VS Code
#      launched from Dock/Spotlight).
#   4. Locates ~/.claude.json (creates an empty stub if missing) and backs it
#      up with a timestamp.
#   5. Merges a `truecalling` entry into `mcpServers` via Node (preserves any
#      other entries; safe to re-run).
#   6. Prints a clear "now reload Claude Code" instruction.
# ----------------------------------------------------------------------------

set -euo pipefail

bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red()    { printf '\033[31m%s\033[0m\n' "$*"; }

NODE_MIN_MAJOR=20
BACKUP=""   # populated once we touch ~/.claude.json

fail() {
  red "✗ $*"
  if [ -n "$BACKUP" ]; then
    echo "  Your previous config is safe at: ${BACKUP}"
  fi
  exit 1
}

bold "Installing the TrueCalling MCP server for Claude Code…"
echo

# ----- Helpers -------------------------------------------------------------

# Portable absolute-directory resolution (no GNU realpath needed).
abs_dir_of() {
  local target="$1"
  ( cd "$(dirname "$target")" && pwd -P )
}

# Returns 0 if the candidate node binary is >= NODE_MIN_MAJOR.
node_version_ok() {
  local candidate="$1"
  [ -x "$candidate" ] || return 1
  local major
  major="$( "$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0 )"
  [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

# ----- 1. Find an existing usable Node -------------------------------------

NODE_BIN=""

if command -v node >/dev/null 2>&1; then
  CANDIDATE="$(command -v node)"
  if node_version_ok "$CANDIDATE"; then
    # Resolve to the real absolute path so symlink chains (asdf, nvm shims,
    # /usr/local/bin → Cellar) don't bite Claude Code's child env.
    NODE_DIR="$(abs_dir_of "$CANDIDATE")"
    NODE_BIN="${NODE_DIR}/node"
    green "✓ Node.js $("$NODE_BIN" --version) detected at ${NODE_BIN}"
  else
    EXISTING_MAJOR="$("$CANDIDATE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    yellow "  Found Node v${EXISTING_MAJOR} but we need v${NODE_MIN_MAJOR}+. Bootstrapping a newer one…"
  fi
fi

# ----- 2. Bootstrap Node if needed -----------------------------------------

if [ -z "$NODE_BIN" ]; then
  OS_NAME="$(uname -s)"

  # Strategy A: macOS with brew already installed (trusted, sudo-free).
  if [ "$OS_NAME" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    bold "→ Installing Node.js via Homebrew (already on system)…"
    if ! brew install node >&2; then
      yellow "  brew install node failed — falling back to nvm."
    else
      BREW_PREFIX="$(brew --prefix node 2>/dev/null || true)"
      if [ -n "$BREW_PREFIX" ] && node_version_ok "${BREW_PREFIX}/bin/node"; then
        NODE_BIN="${BREW_PREFIX}/bin/node"
      elif command -v node >/dev/null 2>&1 && node_version_ok "$(command -v node)"; then
        NODE_BIN="$(abs_dir_of "$(command -v node)")/node"
      fi
      if [ -n "$NODE_BIN" ]; then
        green "✓ Node.js $("$NODE_BIN" --version) installed via Homebrew."
      fi
    fi
  fi

  # Strategy B: nvm (writes to ~/.bashrc / ~/.zshrc — fine, that's standard).
  if [ -z "$NODE_BIN" ]; then
    bold "→ Installing Node.js via nvm (this takes ~30s)…"
    yellow "  Downloading nvm…"
    if ! curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >&2; then
      fail "Failed to download / run the nvm installer. Check your network and retry."
    fi

    # Source nvm into THIS shell so `nvm install` actually works right now.
    export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
    # shellcheck disable=SC1091
    if [ -s "${NVM_DIR}/nvm.sh" ]; then
      # `set -u` (nounset) interacts badly with nvm.sh — disable it just for sourcing.
      set +u
      # shellcheck disable=SC1090
      \. "${NVM_DIR}/nvm.sh"
      set -u
    else
      fail "nvm installed but ${NVM_DIR}/nvm.sh was not found."
    fi

    yellow "  Installing Node.js LTS via nvm…"
    set +u
    if ! nvm install --lts >&2; then
      set -u
      fail "nvm install --lts failed."
    fi
    nvm use --lts >&2 || true
    set -u

    if command -v node >/dev/null 2>&1 && node_version_ok "$(command -v node)"; then
      NODE_BIN="$(abs_dir_of "$(command -v node)")/node"
      green "✓ Node.js $("$NODE_BIN" --version) installed via nvm at ${NODE_BIN}"
    else
      fail "nvm install completed but no usable node binary was found."
    fi
  fi
fi

if [ -z "$NODE_BIN" ] || ! node_version_ok "$NODE_BIN"; then
  fail "Could not bootstrap Node.js. Install Node 20+ manually from https://nodejs.org and re-run."
fi

# ----- 3. Resolve absolute npx-cli.js path ---------------------------------
#
# We DELIBERATELY do NOT use the `npx` shell wrapper as `command`. That
# wrapper has `#!/usr/bin/env node` at the top — when VS Code spawns the
# MCP child with a minimal PATH (no `node`), the env-shebang fails to
# resolve and you get "executable not found in $PATH: npx".
#
# Instead we point `command` at the absolute path to `node` and prepend
# the absolute path to `npx-cli.js` (the JS that the wrapper would have
# run anyway) as the first arg. No PATH lookup, no env shebang.

NODE_DIR="$(dirname "$NODE_BIN")"
# npm's `npx-cli.js` lives at <node-prefix>/lib/node_modules/npm/bin/npx-cli.js
# but the node binary is typically at <node-prefix>/bin/node, so the lib dir
# is one level up + "lib/node_modules".
NODE_PREFIX="$(dirname "$NODE_DIR")"
NPX_CLI="${NODE_PREFIX}/lib/node_modules/npm/bin/npx-cli.js"

if [ ! -f "$NPX_CLI" ]; then
  # Hunt for it — some distros lay things out differently. First try beside
  # node, then a recursive find capped at depth 4 under the prefix.
  ALT="$(find "$NODE_PREFIX" -maxdepth 5 -name 'npx-cli.js' -type f 2>/dev/null | head -1)"
  if [ -n "$ALT" ]; then
    NPX_CLI="$ALT"
  else
    fail "Could not locate npx-cli.js under ${NODE_PREFIX}. Reinstall Node.js (npm ships with it) and retry."
  fi
fi

green "✓ Resolved npx-cli.js at ${NPX_CLI}"

# ----- 3b. Pre-check git (npx -y github:... shells out to git clone) --------
#
# On a fresh macOS, `git` triggers the Xcode CLI Tools GUI installer the
# first time it's invoked. Detect and surface early so the MCP doesn't
# silently 'connection closed' on first launch.

if ! command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ]; then
    yellow "  git is not yet installed. Triggering the Xcode Command Line Tools installer…"
    yellow "  A macOS dialog will appear. Click 'Install' and wait until it finishes, then re-run this script."
    xcode-select --install 2>/dev/null || true
    fail "git is required (used by npx to clone the MCP server). Re-run after the Xcode CLI Tools install finishes."
  else
    fail "git is required but not installed. Install it (e.g. 'sudo apt install git') and re-run."
  fi
fi

# ----- 4. Locate ~/.claude.json --------------------------------------------

CLAUDE_JSON="${HOME}/.claude.json"
if [ ! -f "$CLAUDE_JSON" ]; then
  yellow "  ~/.claude.json not found — creating an empty one."
  echo '{}' > "$CLAUDE_JSON"
fi

BACKUP="${CLAUDE_JSON}.bak.$(date +%Y%m%d%H%M%S)"
cp "$CLAUDE_JSON" "$BACKUP"
green "✓ Backed up existing config → ${BACKUP}"

# ----- 5. Merge the truecalling entry safely via Node ----------------------

TC_NODE_BIN="$NODE_BIN" TC_NPX_CLI="$NPX_CLI" "$NODE_BIN" - "$CLAUDE_JSON" <<'NODE_SCRIPT'
const fs = require('fs');
const path = process.argv[2];
const nodeBin = process.env.TC_NODE_BIN;
const npxCli = process.env.TC_NPX_CLI;
// Defensive BOM strip — some editors (and PowerShell on Windows) write a BOM
// that breaks JSON.parse. Belt-and-braces here even on Unix.
const raw = (fs.readFileSync(path, 'utf8') || '{}').replace(/^﻿/, '');
let json;
try { json = JSON.parse(raw); }
catch (e) {
  console.error('  ! Could not parse ' + path + ': ' + e.message);
  console.error('  ! Edit it manually or restore from the backup we just made.');
  process.exit(2);
}
json.mcpServers = json.mcpServers || {};
const existed = !!json.mcpServers.truecalling;
json.mcpServers.truecalling = {
  type: 'stdio',
  // Absolute path to node + absolute path to npx-cli.js as the first arg.
  // Sidesteps the env-node shebang inside the `npx` wrapper, which would
  // fail under VS Code's minimal child PATH.
  command: nodeBin,
  args: [npxCli, '-y', 'github:Truecalling-ai/truecalling-mcp'],
};
// Atomic write: tmp + rename so a crash mid-write never corrupts claude.json.
const tmp = path + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
fs.renameSync(tmp, path);
console.log(existed
  ? '  (Updated the existing "truecalling" entry.)'
  : '  (Added a new "truecalling" entry under mcpServers.)');
NODE_SCRIPT

green "✓ ~/.claude.json updated."

# ----- 6. Done -------------------------------------------------------------
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
