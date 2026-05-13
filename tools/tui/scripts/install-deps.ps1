#Requires -Version 5.1
# install-deps.ps1 — install bun (if missing) and TUI npm dependencies
# Run from any directory:
#   powershell -ExecutionPolicy Bypass -File tools\tui\scripts\install-deps.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$BunBin = "$env:USERPROFILE\.bun\bin"
$BunExe = "$BunBin\bun.exe"

# ── 1. Ensure bun is available ────────────────────────────────────────────────

$bunInPath = $null -ne (Get-Command bun -ErrorAction SilentlyContinue)

if ($bunInPath) {
    $v = bun --version 2>&1
    Write-Host "bun already in PATH: $(Get-Command bun | Select-Object -ExpandProperty Source)  ($v)"
} elseif (Test-Path $BunExe) {
    Write-Host "bun found at $BunExe but not in PATH — adding for this session"
    $env:PATH = "$BunBin;$env:PATH"
    $v = bun --version 2>&1
    Write-Host "bun $v ready"
} else {
    Write-Host "Installing bun..."
    # Official Windows installer
    Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
    # The installer adds to PATH in the registry but not the current session
    $env:PATH = "$BunBin;$env:PATH"
    $v = bun --version 2>&1
    Write-Host "bun $v installed"
}

# ── 2. Persist bun in the user PATH (registry) ───────────────────────────────

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User") ?? ""

if ($userPath -notlike "*\.bun\bin*") {
    $newPath = "$BunBin;$userPath".TrimEnd(";")
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-Host "Added $BunBin to your user PATH (registry)."
    Write-Host "  Re-open any terminal window for it to take effect globally."
} else {
    Write-Host "bun PATH entry already present in user PATH (registry)"
}

# ── 3. Install npm dependencies ───────────────────────────────────────────────

$tuiDir = Split-Path -Parent $PSScriptRoot
Write-Host ""
Write-Host "Running: bun install  (in $tuiDir)"
Push-Location $tuiDir
try {
    bun install
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "All done.  To start the TUI:"
Write-Host "  cd tools\tui"
Write-Host "  bun run dev"
