# smoke-test.ps1 — Quick test of status-server.js
$ErrorActionPreference = "Stop"

Write-Host "`n=== Starting server ===" -ForegroundColor Cyan
$proc = Start-Process -FilePath "node" -ArgumentList "status-server.js" -WorkingDirectory "C:\Users\gjenks\Repos\agent-hub" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

try {
    Write-Host "`n=== GET /status ===" -ForegroundColor Green
    $status = Invoke-RestMethod -Uri "http://localhost:3747/status" -Method Get
    Write-Host ($status | ConvertTo-Json -Depth 5)

    Write-Host "`n=== POST /status (planner active) ===" -ForegroundColor Green
    $body = @{ agent = "planner"; state = "active"; message = "Smoke test session" } | ConvertTo-Json
    $postResult = Invoke-RestMethod -Uri "http://localhost:3747/status" -Method Post -Body $body -ContentType "application/json"
    Write-Host ($postResult | ConvertTo-Json)

    Write-Host "`n=== GET /status (after POST) ===" -ForegroundColor Green
    $status2 = Invoke-RestMethod -Uri "http://localhost:3747/status" -Method Get
    Write-Host ($status2 | ConvertTo-Json -Depth 5)

    Write-Host "`n=== GET /feed ===" -ForegroundColor Green
    $feed = Invoke-RestMethod -Uri "http://localhost:3747/feed" -Method Get
    Write-Host ($feed | ConvertTo-Json -Depth 3)

    Write-Host "`n=== POST /status (invalid agent - expect 400) ===" -ForegroundColor Green
    try {
        $badBody = @{ agent = "bogus"; state = "active"; message = "test" } | ConvertTo-Json
        Invoke-RestMethod -Uri "http://localhost:3747/status" -Method Post -Body $badBody -ContentType "application/json" -ErrorAction Stop
        Write-Host "ERROR: Should have rejected invalid agent!" -ForegroundColor Red
    } catch {
        Write-Host "Correctly rejected invalid agent (400)" -ForegroundColor Yellow
    }

    Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green
} finally {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Server stopped.`n"
}
