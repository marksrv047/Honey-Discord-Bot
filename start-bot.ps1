# Honey Bot - Autonomous Server Runner (PowerShell)
# Runs independently of AntiGravity / VS Code
$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Honey Bot Server"

Write-Host "====================================================" -ForegroundColor Yellow
Write-Host "Honey Bot - Autonomous 24/7 Server Runner" -ForegroundColor Cyan
Write-Host "Running independently of AntiGravity / IDE" -ForegroundColor Gray
Write-Host "====================================================" -ForegroundColor Yellow

while ($true) {
    try {
        & node --dns-result-order=ipv4first bot.js
    } catch {
        Write-Host "Fatal execution error: $_" -ForegroundColor Red
    }
    Write-Host "`n[HONEY BOT] Process stopped. Restarting in 5 seconds (Press Ctrl+C to stop)..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

