# Plan: Copilot Coder Agent Parity

## Goal

Close the functionality gap between the **coder agent** (GitHub Copilot CLI) and the **OpenCode agents** (planner, reviewer, refactor) on the agent-hub dashboard — giving the coder the same MCP servers, live substatus tracking, activity feed entries, model detection, and attention detection that the OpenCode agents already have.

## Background

### Current State

The agent-hub dashboard has two tiers of agent integration:

| Capability | OpenCode Agents (planner, reviewer, refactor) | Coder (gh copilot) |
|---|---|---|
| Lifecycle (start/stop) | Wrapper scripts POST to `/status` | Wrapper script POSTs to `/status` |
| Substatus (thinking/tool/responding) | `pollAgentSubstatus()` polls opencode DB `part` table | **Not tracked** — always shows generic "active" |
| Activity feed entries | `pollOpenCodeActivity()` polls opencode DB `message` table | **No mid-session entries** — only "Session started"/"Session ended" |
| Model detection | From DB assistant messages (`modelID` field) | **Hardcoded** `"GPT-5.3 Codex"` in `coder.ps1` banner |
| MCP servers | 3 servers via `opencode.json`: learnings, qmd, shortcut | **None** — `~/.copilot/mcp-config.json` doesn't exist |
| Attention detection | Regex on last assistant text → `state: 'attention'` | **Not possible** — assistant content is encrypted |

### Data Source: `events.jsonl`

Copilot CLI doesn't use a queryable SQLite DB for messages (its `session.db` only has `todos`/`todo_deps`). Instead, it writes a structured **append-only event log** at:

```
~/.copilot/session-state/<session-uuid>/events.jsonl
```

Each line is a JSON object with `{type, data, id, timestamp, parentId}`. The relevant event types and their data availability:

| Event Type | Key Fields | Plaintext? |
|---|---|---|
| `session.start` | `data.selectedModel`, `data.context.cwd`, `data.sessionId` | ✅ Yes |
| `user.message` | `data.content` (user prompt) | ✅ Yes |
| `assistant.turn_start` | `data.turnId` | ✅ Yes (no content) |
| `assistant.message` | `data.content`, `data.encryptedContent`, `data.toolRequests[]`, `data.reasoningText` | ⚠️ `content` is empty string; actual text is **encrypted** in `encryptedContent`. But `reasoningText` and `toolRequests` ARE plaintext |
| `tool.execution_start` | `data.toolName`, `data.arguments` | ✅ Yes |
| `tool.execution_complete` | `data.toolName`, `data.model`, `data.success`, `data.result.content` | ✅ Yes |
| `assistant.turn_end` | `data.turnId` | ✅ Yes (no content) |

**Critical constraint**: Assistant message body content is encrypted. Attention detection via regex on response text (like OpenCode agents) **won't work**. However, `report_intent` tool calls provide excellent plaintext signals about what the agent is doing.

### Session Discovery

Copilot stores sessions in `~/.copilot/session-state/`, each in a UUID-named directory with a `workspace.yaml`:

```yaml
id: 0c87dd06-cfb1-4351-8bf3-f2c0c3d8c61b
cwd: C:\Users\gjenks\Repos
summary: Implement Live Model Display
summary_count: 0
created_at: 2026-03-01T03:29:20.648Z
updated_at: 2026-03-01T03:42:02.899Z
```

The **most recently `updated_at` session** whose `updated_at` is within 5 minutes is the active session. The server discovers this automatically via `findActiveCopilotSession()` — no wrapper involvement needed (see Task 6).

### MCP Server Gap

OpenCode agents get 3 MCP servers via `~/.config/opencode/opencode.json`:
1. **learnings** — `python -m learnings_mcp` (local learning DB)
2. **qmd** — `node qmd.js mcp` (NRC documentation search)
3. **shortcut** — `npx -y @shortcut/mcp@latest` (Shortcut project management)

Copilot supports persistent MCP config via `~/.copilot/mcp-config.json`, but this file **does not exist yet**.

## Files to Change

| File | What Changes |
|---|---|
| `~/.copilot/mcp-config.json` | **Create** — MCP server config for learnings, qmd, shortcut |
| `scripts/coder.ps1` | **Modify** — Discover copilot session ID after launch, POST it to hub; add `--additional-mcp-config` flag |
| `status-server.js` | **Modify** — Add `COPILOT_SESSION_DIR`, `pollCopilotActivity()`, copilot events.jsonl tailing, model/substatus/activity/attention for coder |
| `agent-hub.html` | **Possibly modify** — If coder-specific UI adjustments needed (likely none — existing card rendering should work once server provides proper data) |

**No changes to**: `package.json` (no new deps — YAML parsing uses regex, JSONL is just `JSON.parse` per line), wrapper scripts for planner/reviewer/refactor.

## Tasks

### Phase 1: MCP Server Parity

#### Task 1: Create `~/.copilot/mcp-config.json`

Create the file at `C:\Users\gjenks\.copilot\mcp-config.json` with the three MCP servers that OpenCode agents already have. The format follows GitHub Copilot's MCP config schema:

```json
{
  "mcpServers": {
    "learnings": {
      "command": "python",
      "args": ["-m", "learnings_mcp"],
      "env": {
        "LEARNINGS_DB_PATH": "C:\\Users\\gjenks\\Repos\\learnings-mcp\\data\\learnings.db"
      }
    },
    "qmd": {
      "command": "node",
      "args": ["C:\\Users\\gjenks\\Ext Repos\\qmd\\packages\\qmd\\dist\\qmd.js", "mcp"],
      "env": {
        "INDEX_PATH": "C:\\Users\\gjenks\\Ext Repos\\qmd\\index"
      }
    },
    "shortcut": {
      "command": "npx",
      "args": ["-y", "@shortcut/mcp@latest"],
      "env": {
        "SHORTCUT_API_TOKEN": "${SHORTCUT_API_TOKEN}"
      }
    }
  }
}
```

**Note:** The `SHORTCUT_API_TOKEN` env var reference — check if copilot supports env var interpolation (`${...}`) or if the actual token needs to be inlined. Test by running `gh copilot -- --model gpt-5.3-codex` and verifying the MCP servers connect. If copilot doesn't support env var interpolation, the token will need to be read from the user's environment directly (copilot inherits parent shell env vars, so `SHORTCUT_API_TOKEN` set in the shell should propagate automatically without needing it in the config).

**Verification:** Start a copilot session and ask it to use `learnings_search` — if MCP is configured correctly, the tool will be available.

#### Task 2: Update `coder.ps1` to pass MCP config (if needed)

If the persistent `~/.copilot/mcp-config.json` approach works (Task 1 verification), **no changes to coder.ps1 are needed for MCP**. If it doesn't, add `--additional-mcp-config` to the launch command:

```powershell
# Only if ~/.copilot/mcp-config.json doesn't work:
$McpConfig = Join-Path $env:USERPROFILE ".copilot" "mcp-config.json"
gh copilot -- --model gpt-5.3-codex --additional-mcp-config "@$McpConfig"
```

### Phase 2: Session Discovery and Lifecycle Wiring

#### Task 3: Keep `coder.ps1` simple — no session discovery changes

The critique correctly identified that the PowerShell background job approach adds significant complexity (slow `Start-Job` startup, separate process, timeout on session reuse, cleanup logic) while the server-side `findActiveCopilotSession()` fallback handles both new and reused sessions. **Make server-side discovery the primary (and only) approach.**

`coder.ps1` stays as-is: it POSTs `state: 'active'` on start and `state: 'done'` on exit. No session ID needed from the wrapper. The server discovers the active session by scanning `workspace.yaml` `updated_at` timestamps.

**No code changes to `coder.ps1` in this task** (beyond the model banner update in Task 10).

#### Task 4: Extend `POST /status` to accept `sessionId` (optional, for future use)

In `status-server.js`, modify the `POST /status` route to accept and store an optional `sessionId` field:

```js
app.post('/status', (req, res) => {
    const { agent, state, message, sessionId } = req.body;
    // ... existing validation ...
    
    const updates = { state, message: message || '' };
    if (state !== 'active') {
      updates.substatus = null;
      updates.toolName = null;
    }
    if (sessionId) {
      updates.sessionId = sessionId;  // Store copilot session ID
    }
    updateAgentState(agent, updates);
    // ... rest unchanged ...
});
```

Also update `updateAgentState()` to persist `sessionId` in the agent state object (it already handles arbitrary keys via object spread — verify this).

### Phase 3: Events.jsonl Polling

#### Task 5: Add `pollCopilotActivity()` function

This is the core integration. Add a new function in `status-server.js` that tails the coder's `events.jsonl`, analogous to how `pollOpenCodeActivity()` tails the OpenCode DB.

**Add these constants** near the existing constants:

```js
const COPILOT_SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
```

**Add to the `createApp()` scope** (alongside `lastSeenTimestamps`):

```js
let copilotLastEventIndex = 0;  // Line offset into events.jsonl
let copilotSessionId = null;     // Discovered or reported session UUID
```

**Add the polling function:**

```js
function pollCopilotActivity() {
    // Determine which session to poll
    const sessionId = findActiveCopilotSession();
    if (!sessionId) return;
    
    const eventsPath = path.join(COPILOT_SESSION_STATE_DIR, sessionId, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return;
    
    if (sessionId !== copilotSessionId) {
      // New session — reset state and skip to current (avoid replaying history)
      copilotSessionId = sessionId;
      resetCopilotTurnContext();
      initCopilotEventIndex(eventsPath);
      return;  // State initialized, start processing new events on next poll
    }
    
    let lines;
    try {
      const content = fs.readFileSync(eventsPath, 'utf8');
      lines = content.split('\n').filter(l => l.trim());
    } catch {
      return;  // File locked or inaccessible
    }
    
    if (lines.length <= copilotLastEventIndex) return;  // No new events
    
    const newLines = lines.slice(copilotLastEventIndex);
    
    // IMPORTANT: Only advance index per successfully parsed line.
    // A partial line (mid-write) can only occur at the end — break on
    // parse failure to retry that line on the next poll cycle.
    for (let i = 0; i < newLines.length; i++) {
      try {
        const event = JSON.parse(newLines[i]);
        processCopilotEvent(event);
        copilotLastEventIndex++;  // advance only on success
      } catch {
        break;  // partial line at end — stop here, retry next poll
      }
    }
}
```

**Notes on implementation:**
- **Partial line safety:** Index advances per-line only on successful parse. A partial JSON line (caught mid-write by `readFileSync`) causes a `break`, not `continue`. The next poll re-reads from that line's offset, now complete. This prevents the permanently-skipped-events bug.
- **Session change:** On discovering a new session, `initCopilotEventIndex()` skips to the end (avoiding feed flood) while backtracking to extract the model from `session.start`. `resetCopilotTurnContext()` clears stale attention state from the old session.
- Reading the full file every 2s is fine — events.jsonl is small (the largest session observed was 164 lines / ~80KB). If performance becomes a concern, switch to tracking file size and reading only the delta via `fd.read()` with byte offset.
- `fs.readFileSync` handles Windows file locking gracefully — copilot writes with append semantics so read contention is minimal.
- `findActiveCopilotSession()` is now the sole session discovery mechanism (no wrapper-reported `sessionId` needed — see Design Decisions).

#### Task 6: Add `findActiveCopilotSession()` helper

Server-side session discovery as a fallback when the wrapper doesn't provide a session ID:

```js
function findActiveCopilotSession() {
    try {
      if (!fs.existsSync(COPILOT_SESSION_STATE_DIR)) return null;
      
      const dirs = fs.readdirSync(COPILOT_SESSION_STATE_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      
      let bestSession = null;
      let bestTime = null;
      
      for (const dir of dirs) {
        const wsPath = path.join(COPILOT_SESSION_STATE_DIR, dir.name, 'workspace.yaml');
        if (!fs.existsSync(wsPath)) continue;
        
        const content = fs.readFileSync(wsPath, 'utf8');
        // Simple regex for updated_at — avoids YAML parser dependency
        const match = content.match(/updated_at:\s*(.+)/);
        if (!match) continue;
        
        const updatedAt = new Date(match[1].trim());
        if (!bestTime || updatedAt > bestTime) {
          bestTime = updatedAt;
          bestSession = dir.name;
        }
      }
      
      // Only return if updated within the last 5 minutes (session is likely active)
      if (bestTime && (Date.now() - bestTime.getTime()) < 5 * 60 * 1000) {
        return bestSession;
      }
      
      return null;
    } catch {
      return null;
    }
}
```

**Design decisions:**
- The 5-minute staleness check prevents the poller from tailing an old, finished session. When the coder agent is `state: 'active'` (set by `coder.ps1` on launch), `findActiveCopilotSession()` provides the session to poll. When the coder goes `state: 'done'`, polling naturally stops because `pollCopilotActivity()` only runs when coder is active (see Task 8).
- **Cache the result:** Once a session is discovered, `copilotSessionId` stores it. `findActiveCopilotSession()` is only called when `copilotSessionId` is null (i.e., on first discovery or after a `done` → `active` transition). This avoids scanning 12+ `workspace.yaml` files every 2 seconds.

#### Task 6b: Add `initCopilotEventIndex()` to prevent feed flood

When the server discovers a session (or starts up), `copilotLastEventIndex` must skip to the end of the existing events — otherwise `pollCopilotActivity()` replays all historical events, flooding the feed and activity buffers with stale data. This mirrors how `initLastSeenTimestamps()` works for OpenCode agents.

```js
function initCopilotEventIndex(eventsPath) {
  try {
    const content = fs.readFileSync(eventsPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    copilotLastEventIndex = lines.length;  // skip to end

    // Backtrack to grab model from session.start (most recent one)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'session.start' && ev.data?.selectedModel) {
          updateAgentState('coder', { model: ev.data.selectedModel, provider: 'github-copilot' });
          broadcastSubstatusUpdate('coder');
          break;
        }
      } catch { continue; }
    }
  } catch { /* file doesn't exist yet — start at 0 */ }
}
```

This is called from `pollCopilotActivity()` when `sessionId !== copilotSessionId` (session change).

#### Task 7: Add `processCopilotEvent()` function

This function maps copilot event types to the same state/feed/broadcast model used by OpenCode agents:

```js
function processCopilotEvent(event) {
    const { type, data, timestamp } = event;
    
    switch (type) {
      case 'session.start': {
        // Model detection
        const model = data.selectedModel;
        if (model) {
          updateAgentState('coder', { model, provider: 'github-copilot' });
          broadcastSubstatusUpdate('coder');
        }
        break;
      }
      
      case 'user.message': {
        // User prompt — set as current task
        const content = data.content || '';
        const truncated = content.substring(0, 60);
        const activity = {
          type: 'prompt',
          content: content.substring(0, 500),
          timestamp
        };
        activityBuffers.coder.unshift(activity);
        if (activityBuffers.coder.length > MAX_ACTIVITY_ITEMS) {
          activityBuffers.coder.length = MAX_ACTIVITY_ITEMS;
        }
        
        updateAgentState('coder', {
          state: 'active',
          substatus: 'thinking',
          message: `Working on: ${truncated}${content.length > 60 ? '...' : ''}`,
          lastActivity: timestamp
        });
        
        addFeedItem({
          agent: 'coder',
          type: 'prompt',
          message: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
          time: timestamp
        });
        
        broadcastSubstatusUpdate('coder');
        break;
      }
      
      case 'assistant.turn_start': {
        resetCopilotTurnContext();
        updateAgentState('coder', { substatus: 'thinking', toolName: null });
        broadcastSubstatusUpdate('coder');
        break;
      }
      
      case 'assistant.message': {
        // Extract report_intent from toolRequests for activity insight
        const toolRequests = data.toolRequests || [];
        const intentCall = toolRequests.find(t => t.name === 'report_intent');
        if (intentCall) {
          // Defensive: arguments may be a JSON string or parsed object
          const rawArgs = intentCall.arguments;
          const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
          if (args?.intent) {
            copilotTurnContext.lastIntentMessage = args.intent;
            updateAgentState('coder', {
              message: args.intent,
              substatus: 'thinking'
            });
            addFeedItem({
              agent: 'coder',
              type: 'info',
              message: args.intent,
              time: timestamp
            });
          }
        }
        
        // If there are tool requests (other than report_intent), show as tool activity
        const realTools = toolRequests.filter(t => t.name !== 'report_intent');
        if (realTools.length > 0) {
          copilotTurnContext.hasToolCalls = true;
          updateAgentState('coder', {
            substatus: 'tool',
            toolName: realTools[0].name
          });
        }
        
        // Use reasoningText if available for feed and attention context
        if (data.reasoningText) {
          const reasoning = data.reasoningText.replace(/^\*\*|\*\*$/g, '').trim();
          copilotTurnContext.lastReasoningText = reasoning;
          if (reasoning) {
            addFeedItem({
              agent: 'coder',
              type: 'info',
              message: `Thinking: ${reasoning.substring(0, 80)}`,
              time: timestamp
            });
          }
        }
        
        broadcastSubstatusUpdate('coder');
        break;
      }
      
      case 'tool.execution_start': {
        const toolName = data.toolName || 'unknown';
        copilotTurnContext.turnToolCount++;
        updateAgentState('coder', {
          substatus: 'tool',
          toolName
        });
        
        // Feed item for significant tools (skip report_intent, it's already handled)
        if (toolName !== 'report_intent') {
          addFeedItem({
            agent: 'coder',
            type: 'tool',
            message: `Running: ${toolName}`,
            time: timestamp
          });
        }
        
        broadcastSubstatusUpdate('coder');
        break;
      }
      
      case 'tool.execution_complete': {
        // Model can be extracted from tool results too
        if (data.model) {
          updateAgentState('coder', { model: data.model, provider: 'github-copilot' });
        }
        
        // After tool completes, go back to thinking
        updateAgentState('coder', { substatus: 'thinking', toolName: null });
        broadcastSubstatusUpdate('coder');
        break;
      }
      
      case 'assistant.turn_end': {
        // Turn complete — agent is now awaiting input
        // Check for attention using heuristic (see Task 9)
        if (checkCopilotNeedsAttention()) {
          updateAgentState('coder', {
            state: 'attention',
            substatus: 'awaiting-input',
            toolName: null,
            message: 'Waiting for your response'
          });
        } else {
          updateAgentState('coder', {
            substatus: 'awaiting-input',
            toolName: null
          });
        }
        
        // Add response activity
        const activity = {
          type: 'response',
          content: 'Turn completed',
          model: agentState?.agents?.coder?.model,
          timestamp
        };
        activityBuffers.coder.unshift(activity);
        if (activityBuffers.coder.length > MAX_ACTIVITY_ITEMS) {
          activityBuffers.coder.length = MAX_ACTIVITY_ITEMS;
        }
        
        broadcastSubstatusUpdate('coder');
        break;
      }
    }
}
```

### Phase 4: Attention Detection (Heuristic)

#### Task 8: Wire `pollCopilotActivity()` into the polling loop

In the `createApp()` setup section (near line 631-636), add copilot polling alongside OpenCode polling:

```js
// Existing OpenCode polling:
if (opencodeDb) {
    initLastSeenTimestamps();
    if (!config.skipPolling) {
      intervals.push(setInterval(pollOpenCodeActivity, ACTIVITY_POLL_INTERVAL));
    }
}

// NEW: Copilot polling (no DB dependency, always available)
if (!config.skipPolling) {
    intervals.push(setInterval(() => {
      // Only poll when coder is active
      const coderState = agentState?.agents?.coder?.state;
      if (coderState === 'active' || coderState === 'attention') {
        pollCopilotActivity();
      }
    }, ACTIVITY_POLL_INTERVAL));
}
```

Also expose `pollCopilotActivity` in the return object:

```js
return {
    app,
    getState,
    pollOpenCodeActivity,
    pollCopilotActivity,  // NEW
    cleanup,
    checkNeedsAttention,
    summarizeContent
};
```

#### Task 9: Implement `checkCopilotNeedsAttention()` heuristic

Since copilot encrypts assistant message content, we can't use the same regex approach as OpenCode agents. Instead, use a **heuristic based on available signals**:

```js
// Accumulates recent copilot event context for attention heuristic
let copilotTurnContext = {
  hasToolCalls: false,
  lastReasoningText: '',
  lastIntentMessage: '',
  turnToolCount: 0
};

function resetCopilotTurnContext() {
  copilotTurnContext = {
    hasToolCalls: false,
    lastReasoningText: '',
    lastIntentMessage: '',
    turnToolCount: 0
  };
}
```

Update `processCopilotEvent()` to populate this context:
- On `assistant.turn_start`: call `resetCopilotTurnContext()`
- On `assistant.message`: set `hasToolCalls = true` if `toolRequests.length > 0`, capture `reasoningText`
- On `tool.execution_start`: increment `turnToolCount`

Then the attention check:

```js
function checkCopilotNeedsAttention() {
  // Heuristic: A turn that ended WITHOUT any tool calls likely means
  // the agent is asking a question or waiting for input.
  // Turns that used tools are more likely delivering results.
  
  // Check reasoning text for question patterns (it's plaintext)
  if (copilotTurnContext.lastReasoningText) {
    const text = copilotTurnContext.lastReasoningText;
    if (ATTENTION_PATTERNS.find(p => p.test(text))) {
      return true;
    }
  }
  
  // Check last intent message for question indicators
  if (copilotTurnContext.lastIntentMessage) {
    const intent = copilotTurnContext.lastIntentMessage.toLowerCase();
    if (intent.includes('question') || intent.includes('clarif') || intent.includes('confirm')) {
      return true;
    }
  }
  
  // If the turn had zero tool calls, it's more likely a question/clarification
  // (but this is a weak signal — many short responses have no tool calls)
  // Don't use this alone; only combine with other signals.
  
  return false;
}
```

**Design note:** This is deliberately conservative. False negatives (missing attention) are acceptable — the agent still shows as "awaiting-input" with a slow pulse. False positives (wrong attention) are worse. We can tune over time using console logs.

### Phase 5: Polish and Cleanup

#### Task 10: Remove hardcoded model from `coder.ps1` banner

Now that model is detected from `session.start` events, remove the hardcoded model string:

```powershell
# BEFORE:
Write-Host "  Model: GPT-5.3 Codex (gh copilot)" -ForegroundColor DarkMagenta

# AFTER:
Write-Host "  Model: (detected from session)" -ForegroundColor DarkMagenta
```

Or remove the model line entirely — the dashboard will show the correct model.

#### Task 11: Update `OPENCODE_AGENTS` usage to be clear about scope

No functional change needed, but add a comment near `OPENCODE_AGENTS` to clarify:

```js
const OPENCODE_AGENTS = ['planner', 'reviewer', 'refactor'];  // Agents using opencode DB
// Note: 'coder' uses pollCopilotActivity() instead of pollOpenCodeActivity()
```

#### Task 12: Test and verify

1. **MCP servers**: Start a copilot session, ask it to `learnings_search("test")`. Verify the tool is available and returns results.

2. **Session discovery**: Launch coder via `.\scripts\coder.ps1`. Check server logs for session ID detection.

3. **Model detection**: Open dashboard at `http://localhost:3747`. Verify coder card shows actual model (e.g., "gpt-5.3-codex") instead of hardcoded label.

4. **Substatus tracking**: While coder is working:
   - Verify "Thinking..." appears during reasoning
   - Verify "Running: view" (or similar tool name) appears during tool use
   - Verify "Awaiting input" appears when turn ends

5. **Activity feed**: Verify coder prompts and tool usage appear in the activity feed sidebar.

6. **Attention detection**: Send a prompt that will cause the coder to ask a question. Verify the card shows fast-pulse attention state (if the heuristic fires — this may need tuning).

7. **Run existing tests**: `npm test` — all ~80 existing tests should still pass (they use `config.skipPolling` so copilot polling won't interfere).

## Data Flow

```
User sends prompt in Copilot TUI
  → Copilot writes to events.jsonl
    → pollCopilotActivity() reads new lines (every 2s)
      → processCopilotEvent() maps events to state updates
        → updateAgentState('coder', {...})
          → broadcastSSE() pushes to dashboard
            → Dashboard card updates in real-time


Session Discovery (server-side only):
  coder.ps1 POSTs state: 'active' → server starts polling →
    pollCopilotActivity() → findActiveCopilotSession()
      → scans ~/.copilot/session-state/*/workspace.yaml
      → picks most recently updated_at session within 5 minutes
      → caches result in copilotSessionId (re-scans only on session change)

Session Initialization (on discovery or session change):
  initCopilotEventIndex(eventsPath)
    → skips copilotLastEventIndex to end of file (avoids feed flood)
    → backtrack-scans for session.start to extract model info
  resetCopilotTurnContext()
    → clears stale attention state from previous session
```

## Design Decisions

### Why file polling instead of watching?

`fs.watch` / `chokidar` on Windows is unreliable for files being appended to — it can miss events or fire spuriously. Reading the full file every 2 seconds is simple, reliable, and fast for files under 100KB. The line-offset tracking (`copilotLastEventIndex`) ensures we only process new events.

### Why not parse YAML properly?

Adding a YAML parser dependency for one simple field extraction (`updated_at`) isn't worth it. The regex `updated_at:\s*(.+)` is reliable for this known format. If the YAML structure changes, the fallback is that session discovery fails and the wrapper's reported session ID is used instead.

### Why server-side session discovery instead of wrapper-based?

The alternative was having `coder.ps1` use a PowerShell background job to detect the new session directory (snapshot dirs before launch, diff after). This has several problems: `Start-Job` is slow (~1-2s overhead on Windows), it runs in a separate process, it needs cleanup (`Remove-Job`), and if copilot reuses an existing session the dir diff finds nothing. Server-side discovery via `findActiveCopilotSession()` handles both new and reused sessions with zero wrapper complexity. The result is cached in `copilotSessionId` so the 12+ workspace.yaml scan only happens once per session transition.

### Why conservative attention detection?

Without access to assistant message text (encrypted), we can only use weak signals: reasoning text, intent messages, and tool call patterns. Aggressive heuristics would cause false positives. It's better to under-detect attention (agent shows "awaiting input" with gentle pulse) than to over-detect it (agent incorrectly shows urgent "attention" state).

## Risks / Open Questions

1. **MCP config format** — The `~/.copilot/mcp-config.json` schema hasn't been documented publicly. If copilot doesn't recognize the `mcpServers` key structure, we'll need to check `gh copilot -- --help` for the exact format or test empirically. The `--additional-mcp-config` flag is confirmed to exist.

2. **events.jsonl file locking** — Copilot writes events while we read them. On Windows, this could cause `EBUSY` errors. The `try/catch` around `readFileSync` handles this gracefully (we skip that poll cycle and retry 2s later).

3. **Session reuse** — If copilot reuses sessions (e.g., resuming a previous session in the same workspace), the server-side `findActiveCopilotSession()` handles this correctly by selecting the most recently `updated_at` session. The `initCopilotEventIndex()` skip-to-end logic prevents replaying old events from resumed sessions.

4. **encrypted content** — If GitHub changes copilot to encrypt more fields (e.g., `reasoningText`, tool arguments), our activity tracking will lose fidelity. Currently, these fields are plaintext and provide good signals.

5. **Performance at scale** — Reading a full file every 2 seconds works for sessions up to ~1000 events (~500KB). For very long sessions, we could switch to byte-offset tracking (store `lastBytesRead`, seek to that position). This is an optimization we can add later if needed.

6. **Test coverage** — The copilot polling code needs new tests. Follow the existing test pattern in `__tests__/` — create mock events.jsonl data, test `processCopilotEvent()` mapping, test `findActiveCopilotSession()` with mock workspace.yaml files. The `createApp({ skipPolling: true })` pattern keeps tests isolated.

7. **SHORTCUT_API_TOKEN in mcp-config.json** — If copilot doesn't support env var interpolation in config files, the token will need to be set in the shell environment before launching copilot (which it already is, since the OpenCode agents work). Test this during Task 1.

## Implementation Order

The tasks are designed to be implemented in phases with verification gates:

1. **Phase 1 (Tasks 1-2)**: MCP parity — can be done immediately, independent of everything else
2. **Phase 2 (Task 4)**: Session wiring — accept optional sessionId in POST /status (Task 3 is no-op; wrapper stays simple with server-side discovery)
3. **Phase 3 (Tasks 5-7)**: Core polling — the big piece, depends on Phase 2
4. **Phase 4 (Tasks 8-9)**: Attention — depends on Phase 3
5. **Phase 5 (Tasks 10-12)**: Polish and testing — after everything works

Each phase can be committed independently and verified before moving to the next.
