# Agent Hub — Coder Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\coder.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "coder"

function Post-Status {
    param([string]$State, [string]$Message)
    try {
        $body = @{ agent = $Agent; state = $State; message = $Message } | ConvertTo-Json -Compress
        $null = Invoke-RestMethod -Uri $HubUrl -Method Post -Body $body -ContentType "application/json" -TimeoutSec 5
        Write-Host "  [hub] $Agent -> $State" -ForegroundColor DarkGray
    } catch {
        Write-Host "  [hub] Failed to post status: $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "  === CODER AGENT ===" -ForegroundColor Magenta
Write-Host "  Model: (detected from session)" -ForegroundColor DarkMagenta
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    gh copilot -- --model gpt-5.3-codex
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Coder session ended. Terminal stays open." -ForegroundColor DarkMagenta
    Write-Host ""
}
