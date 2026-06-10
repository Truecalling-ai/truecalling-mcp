# ----------------------------------------------------------------------------
# TrueCalling MCP - one-liner installer for Windows.
#
# Usage (in a regular PowerShell window - no admin needed):
#   iwr -useb https://raw.githubusercontent.com/Truecalling-ai/truecalling-mcp/main/install.ps1 | iex
#
# (`iwr` = Invoke-WebRequest, `iex` = Invoke-Expression - equivalent to the
# `curl ... | bash` pattern on macOS/Linux.)
#
# What it does (idempotent - safe to re-run):
#   1. Detects Node.js >= 20 via Get-Command.
#   2. If missing or too old, bootstraps Node WITHOUT admin:
#        - try `winget install OpenJS.NodeJS.LTS` (may prompt UAC for MSI)
#        - on failure, fall back to the portable Node.js zip from nodejs.org
#          extracted to $env:LOCALAPPDATA\truecalling-mcp\node (no UAC).
#   3. Refreshes $env:PATH for the current session so subsequent calls work.
#   4. Ensures git, then clones (or pulls) the server to
#      %LOCALAPPDATA%\truecalling-mcp\repo. The repo ships a committed
#      self-contained bundle - NO npm install - so this works behind corporate
#      TLS proxies that break esbuild downloads.
#   5. Backs up ~/.claude.json with a timestamp and merges the truecalling
#      entry (command = node.exe run.mjs, which git-pulls + runs the bundle).
#   6. Prints "now reload Claude Code" instructions.
# ----------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ can treat ANY native-command stderr as a terminating error.
# git writes normal progress ("Cloning into...") to stderr, so without this a
# perfectly successful clone would throw. Decide success from $LASTEXITCODE
# instead. (Harmless no-op on Windows PowerShell 5.1.)
$PSNativeCommandUseErrorActionPreference = $false

# Force TLS 1.2 - Windows PowerShell 5.1 defaults to SSL3/TLS1, which
# nodejs.org / github.com reject.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$NodeMinMajor = 20
$NodeVersion  = '22.11.0'
$Backup       = $null

function Write-Bold   { param([string]$Msg) Write-Host $Msg -ForegroundColor Cyan }
function Write-OK     { param([string]$Msg) Write-Host $Msg -ForegroundColor Green }
function Write-Warn   { param([string]$Msg) Write-Host $Msg -ForegroundColor Yellow }
function Write-Err    { param([string]$Msg) Write-Host $Msg -ForegroundColor Red }

function Fail {
    param([string]$Msg)
    Write-Err "X $Msg"
    if ($script:Backup) {
        Write-Host "  Your previous config is safe at: $script:Backup"
    }
    exit 1
}

Write-Bold "Installing the TrueCalling MCP server for Claude Code..."
Write-Host ""

# ----- Helpers -------------------------------------------------------------

function Get-NodeMajor {
    param([string]$NodeExe)
    if (-not (Test-Path $NodeExe)) { return 0 }
    try {
        $ver = & $NodeExe -p 'process.versions.node' 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $ver) { return 0 }
        return [int](($ver -split '\.')[0])
    } catch {
        return 0
    }
}

function Find-UsableNode {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $major = Get-NodeMajor $cmd.Source
    if ($major -ge $NodeMinMajor) { return $cmd.Source }
    return $null
}

function Get-NodeArch {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default {
            Fail "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE (need AMD64 or ARM64). Install Node.js 20+ manually from https://nodejs.org and re-run."
        }
    }
}

function Install-PortableNode {
    param([string]$Arch)

    $folder      = "node-v$NodeVersion-win-$Arch"
    $zipName     = "$folder.zip"
    $url         = "https://nodejs.org/dist/v$NodeVersion/$zipName"
    $installRoot = Join-Path $env:LOCALAPPDATA 'truecalling-mcp\node'
    $nodeDir     = Join-Path $installRoot $folder
    $nodeExe     = Join-Path $nodeDir 'node.exe'

    if (Test-Path $nodeExe) {
        Write-OK "+ Portable Node.js already installed at $nodeExe"
        return $nodeExe
    }

    Write-Warn "  Downloading Node.js v$NodeVersion ($Arch) - about 30 MB..."
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    $zipPath = Join-Path $env:TEMP $zipName

    $oldPref = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'  # ~10x faster IWR
    try {
        Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    } catch {
        Fail "Download failed: $($_.Exception.Message)"
    } finally {
        $ProgressPreference = $oldPref
    }

    Write-Warn "  Extracting..."
    try {
        Expand-Archive -Path $zipPath -DestinationPath $installRoot -Force
    } catch {
        Fail "Extraction failed: $($_.Exception.Message). Antivirus may have quarantined the zip."
    }
    Remove-Item $zipPath -ErrorAction SilentlyContinue

    if (-not (Test-Path $nodeExe)) {
        Fail "Extraction completed but node.exe not found at $nodeExe."
    }
    Write-OK "+ Installed portable Node.js v$NodeVersion -> $nodeExe"
    return $nodeExe
}

function Refresh-PathFromRegistry {
    # Rebuild $env:PATH from machine + user environment so a freshly installed
    # winget/MSI Node becomes visible without restarting PowerShell.
    # NB: `-join` binds tighter than the comma operator, so without the
    # explicit array wrap PowerShell would parse `$machine, ($user -join ';')`
    # and silently drop the machine PATH.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:PATH = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

# ----- 1. Find existing usable Node ----------------------------------------

$absNode = Find-UsableNode
if ($absNode) {
    $existingVer = & $absNode -p 'process.versions.node' 2>$null
    Write-OK "+ Node.js v$existingVer detected at $absNode"
}

# ----- 2. Bootstrap Node if needed -----------------------------------------

if (-not $absNode) {
    $arch = Get-NodeArch

    # Strategy A: winget (may trigger UAC, that's fine - it's the standard way).
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    $wingetOk  = $false
    if ($wingetCmd) {
        Write-Bold "-> Installing Node.js via winget..."
        try {
            & winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>&1 | Out-Host
            if ($LASTEXITCODE -eq 0) {
                Refresh-PathFromRegistry
                $absNode = Find-UsableNode
                if ($absNode) {
                    Write-OK "+ Node.js installed via winget at $absNode"
                    $wingetOk = $true
                }
            }
        } catch {
            # Fall through to portable.
        }
        if (-not $wingetOk) {
            Write-Warn "  winget install did not complete successfully - falling back to the portable zip."
        }
    } else {
        Write-Warn "  winget not available - using the portable zip (no admin needed)."
    }

    # Strategy B: portable zip (no admin, no UAC).
    if (-not $absNode) {
        $absNode = Install-PortableNode -Arch $arch
    }
}

if (-not $absNode -or -not (Test-Path $absNode)) {
    Fail "Could not bootstrap Node.js. Install Node 20+ manually from https://nodejs.org and re-run."
}

# Re-check version on the final binary.
$finalMajor = Get-NodeMajor $absNode
if ($finalMajor -lt $NodeMinMajor) {
    Fail "Bootstrapped Node.js is v$finalMajor (need v$NodeMinMajor+)."
}

# ----- 3. Ensure git, then clone/update the self-contained server ----------
#
# The repo commits a bundled dist/index.js with every dependency inlined, so
# there is NO npm install - that kills both the npx cache staleness AND the
# corporate-TLS-on-npm failures. run.mjs git-pulls this clone on each start.

$nodeDir = Split-Path $absNode -Parent

$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Fail "git is required (used to clone + auto-update the MCP server) but was not found. Install Git for Windows from https://git-scm.com/download/win and re-run."
}
$gitDir = Split-Path $gitCmd.Source -Parent

$InstallDir = Join-Path $env:LOCALAPPDATA 'truecalling-mcp\repo'
$RepoUrl    = 'https://github.com/Truecalling-ai/truecalling-mcp.git'

if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Bold "-> Updating existing TrueCalling MCP clone at $InstallDir..."
    & git -C $InstallDir pull --ff-only --quiet 2>&1 | Out-Host
} else {
    Write-Bold "-> Cloning the TrueCalling MCP server to $InstallDir..."
    if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir -Parent) | Out-Null
    & git clone --depth 1 $RepoUrl $InstallDir 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Fail "git clone failed. Check your network (or corporate proxy) and retry."
    }
}

$RunMjs = Join-Path $InstallDir 'run.mjs'
if (-not (Test-Path $RunMjs)) {
    Fail "Clone succeeded but $RunMjs is missing. Report this to the TrueCalling team."
}
Write-OK "+ Server ready at $RunMjs"

# ----- 4. Locate ~/.claude.json --------------------------------------------

$ClaudeJson = Join-Path $HOME '.claude.json'
if (-not (Test-Path $ClaudeJson)) {
    Write-Warn "  ~/.claude.json not found - creating an empty one."
    # Write UTF-8 WITHOUT BOM. `Out-File -Encoding utf8` on Windows PS 5.1
    # emits a BOM that breaks downstream JSON parsing on some clients.
    [System.IO.File]::WriteAllText(
        $ClaudeJson, '{}',
        (New-Object System.Text.UTF8Encoding($false))
    )
}

$timestamp = Get-Date -Format 'yyyyMMddHHmmss'
$Backup    = "$ClaudeJson.bak.$timestamp"
$script:Backup = $Backup
Copy-Item $ClaudeJson $Backup
Write-OK "+ Backed up existing config -> $Backup"

# ----- 5. Merge the truecalling entry safely via the bundled Node ----------

# Pass paths via env vars to dodge the quoting/escaping nightmare.
$env:TC_CLAUDE_JSON = $ClaudeJson
$env:TC_NODE_EXE    = $absNode
$env:TC_RUN_MJS     = $RunMjs
# PATH for the spawned launcher so its `git pull` resolves (node dir + git dir
# + the current PATH).
$env:TC_PATH        = "$nodeDir;$gitDir;$env:PATH"

$nodeScript = @'
const fs = require('fs');
const p = process.env.TC_CLAUDE_JSON;
// Defensive BOM strip — PS5.1 `Out-File -Encoding utf8` writes a BOM that
// breaks JSON.parse. Strip any leading U+FEFF before parsing.
const raw = (fs.readFileSync(p, 'utf8') || '{}').replace(/^﻿/, '');
let json;
try { json = JSON.parse(raw); }
catch (e) {
  console.error('  ! Could not parse ' + p + ': ' + e.message);
  console.error('  ! Edit it manually or restore from the backup we just made.');
  process.exit(2);
}
json.mcpServers = json.mcpServers || {};
const existed = !!json.mcpServers.truecalling;
json.mcpServers.truecalling = {
  type: 'stdio',
  // node.exe + the launcher. run.mjs git-pulls its own clone (auto-update)
  // then runs the committed self-contained bundle. No npx, no npm install.
  command: process.env.TC_NODE_EXE,
  args: [process.env.TC_RUN_MJS],
  env: { PATH: process.env.TC_PATH }
};
// Atomic write: tmp + rename so a crash mid-write never corrupts claude.json.
const tmp = p + '.tmp.' + process.pid;
fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
fs.renameSync(tmp, p);
console.log(existed ? '  (Updated existing "truecalling" entry.)' : '  (Added a new "truecalling" entry.)');
'@

& $absNode -e $nodeScript
if ($LASTEXITCODE -ne 0) {
    Fail "Failed to update $ClaudeJson."
}
Write-OK "+ ~/.claude.json updated."

# ----- 6. Done -------------------------------------------------------------
Write-Host ""
Write-Bold "Almost there - one last thing:"
Write-Host ""
Write-Host "  In VS Code (or Claude Code Desktop), reload the window:"
Write-Host "    Ctrl + Shift + P  ->  Developer: Reload Window"
Write-Host ""
Write-Host "Then start a new conversation and say:"
Write-Host '  "Sign me in to TrueCalling with the tc_login tool."'
Write-Host '  "My email is X, my password is Y."'
Write-Host ""
Write-OK "All set."
