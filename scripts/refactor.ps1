# Agent Hub — Refactor Wrapper
# Posts status to the hub server on start/exit
# Usage: .\scripts\refactor.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "refactor"

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
Write-Host "  === REFACTOR AGENT ===" -ForegroundColor Yellow
Write-Host "  Model: Claude Sonnet 4.6 (opencode)" -ForegroundColor DarkYellow
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    opencode --agent refactor -m github-copilot/claude-sonnet-4.6
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Refactor session ended. Terminal stays open." -ForegroundColor DarkYellow
    Write-Host ""
}
