# Agent Hub — Reviewer Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\reviewer.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "reviewer"

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
Write-Host "  === REVIEWER AGENT ===" -ForegroundColor Green
Write-Host "  Model: Claude Opus 4.6 (opencode)" -ForegroundColor DarkGreen
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    opencode --agent reviewer -m github-copilot/claude-opus-4.6
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Reviewer session ended. Terminal stays open." -ForegroundColor DarkGreen
    Write-Host ""
}
