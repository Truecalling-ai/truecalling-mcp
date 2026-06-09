# ----------------------------------------------------------------------------
# TrueCalling MCP — one-liner installer for Windows.
#
# Usage (in a regular PowerShell window — no admin needed):
#   iwr -useb https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.ps1 | iex
#
# (`iwr` = Invoke-WebRequest, `iex` = Invoke-Expression — equivalent to the
# `curl ... | bash` pattern on macOS/Linux.)
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

Write-Host "Installing the TrueCalling MCP server for Claude Code..." -ForegroundColor Cyan
Write-Host ""

# ----- 1. Node.js check ----------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "X Node.js is not installed (or not on PATH)." -ForegroundColor Red
    Write-Host "  Install Node.js 20 or newer from https://nodejs.org and re-run."
    exit 1
}

$nodeVersion = & node -p "process.versions.node"
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 20) {
    Write-Host "X Node.js v$nodeVersion is too old. We need v20+." -ForegroundColor Red
    Write-Host "  Upgrade Node.js (https://nodejs.org) and re-run."
    exit 1
}
Write-Host "+ Node.js v$nodeVersion detected." -ForegroundColor Green

# ----- 2. Locate ~/.claude.json -------------------------------------------
$ClaudeJson = Join-Path $HOME ".claude.json"
if (-not (Test-Path $ClaudeJson)) {
    Write-Host "  ~/.claude.json not found - creating an empty one." -ForegroundColor Yellow
    "{}" | Out-File -FilePath $ClaudeJson -Encoding utf8
}

$timestamp = Get-Date -Format "yyyyMMddHHmmss"
$Backup = "$ClaudeJson.bak.$timestamp"
Copy-Item $ClaudeJson $Backup
Write-Host "+ Backed up existing config -> $Backup" -ForegroundColor Green

# ----- 3. Merge the truecalling entry safely via Node ----------------------
$nodeScript = @'
const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8') || '{}';
let json;
try { json = JSON.parse(raw); }
catch (e) {
  console.error('  ! Could not parse ' + path + ': ' + e.message);
  process.exit(2);
}
json.mcpServers = json.mcpServers || {};
const existed = !!json.mcpServers.truecalling;
json.mcpServers.truecalling = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', 'github:Truecalling-ai/truecalling-mcp'],
};
fs.writeFileSync(path, JSON.stringify(json, null, 2));
console.log(existed ? '  (Updated existing "truecalling" entry.)' : '  (Added a new "truecalling" entry.)');
'@

& node -e $nodeScript $ClaudeJson
Write-Host "+ ~/.claude.json updated." -ForegroundColor Green

# ----- 4. Done -------------------------------------------------------------
Write-Host ""
Write-Host "Almost there - one last thing:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  In VS Code (or Claude Code Desktop), reload the window:"
Write-Host "    Ctrl + Shift + P  ->  Developer: Reload Window"
Write-Host ""
Write-Host "Then start a new conversation and say:"
Write-Host '  "Sign me in to TrueCalling with the tc_login tool."'
Write-Host '  "My email is X, my password is Y."'
Write-Host ""
Write-Host "All set." -ForegroundColor Green
