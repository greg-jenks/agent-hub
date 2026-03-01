# Agent Hub — Planner Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\planner.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "planner"

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
