# Runs BuildAPad ON YOUR OWN COMPUTER against Solana MAINNET, for a small real-money test. Nothing here touches Railway.
# Run from the repo folder in PowerShell:   .\mainnet-local.ps1
# It asks for two things and keeps them only in this window. Your wallet's key is never needed: Phantom signs everything.

$rpc = Read-Host "Paste your Helius MAINNET address (with your key)"
$fee = Read-Host "Paste a PUBLIC wallet address to receive the platform's fee share (not your test wallet)"
$rpc = $rpc.Trim().Trim('"').Trim("'")
$fee = $fee.Trim().Trim('"').Trim("'")
if (-not $rpc -or $rpc -match "devnet" -or $rpc -notmatch "^https://") { Write-Host "The RPC address must start with https:// and be a MAINNET address."; exit 1 }
if ($fee -notmatch "^[1-9A-HJ-NP-Za-km-z]{32,44}$") { Write-Host "That fee wallet is not a valid Solana address: [$fee]"; exit 1 }

$env:LAUNCH_CLUSTER   = "mainnet-beta"
$env:MAINNET_ENABLED  = "yes"
$env:LAUNCH_RPC_URL   = $rpc
$env:PAIRS_RPC_URL    = $rpc
$env:PLATFORM_FEE_WALLET = $fee
$env:PAIRS_LAUNCH     = "yes"
$env:PAIRS_TRADE     = "yes"
$env:HOLDER_REWARDS  = "yes"
$env:PORT             = "8080"
$env:DATA_DIR         = (Join-Path $PSScriptRoot "mainnet-data")
New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null

Write-Host ""
Write-Host "Starting on MAINNET. Open http://localhost:8080 in the browser where Phantom is installed."
Write-Host "Press Ctrl+C in this window to stop it."
npm install --no-fund --no-audit
node server.js
