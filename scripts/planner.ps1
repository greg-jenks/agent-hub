# Agent Hub — Planner Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\planner.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "planner"

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
Write-Host "  === PLANNER AGENT ===" -ForegroundColor Cyan
Write-Host "  Model: Claude Opus 4.6 (opencode)" -ForegroundColor DarkCyan
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    opencode --agent planner -m github-copilot/claude-opus-4.6
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Planner session ended. Terminal stays open." -ForegroundColor DarkCyan
    Write-Host ""
}
