# Hub Prompt Routing — Feasibility Analysis

> **Status:** Exploration / Not yet planned  
> **Created:** 2026-03-06  
> **Complexity:** Medium-Large (~1-2 plans worth of work)

## Concept

Write prompts in the Agent Hub dashboard and have them routed to agent terminals — turning the hub from a passive monitor into an active orchestrator.

---

## Key Discovery: Both Runtimes Support This

### OpenCode (planner, reviewer, refactor)

OpenCode has first-class headless server + remote execution:

```bash
# Start a headless server (no TUI)
opencode serve --port 4001

# Send a prompt to it
opencode run "your prompt" --attach http://localhost:4001

# Continue an existing session
opencode run "your prompt" --session <id> --continue --attach http://localhost:4001

# Attach a TUI to watch/override interactively
opencode attach http://localhost:4001

# Structured output
opencode run "prompt" --format json
```

Relevant `opencode run` flags:
- `--attach <url>` — send to a running server
- `--session <id>` / `--continue` — resume existing session
- `--agent <name>` — target agent definition
- `--format json` — raw JSON event stream
- `--file <path>` — attach files to the prompt
- `--dir <path>` — set working directory on remote server

### Copilot CLI (coder)

`gh copilot` has equivalent non-interactive capabilities:

```bash
# Send a prompt non-interactively (exits after completion)
gh copilot -- -p "your prompt" --allow-all-tools --model gpt-5.3-codex

# Resume an existing session
gh copilot -- -p "your prompt" --resume <sessionId> --allow-all-tools

# Fully autonomous (no human confirmation)
gh copilot -- -p "prompt" --resume <id> --allow-all-tools --autopilot --no-ask-user

# Structured output
gh copilot -- -p "prompt" --output-format json --allow-all-tools
```

Relevant flags:
- `-p, --prompt <text>` — non-interactive mode
- `--resume [sessionId]` / `--continue` — session continuity
- `--allow-all-tools` — required for non-interactive
- `--autopilot` — continuation without human input
- `--no-ask-user` — agent works autonomously
- `--output-format json` — JSONL output
- `--agent <agent>` — custom agent

---

## Side-by-Side Comparison

| Capability | OpenCode | Copilot CLI |
|---|---|---|
| **Send prompt** | `opencode run "prompt" --attach <url>` | `gh copilot -- -p "prompt" --allow-all-tools` |
| **Session continuity** | `--session <id> --continue` | `--resume <sessionId>` |
| **Structured output** | `--format json` | `--output-format json` |
| **Autonomous mode** | Built-in | `--autopilot --no-ask-user` |
| **Agent targeting** | `--agent planner` | `--agent <name>` |
| **File attachment** | `--file <path>` | N/A (use prompt text) |

---

## Proposed Architecture

### Today

```
You ──type──> Terminal (TUI) ──stdin──> opencode/copilot
                                              │
Hub (browser) <──polls DB──── status-server <─┘
```

### With Routing

```
You ──type──> Hub dashboard ──POST /agents/:name/prompt──> status-server
                                                                │
                                              spawns: opencode run --attach / gh copilot -p
                                                                │
Hub (browser) <──SSE──── status-server <──DB polling────── opencode DB
                                                                │
               Optional: opencode attach (TUI) ────────────────┘
```

### Key Changes

| Component | Today | With Routing |
|-----------|-------|-------------|
| Planner/Reviewer/Refactor | `opencode --agent <name>` (TUI) | `opencode serve --port 400X` (headless) |
| Coder | `gh copilot -- --model gpt-5.3-codex` (TUI) | Same TUI, but prompts also via `-p --resume` |
| Terminal windows | Primary interaction point | Optional — attach to watch/override |
| Hub dashboard | Read-only monitoring | Adds prompt input per agent card |
| Activity monitoring | DB polling (unchanged) | DB polling (unchanged) |

---

## Implementation Sketch

### 1. Wrapper Script Changes (Small)

Change agent launch from TUI mode to headless server mode (OpenCode agents):

```powershell
# Before
opencode --agent planner

# After
opencode serve --port 4001 --agent planner  # if --agent is supported
# OR
opencode serve --port 4001                  # configure agent via session
```

For coder, the wrapper could stay as-is (interactive) or shift to headless too.

### 2. Server: Prompt Routing Endpoint (Medium)

New endpoint in `status-server.js`:

```
POST /agents/:name/prompt
Body: { message: "your prompt text", files?: ["path1"] }
Response: { sessionId, status: "dispatched" }
```

The server would:
- Determine which runtime (opencode vs copilot) based on agent name
- Spawn the appropriate `run`/`-p` command
- Track the active session ID per agent
- Stream JSON output events back via SSE

### 3. Dashboard: Prompt Input UI (Medium)

Per agent card (or a shared input targeting a selected agent):
- Text area for the prompt
- Submit button
- Loading/streaming state while agent processes
- Response display (or rely on existing activity feed)

### 4. Session Management (Medium)

- Track session IDs per agent in server state
- First prompt creates a new session; subsequent prompts continue it
- Expose session info in the dashboard (session ID, message count, age)
- "New Session" button to start fresh

### 5. Response Streaming (Medium-Large)

Both runtimes support JSON output. The server could:
- Parse JSON events from `opencode run --format json` or `gh copilot -p --output-format json`
- Forward them via SSE to the dashboard
- Display agent responses in real-time (not just via DB polling)

---

## Open Questions to Validate

1. **`opencode serve` + `--agent` flag** — Does `serve` accept `--agent planner`? The `serve --help` doesn't list it. May need to configure agent at the session level instead.

2. **Session continuity with `run --attach`** — Does `opencode run "prompt" --attach <url> --continue` truly append to the in-flight session? Or does it start a new one? This is the most critical unknown.

3. **Concurrency** — What happens if you submit a prompt while the agent is still processing? Needs a client-side queue/lock or server-side rejection.

4. **Copilot session discovery** — How does `--resume <sessionId>` work? Where are session IDs stored? Need to discover the right ID to continue.

5. **Port allocation** — Fixed ports per agent (4001-4004) or dynamic with discovery?

6. **Error propagation** — How do runtime errors (model failures, tool errors) surface back to the hub?

---

## Risks

- **Philosophical shift** — Hub moves from observer to orchestrator. Need to decide if it's the *primary* interface or a *secondary* convenience.
- **Loss of interactivity** — Headless mode means no inline confirmation prompts. `--allow-all-tools` / `--autopilot` needed. Acceptable for trusted agents?
- **Debugging gets harder** — When something goes wrong, you'd need to `opencode attach` to debug, adding a step.
- **Two input paths** — If you keep terminals AND hub input, confusion about which has the "real" session.

---

## Rough Effort Estimate

| Work Item | Effort |
|-----------|--------|
| Validate `serve`/`run --attach` and `copilot -p --resume` | Spike (1-2 hrs) |
| Wrapper script changes | Small |
| Server prompt routing endpoint | Medium |
| Dashboard prompt input UI | Medium |
| Session management | Medium |
| Response streaming to dashboard | Medium-Large |
| Error handling, concurrency, queue | Medium |
| **Total** | **~1-2 plans** |
