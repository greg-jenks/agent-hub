# Agent Hub — How It Works

## What Is It?

Agent Hub is an experiment in **multi-agent AI-assisted development** — running 4 specialized AI coding agents simultaneously, each in its own terminal, with a live dashboard that shows what every agent is doing in real time. Think of it as a "mission control" for AI pair programming.

The core idea: instead of one general-purpose AI agent, split the work into **specialized roles** that mirror a real engineering team — a planner, a coder, a reviewer, and a refactor specialist. Each agent has a focused system prompt, restricted tool access, and its own terminal session. A central dashboard ties them together.

## The Four Agents

| Agent | Role | Underlying Tool | Model | Color |
|-------|------|-----------------|-------|-------|
| **Planner** | Architecture, scoping, task breakdown | [opencode](https://github.com/sst/opencode) | Claude Opus 4.6 | Cyan |
| **Coder** | Implementation (writes the actual code) | [gh copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) | GPT-5.3 Codex | Purple |
| **Reviewer** | Bug-finding, security, quality checks | opencode | Claude Opus 4.6 | Green |
| **Refactor** | Cleanup, deduplication, naming, tech debt | opencode | Claude Sonnet 4.6 | Amber |

### Why Different Tools?

Three agents (Planner, Reviewer, Refactor) use **opencode**, an open-source terminal-based AI coding assistant that supports custom agent definitions. The Coder uses **GitHub Copilot CLI** because it has access to GPT-5.3 Codex. The system is designed so the Coder could move to opencode later — it's a one-line change in the wrapper script.

---

## Agent Definitions (opencode)

Each opencode agent is a Markdown file at `~/.config/opencode/agents/<name>.md` with YAML frontmatter and a system prompt. Here's the structure:

```yaml
---
description: Architecture planning agent. Designs solutions, breaks down tasks...
color: "#00d4ff"
tools:
  read: true
  write: true     # Planner can write plan docs
  edit: true
  bash: true
  grep: true
  glob: true
---

<role>
You are the **Planner** agent in a multi-agent coding workflow...
</role>

<responsibilities>
## What You Do
1. Analyze requirements
2. Design architecture
3. Scope work
4. Create task lists for the Coder agent

## What You Don't Do
- Don't write production code (that's the Coder's job)
- Don't do code reviews (that's the Reviewer's job)
</responsibilities>
```

**Key design choice: tool access is scoped per role.** The Reviewer agent has `write: false` and `edit: false` — it can read and analyze code, but it literally cannot modify files. This forces clean separation of concerns. The Planner and Refactor agents have full file access because they need it for plan documents and refactoring respectively.

Each agent's system prompt explicitly states what it **does** and **doesn't do**, creating clear handoff points:

- Planner produces a numbered task list -> user copies to Coder session
- Coder writes code -> user runs Reviewer on the changes
- Reviewer produces findings -> user sends fixes back to Coder
- Refactor runs separately on areas with accumulated tech debt

---

## The Wrapper Scripts

Each agent has a PowerShell wrapper script (`scripts/<agent>.ps1`) that does three things:

1. **Reports status** — POSTs to the hub server when the agent starts and stops
2. **Launches the agent** — Runs the actual CLI command (`opencode --agent planner` or `gh copilot -- --model gpt-5.3-codex`)
3. **Handles cleanup** — Uses `try/finally` to guarantee the "done" status is posted even if the agent crashes or the user kills it

Here's the complete planner wrapper (they're all ~34 lines):

```powershell
# Agent Hub — Planner Wrapper
$HubUrl = "http://localhost:3747/status"
$Agent = "planner"

function Post-Status {
    param([string]$State, [string]$Message)
    try {
        $body = @{ agent = $Agent; state = $State; message = $Message } | ConvertTo-Json -Compress
        $null = Invoke-RestMethod -Uri $HubUrl -Method Post -Body $body `
            -ContentType "application/json" -TimeoutSec 5
        Write-Host "  [hub] $Agent -> $State" -ForegroundColor DarkGray
    } catch {
        Write-Host "  [hub] Failed to post status: $($_.Exception.Message)" `
            -ForegroundColor DarkYellow
    }
}

Write-Host ""
Write-Host "  === PLANNER AGENT ===" -ForegroundColor Cyan
Write-Host "  Activity streaming: via OpenCode DB" -ForegroundColor DarkCyan
Write-Host ""

Post-Status -State "active" -Message "Session started"

try {
    opencode --agent planner
} finally {
    Post-Status -State "done" -Message "Session ended"
    Write-Host ""
    Write-Host "  Planner session ended. Terminal stays open." -ForegroundColor DarkCyan
    Write-Host ""
}
```

The `Post-Status` function is intentionally fire-and-forget with a 5-second timeout — if the hub server isn't running, the agent still launches normally. The status reporting is a convenience, not a requirement.

The Coder wrapper is almost identical except it runs `gh copilot -- --model gpt-5.3-codex` instead of an opencode command.

### Launch Methods

There are three ways to start an agent:

1. **Windows Terminal profiles** — Color-coded tabs (Cyan/Purple/Green/Amber) that auto-run the wrapper script when you open them
2. **PowerShell aliases** — `planner`, `coder`, `reviewer`, `refactor` functions defined in `$PROFILE`
3. **Direct execution** — `.\scripts\planner.ps1`

---

## The Status Server

The server (`status-server.js`, ~1060 lines) is an Express app on port 3747 that does three jobs: track agent state, poll agent activity, and push updates to the dashboard.

### Tracking Agent State

- Maintains an in-memory state object with each agent's status (`idle`, `active`, `attention`, `done`, `error`)
- Accepts POST requests from wrapper scripts for lifecycle events (start/stop)
- Periodically flushes state to `status.json` for crash recovery

### Polling Agent Activity (the clever part)

Rather than relying solely on the wrapper scripts' start/stop POSTs, the server **actively polls the agents' data stores** every 2 seconds to get granular, real-time activity:

**For opencode agents (Planner, Reviewer, Refactor):**

- Reads opencode's SQLite database (`~/.local/share/opencode/opencode.db`)
- Queries the `message` table for new user prompts and assistant responses
- Queries the `part` table for granular sub-message events (thinking, tool use, responding)
- Detects the model being used from the most recent assistant message
- Checks the last ~1500 characters of the agent's response against regex patterns to detect "attention needed" (agent is asking a question)

**For the Copilot agent (Coder):**

- Discovers the active Copilot session by scanning `~/.copilot/session-state/` directories
- Reads the session's `events.jsonl` file (line-delimited JSON event log)
- Maps Copilot events (`user.message`, `assistant.turn_start`, `tool.execution_start`, etc.) to the hub's state model
- Detects attention via `ask_user` tool calls and `report_intent` with question-like content
- Tracks tool usage, reasoning text, and turn lifecycle

### Granular Substatus

Beyond the top-level state, the server tracks a **substatus** for active agents:

| Substatus | Meaning | Triggered By |
|-----------|---------|--------------|
| `thinking` | LLM is generating | step-start, reasoning events |
| `tool` | Running a tool (includes tool name) | tool part with status=running |
| `responding` | Streaming text output | text part events |
| `awaiting-input` | Turn finished, waiting for user | step-finish with reason=stop |

### Attention Detection

The server uses regex pattern matching to detect when an agent needs human input. It checks the tail of the agent's last response for patterns like:

- Questions ending in `?`
- "Should I...?", "Would you like...", "Do you want..."
- "Please confirm/clarify/provide"
- "Waiting for input/response/answer"

When detected, the agent's state changes to `attention`, its dashboard card starts pulsing, and a count appears in the browser tab title.

### Server-Sent Events (SSE)

The dashboard uses SSE (`GET /stream`) for real-time updates instead of polling:

- On connection, the server sends an `init` event with the full state snapshot
- Individual `agent-update` events fire whenever any agent's state changes
- `feed` events stream activity log entries in real time
- A heartbeat every 30 seconds keeps the connection alive
- The browser's native `EventSource` auto-reconnects on disconnect

### API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Serves the dashboard HTML |
| `GET` | `/stream` | SSE event stream (`init`, `agent-update`, `feed`) |
| `GET` | `/status` | Returns all agent statuses as JSON |
| `POST` | `/status` | Update an agent's status (used by wrapper scripts) |
| `GET` | `/feed` | Returns the activity feed |
| `GET` | `/learnings` | Returns recent entries from the learnings DB |

---

## The Dashboard

`agent-hub.html` is a single-file, ~1540-line HTML document served by Express. No build step, no framework — just vanilla HTML/CSS/JS with a cyberpunk-inspired dark theme.

### Features

- **Agent cards** — 2x2 grid showing each agent's state, substatus, current model, and most recent activity
- **Visual states** — Idle (dim), Active (static glow), Attention (fast pulse + browser tab badge), Done (dim)
- **Substatus overlays** — When active, cards show what the agent is doing: "Thinking...", "Running: bash", "Responding...", "Awaiting input"
- **Activity feed** — Scrollable log of all agent events (prompts, responses, tool calls, lifecycle changes)
- **Learnings panel** — Shows recent entries from the learnings database with expand/collapse
- **Offline detection** — Red banner when the server is unreachable
- **Click-to-copy** — Click any agent card to copy its launch command
- **Tab badge** — Browser tab shows counts: `(warning 2) Agent Hub` for attention, `(hourglass 1) Agent Hub` for awaiting input
- **Agent modals** — Click through for launch command, tips, and details

### Color System

Each agent has three CSS custom properties that cascade through their card:

```css
--planner-primary: #00d4ff;                    /* Main accent */
--planner-glow: rgba(0, 212, 255, 0.15);       /* Background glow */
--planner-dim: rgba(0, 212, 255, 0.4);         /* Border/shadow */
```

---

## Architecture Diagram

```
+-------------------------------------------------------------------+
|  Browser (agent-hub.html)                                         |
|  +----------+ +----------+ +----------+ +----------+              |
|  | Planner  | |  Coder   | | Reviewer | | Refactor |              |
|  |   card   | |   card   | |   card   | |   card   |              |
|  +----------+ +----------+ +----------+ +----------+              |
|  +-----------------------+ +---------------------------+          |
|  |   Activity Feed       | |   Learnings Panel         |          |
|  +-----------------------+ +---------------------------+          |
|                         ^ SSE stream (real-time push)             |
+-------------------------|-----------------------------------------+
                          |
+-------------------------|-----------------------------------------+
|  status-server.js       | (Express, port 3747)                    |
|                         |                                         |
|  POST /status <--- wrapper scripts (start/stop lifecycle)         |
|  GET /stream  ---> SSE to browser                                 |
|                                                                   |
|  +--- polls every 2s ----------------------------------------+   |
|  |  opencode.db --> message + part tables (3 agents)          |   |
|  |  events.jsonl --> Copilot session events (coder agent)     |   |
|  |  learnings.db --> Recent learnings (30s cache)             |   |
|  +------------------------------------------------------------+   |
+-------------------------------------------------------------------+

+--------------+  +--------------+  +--------------+  +--------------+
|  Terminal 1  |  |  Terminal 2  |  |  Terminal 3  |  |  Terminal 4  |
|  planner.ps1 |  |  coder.ps1   |  |  reviewer.ps1|  |  refactor.ps1|
|  opencode    |  |  gh copilot  |  |  opencode    |  |  opencode    |
|  --agent     |  |  --model     |  |  --agent     |  |  --agent     |
|  planner     |  |  gpt-5.3-   |  |  reviewer    |  |  refactor    |
|              |  |  codex       |  |              |  |              |
+------+-------+  +------+-------+  +------+-------+  +------+-------+
       |                 |                 |                 |
       +-- POST /status -+-- POST /status -+-- POST /status -+
```

---

## How a Typical Session Flows

1. **Start the server** — `npm start` (or `agent-hub` alias) runs on port 3747
2. **Open the dashboard** — Navigate to `http://localhost:3747` in a browser
3. **Launch the Planner** — Open a new terminal tab. Planner wrapper POSTs `active`, launches opencode
4. **Plan the work** — Describe the feature to the Planner. It produces a numbered task list.
5. **Launch the Coder** — Open another tab. Paste the plan into the Coder session.
6. **Monitor on the dashboard** — Both cards are now glowing. You can see real-time substatus (thinking, running tools, responding). If either agent asks you a question, its card starts pulsing and the tab badge updates.
7. **Review the code** — Launch the Reviewer. Paste a `git diff` or point it at the changed files. It produces findings organized by severity (Critical / Important / Minor).
8. **Iterate** — Send fixes back to the Coder. Optionally run the Refactor agent on areas with accumulated tech debt.

---

## File Structure

```
agent-hub/
  status-server.js          # Express API + DB polling + SSE (~1060 lines)
  agent-hub.html             # Dashboard UI (~1540 lines, single-file)
  package.json               # 3 deps: express, cors, better-sqlite3
  scripts/
    planner.ps1              # Wrapper: lifecycle POST + opencode --agent planner
    coder.ps1                # Wrapper: lifecycle POST + gh copilot
    reviewer.ps1             # Wrapper: lifecycle POST + opencode --agent reviewer
    refactor.ps1             # Wrapper: lifecycle POST + opencode --agent refactor
  AGENTS.md                  # Instructions for gh copilot when working in this repo
  .github/
    copilot-instructions.md  # Same instructions (GitHub Copilot format)
  plans/                     # Implementation plans (written by the Planner agent)
  tests/                     # Unit + E2E tests
  docs/
    how-it-works.md          # This file
  smoke-test.ps1             # Quick server validation script

External (not in this repo):
  ~/.config/opencode/agents/planner.md    # opencode agent definition
  ~/.config/opencode/agents/reviewer.md   # opencode agent definition
  ~/.config/opencode/agents/refactor.md   # opencode agent definition
  $PROFILE                                # PowerShell aliases
  Windows Terminal settings.json          # Color-coded terminal profiles
```

## Dependencies

Intentionally minimal:

- **express** — HTTP server
- **cors** — Cross-origin support
- **better-sqlite3** — Read opencode + learnings databases

Dev dependencies:

- **supertest** — API testing
- **@playwright/test** — E2E dashboard testing

---

## What Makes This Interesting

1. **Role specialization works.** Agents perform better when you constrain their scope. A Reviewer that can't write code produces more thorough reviews. A Planner that's told "you don't code" produces better task breakdowns.

2. **System prompts as job descriptions.** Each agent's `.md` file reads like a job description with responsibilities, process, principles, and output format. The "What You Don't Do" sections are as important as the "What You Do" sections.

3. **Attention detection is surprisingly effective.** Simple regex patterns on the tail of an agent's response catch most "waiting for input" states. The dashboard tab badge means you don't have to watch terminals.

4. **Mixing AI providers works.** Three agents on Anthropic Claude, one on OpenAI's Codex. Different models for different jobs. The wrapper scripts abstract this away.

5. **No orchestrator needed.** The human is the orchestrator. You decide when to launch each agent, what to hand off, and when work is done. This avoids the complexity and unreliability of automated multi-agent orchestration.

6. **MCP tools as shared context.** All agents share access to the same MCP servers (learnings DB, QMD documentation, Shortcut). The Planner can record a decision and the Coder can find it. The Reviewer can check for past mistakes before reviewing.

---

## Trying It Yourself

The core pattern is portable. You need:

1. **An AI CLI tool** that supports custom system prompts (opencode, gh copilot, aider, claude code, etc.)
2. **A simple status server** (the Express server here is ~1060 lines, most of which is the polling logic you may not need)
3. **Wrapper scripts** in whatever shell you use (PowerShell here, but Bash equivalents are trivial)
4. **Agent definitions** — Markdown files with role, responsibilities, process, and output format

The minimum viable version is just the wrapper scripts + agent definitions — no server, no dashboard. The dashboard is a nice-to-have that becomes valuable once you're regularly running 2+ agents simultaneously.

---

*Built over a weekend. ~2,700 lines of code across the server, dashboard, wrapper scripts, and agent definitions. Zero frameworks. Three npm dependencies.*
