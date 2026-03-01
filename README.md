# Agent Hub

Live-updating dashboard + multi-agent terminal setup for orchestrating 4 AI coding agents with real-time status tracking, attention alerts, and color-coded Windows Terminal profiles.

## Agents

| Agent | Role | Tool | Model | Color |
|-------|------|------|-------|-------|
| Planner | Architecture, strategy, scoping | opencode | claude-opus-4.6 | Cyan |
| Coder | Implementation | gh copilot | gpt-5.3-codex | Purple |
| Reviewer | Bugs, security, quality | opencode | claude-opus-4.6 | Green |
| Refactor | Cleanup, patterns, tech debt | opencode | claude-sonnet-4.6 | Amber |

## Quick Start

### 1. Start the status server

```powershell
cd C:\Users\gjenks\Repos\agent-hub
npm start
```

Or from any terminal (PowerShell alias):

```powershell
agent-hub
```

The server runs on **http://localhost:3747**.

### 2. Open the dashboard

Navigate to **http://localhost:3747** in a browser. The dashboard uses SSE for live updates with automatic reconnect.

### 3. Launch agents

**Option A — Windows Terminal profiles:**
Open a new tab in Windows Terminal using the dropdown. You'll see 4 agent profiles (Planner, Coder, Reviewer, Refactor), each color-coded. Selecting one auto-launches the agent wrapper.

**Option B — PowerShell aliases:**
From any PowerShell terminal:

```powershell
planner    # launches Planner agent
coder      # launches Coder agent
reviewer   # launches Reviewer agent
refactor   # launches Refactor agent
```

**Option C — Direct script execution:**

```powershell
.\scripts\planner.ps1
.\scripts\coder.ps1
.\scripts\reviewer.ps1
.\scripts\refactor.ps1
```

## Architecture

```
agent-hub.html (browser, SSE stream + initial sync from localhost:3747)
    |  GET /stream, GET /status, GET /feed
status-server.js (Express, port 3747, serves HTML + JSON API)
    |  POST /status (from wrapper scripts), DB activity poller, periodic state flush
status.json + feed.json (periodic crash-recovery snapshots, gitignored)

PowerShell wrapper scripts  -->  POST status on agent start/exit
opencode agent .md files    -->  role-specific system prompts
Windows Terminal profiles   -->  color-coded, auto-launch wrappers
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serves the dashboard HTML |
| `GET` | `/stream` | Server-Sent Events stream (`init`, `agent-update`, `feed`) |
| `GET` | `/status` | Returns all agent statuses |
| `POST` | `/status` | Update an agent's status |
| `GET` | `/feed` | Returns the activity feed |

### POST /status body

```json
{
  "agent": "planner",
  "state": "active",
  "message": "Working on architecture"
}
```

Valid agents: `planner`, `coder`, `reviewer`, `refactor`
Valid states: `idle`, `active`, `attention`, `done`, `error`

## Dashboard Features

- **Real-time streaming** — SSE push with browser-native reconnect
- **Attention state** — pulsing animation + tab badge for agents needing input
- **Offline detection** — banner when server is unreachable
- **Activity feed** — scrollable log of all status changes
- **Copy command** — click any agent card to copy its launch command
- **Tab badge** — browser tab shows count of agents needing attention

## File Structure

```
agent-hub/
  status-server.js      # Express API server (port 3747)
  agent-hub.html        # Live dashboard (served by Express)
  package.json          # Node.js manifest
  .gitignore            # Excludes node_modules, status.json, feed.json
  smoke-test.ps1        # Server smoke test script
  scripts/
    planner.ps1         # Wrapper: posts status, runs opencode planner
    coder.ps1           # Wrapper: posts status, runs gh copilot
    reviewer.ps1        # Wrapper: posts status, runs opencode reviewer
    refactor.ps1        # Wrapper: posts status, runs opencode refactor
```

### External files (not in this repo)

| File | Location | Purpose |
|------|----------|---------|
| Planner agent | `~/.config/opencode/agents/planner.md` | opencode agent definition |
| Reviewer agent | `~/.config/opencode/agents/reviewer.md` | opencode agent definition |
| Refactor agent | `~/.config/opencode/agents/refactor.md` | opencode agent definition |
| PowerShell profile | `$PROFILE` | Shell aliases (`planner`, `coder`, etc.) |
| Terminal profiles | Windows Terminal settings.json | Color-coded agent tabs |

## Changing the Coder Model

The Coder agent currently uses `gh copilot -- --model gpt-5.3-codex`. To switch models, edit one file:

```powershell
# scripts/coder.ps1 — change the command on the line that runs gh copilot
gh copilot -- --model gpt-5.3-codex  # or whatever becomes available
```

To move Coder to opencode instead of gh copilot, create `~/.config/opencode/agents/coder.md` and update `scripts/coder.ps1` to call `opencode --agent coder -m <model>`.

## Prerequisites

- **Node.js** (v18+) — for the status server
- **opencode** — for Planner, Reviewer, Refactor agents
- **gh copilot CLI** — for Coder agent (`gh extension install github/gh-copilot` if needed)
- **Windows Terminal** — for color-coded agent profiles (optional)
