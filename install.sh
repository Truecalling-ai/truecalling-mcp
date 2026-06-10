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
#   3. Ensures git, then clones (or pulls) the server to ~/.truecalling-mcp.
#      The repo ships a committed self-contained bundle — NO npm install — so
#      this works behind corporate TLS proxies that break esbuild downloads.
#   4. Locates ~/.claude.json (creates an empty stub if missing) and backs it
#      up with a timestamp.
#   5. Merges a `truecalling` entry into `mcpServers` (command = node run.mjs,
#      which git-pulls + runs the bundle). Preserves other entries; re-runnable.
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

# ----- 3. Pre-check git -----------------------------------------------------
#
# We clone the repo (which ships a committed, self-contained bundle) and the
# launcher `git pull`s it on every start, so git is required. On a fresh macOS,
# `git` triggers the Xcode CLI Tools GUI installer the first time it's invoked
# — surface that early so install doesn't fail mid-clone.

if ! command -v git >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ]; then
    yellow "  git is not yet installed. Triggering the Xcode Command Line Tools installer…"
    yellow "  A macOS dialog will appear. Click 'Install' and wait until it finishes, then re-run this script."
    xcode-select --install 2>/dev/null || true
    fail "git is required (used to clone + auto-update the MCP server). Re-run after the Xcode CLI Tools install finishes."
  else
    fail "git is required but not installed. Install it (e.g. 'sudo apt install git') and re-run."
  fi
fi

# ----- 3b. Clone (or update) the self-contained server ----------------------
#
# The repo commits a bundled dist/index.js with every dependency inlined, so
# there is NO `npm install` — that kills both the npx cache staleness AND the
# corporate-TLS-on-npm failures. The launcher (run.mjs) `git pull`s this clone
# on each start, so clients auto-update on reload.

INSTALL_DIR="${HOME}/.truecalling-mcp"
REPO_URL="https://github.com/Truecalling-ai/truecalling-mcp.git"

if [ -d "${INSTALL_DIR}/.git" ]; then
  bold "→ Updating existing TrueCalling MCP clone at ${INSTALL_DIR}…"
  # Force-sync to origin/main (reset --hard, not pull --ff-only) so a clone that
  # drifted — rebuilt dist or CRLF churn — still updates instead of failing.
  if git -C "$INSTALL_DIR" fetch --quiet origin main >&2; then
    git -C "$INSTALL_DIR" reset --hard --quiet origin/main >&2 || yellow "  (could not fast-sync — keeping the existing clone)"
  else
    yellow "  (fetch failed — keeping the existing clone)"
  fi
else
  bold "→ Cloning the TrueCalling MCP server to ${INSTALL_DIR}…"
  rm -rf "$INSTALL_DIR"
  if ! git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" >&2; then
    fail "git clone failed. Check your network (or corporate proxy) and retry."
  fi
fi

RUN_MJS="${INSTALL_DIR}/run.mjs"
if [ ! -f "$RUN_MJS" ]; then
  fail "Clone succeeded but ${RUN_MJS} is missing. Report this to the TrueCalling team."
fi
green "✓ Server ready at ${RUN_MJS}"

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

TC_NODE_BIN="$NODE_BIN" TC_RUN_MJS="$RUN_MJS" "$NODE_BIN" - "$CLAUDE_JSON" <<'NODE_SCRIPT'
const fs = require('fs');
const nodePath = require('path');
const path = process.argv[2];
const nodeBin = process.env.TC_NODE_BIN;
const runMjs = process.env.TC_RUN_MJS;
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
// node's own directory + standard system dirs. The launcher (run.mjs) shells
// out to `git pull`, and VS Code spawns the MCP child with a minimal PATH, so
// put node's dir + the dirs where git lives on PATH for it to resolve.
const nodeDir = nodePath.dirname(nodeBin);
json.mcpServers.truecalling = {
  type: 'stdio',
  // Absolute node + absolute path to the launcher. run.mjs git-pulls its own
  // clone (auto-update) then runs the committed self-contained bundle. No npx,
  // no npm install, no cache — sidesteps both the stale-version and the
  // corporate-TLS-on-npm problems.
  command: nodeBin,
  args: [runMjs],
  // PATH so run.mjs's `git pull` resolves under the minimal child environment.
  env: { PATH: nodeDir + ':/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' },
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
