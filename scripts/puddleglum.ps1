# Agent Hub — Puddleglum Wrapper
# Posts lifecycle status to the hub server on start/exit
# Model detection is automatic via OpenCode DB polling
# Usage: .\scripts\puddleglum.ps1

$HubUrl = "http://localhost:3747/status"
$Agent = "puddleglum"

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
Write-Host "  === PUDDLEGLUM ===" -ForegroundColor Red
Write-Host "  Pre-mortem analysis agent" -ForegroundColor DarkRed
Write-Host "  Activity streaming: via OpenCode DB" -ForegroundColor DarkGray
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    opencode --agent puddleglum
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Puddleglum session ended. Terminal stays open." -ForegroundColor DarkRed
    Write-Host ""
}
