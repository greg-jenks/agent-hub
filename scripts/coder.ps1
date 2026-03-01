# Agent Hub — Coder Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\coder.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "coder"

function Post-Status {
    param([string]$State, [string]$Message)
    try {
        $body = @{ agent = $Agent; state = $State; message = $Message } | ConvertTo-Json
        Invoke-RestMethod -Uri $HubUrl -Method Post -Body $body -ContentType "application/json" -ErrorAction SilentlyContinue | Out-Null
    } catch {
        # Hub might not be running — that's OK
    }
}

Write-Host ""
Write-Host "  === CODER AGENT ===" -ForegroundColor Magenta
Write-Host "  Model: GPT-5.2 Codex (gh copilot)" -ForegroundColor DarkMagenta
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    gh copilot -- --model gpt-5.2-codex
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Coder session ended. Terminal stays open." -ForegroundColor DarkMagenta
    Write-Host ""
}
