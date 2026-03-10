# Agent Hub

Live-updating dashboard + multi-agent terminal setup for orchestrating 4 AI coding agents with real-time status tracking, attention alerts, and color-coded Windows Terminal profiles.

## Agents

| Agent | Role | Tool | Model | Color |
|-------|------|------|-------|-------|
| Planner | Architecture, strategy, scoping | opencode | claude-opus-4.6 | Cyan |
| Coder | Implementation | gh copilot | gpt-5.3-codex | Purple |
| Reviewer | Bugs, security, quality | opencode | claude-opus-4.6 | Green |
| Puddleglum | Pre-mortem analysis, root-cause prediction | opencode | claude-opus-4.6 | Red |

> *The fourth slot was originally a cleanup-focused role, which was removed due to low usage and significant overlap with the Coder. Puddleglum fills it as a strategic gate check — it sits outside the planner -> coder -> reviewer cycle and identifies the single most likely root cause for failure in a plan.*

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
Open a new tab in Windows Terminal using the dropdown. You'll see 4 agent profiles (Planner, Coder, Reviewer, Puddleglum), each color-coded. Selecting one auto-launches the agent wrapper.

**Option B — PowerShell aliases:**
From any PowerShell terminal:

```powershell
planner    # launches Planner agent
coder      # launches Coder agent
reviewer   # launches Reviewer agent
puddleglum # launches Puddleglum agent
```

**Option C — Direct script execution:**

```powershell
.\scripts\planner.ps1
.\scripts\coder.ps1
.\scripts\reviewer.ps1
.\scripts\puddleglum.ps1
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
| `POST` | `/agents/:agent/resync` | Force re-poll an agent's activity |
| `GET` | `/feed` | Returns the activity feed |
| `GET` | `/learnings` | Returns recent learnings entries |
| `GET` | `/qmd/search?q=...` | Search QMD documentation |
| `GET` | `/qmd/doc/:id` | Retrieve a QMD document by ID |
| `GET` | `/api/messages` | List agent messages |
| `GET` | `/api/messages/counts` | Get unread message counts per agent |
| `GET` | `/api/messages/:id` | Get a specific message |
| `GET` | `/api/messages/thread/:threadId` | Get all messages in a thread |

### POST /status body

```json
{
  "agent": "planner",
  "state": "active",
  "message": "Working on architecture"
}
```

Valid agents: `planner`, `coder`, `reviewer`, `puddleglum`
Valid states: `idle`, `active`, `attention`, `done`, `error`

## Dashboard Features

- **Real-time streaming** — SSE push with browser-native reconnect
- **Agent cards** — 2x2 grid showing state, substatus, model, and recent activity
- **Granular substatus** — active agents show what they're doing: Thinking, Running: <tool>, Responding, Awaiting input
- **Attention state** — pulsing animation + tab badge for agents needing input
- **Live model display** — each card shows the model detected from the agent's session
- **Offline detection** — banner when server is unreachable
- **Activity feed** — scrollable log of all status changes
- **Learnings panel** — recent entries from the learnings DB with expand/collapse
- **Agent message bus** — inter-agent messaging with thread view and blocking/advisory severity
- **QMD documentation search** — search NRC survey platform docs from the dashboard
- **Click-to-copy** — click any agent card to copy its launch command
- **Tab badge** — browser tab shows count of agents needing attention

## File Structure

```
agent-hub/
  status-server.js      # Express API + DB polling + SSE (~1500 lines)
  agent-hub.html        # Live dashboard (~2400 lines, single-file)
  package.json          # Node.js manifest
  AGENTS.md             # Agent instructions for Copilot CLI
  SKILL.md              # Agent message bus skill definition
  smoke-test.ps1        # Server smoke test script
  .gitignore
  scripts/
    planner.ps1         # Wrapper: posts status, runs opencode planner
    coder.ps1           # Wrapper: posts status, runs gh copilot
    reviewer.ps1        # Wrapper: posts status, runs opencode reviewer
    puddleglum.ps1      # Wrapper: posts status, runs opencode puddleglum
  tests/
    api.test.js         # API endpoint tests
    attention.test.js   # Attention detection tests
    integration.test.js # Integration tests
    sse.test.js         # SSE streaming tests
    state.test.js       # State management tests
    summarize.test.js   # Summarization tests
    e2e/                # Playwright end-to-end tests
    helpers/            # Test utilities (fixtures, app creator)
  plans/                # Implementation plans (written by Planner agent)
  docs/                 # Project documentation
  .github/
    copilot-instructions.md
    skills/agent-message-bus/
```

### External files (not in this repo)

| File | Location | Purpose |
|------|----------|---------|
| Planner agent | `~/.config/opencode/agents/planner.md` | opencode agent definition |
| Reviewer agent | `~/.config/opencode/agents/reviewer.md` | opencode agent definition |
| Puddleglum agent | `~/.config/opencode/agents/puddleglum.md` | opencode agent definition |
| PowerShell profile | `$PROFILE` | Shell aliases (`planner`, `coder`, etc.) |
| Terminal profiles | Windows Terminal settings.json | Color-coded agent tabs |
| Message bus | `~/.agent/msg.js` | Inter-agent messaging CLI |
| MCP config (opencode) | `~/.config/opencode/opencode.json` | MCP server definitions |
| MCP config (copilot) | `~/.copilot/mcp-config.json` | MCP server definitions |

## Changing the Coder Model

The Coder agent currently uses `gh copilot -- --model gpt-5.3-codex`. To switch models, edit one file:

```powershell
# scripts/coder.ps1 — change the command on the line that runs gh copilot
gh copilot -- --model gpt-5.3-codex  # or whatever becomes available
```

To move Coder to opencode instead of gh copilot, create `~/.config/opencode/agents/coder.md` and update `scripts/coder.ps1` to call `opencode --agent coder -m <model>`.

## Testing

```powershell
npm test           # Unit tests (Node.js test runner)
npm run test:e2e   # E2E tests (Playwright, requires server running)
```

Unit tests cover API endpoints, attention detection, state management, SSE streaming, and summarization. E2E tests use Playwright to validate the live dashboard.

## Prerequisites

- **Node.js** (v18+) — for the status server
- **opencode** — for Planner, Reviewer, Puddleglum agents
- **gh copilot CLI** — for Coder agent (`gh extension install github/gh-copilot` if needed)
- **Windows Terminal** — for color-coded agent profiles (optional)
