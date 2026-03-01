# Plan: Real-Time Agent Streaming

## Goal

Transform agent-hub from a slow, stale polling dashboard into a **real-time activity monitor** that shows what agents are actually doing as they work, with sub-second UI updates and live visibility into prompts, responses, and current tasks.

## Background

### Current State

The agent-hub currently has significant limitations:

1. **Stale model information** — Dashboard shows "Claude Opus 4.6" when agent is actually using "Claude Sonnet 4.5" because it relies on OpenCode DB queries that only update after a message is sent
2. **No visibility into active work** — Can't see what task an agent is currently working on
3. **Slow updates** — Browser polls every 5s, server caches for 10s = up to 15s lag
4. **Manual state management** — Wrapper scripts only POST status on start/stop, no mid-session updates
5. **No context in activity feed** — Feed shows "Session started" / "Session ended" but not what happened during the session

### What We Need

A **live activity monitor** that shows:
- ✅ Which agents are running RIGHT NOW
- ✅ What model each agent is ACTUALLY using (updated instantly)
- ✅ What each agent is working on (current prompt/task)
- ✅ How long agents have been active
- ✅ Detailed activity history (prompts, responses, state changes)

### Architecture Shift

**From:** Passive polling + manual lifecycle reporting
**To:** Smart DB polling + real-time SSE push

```
OLD FLOW:
  User → Agent → OpenCode DB → (10s cache) → Server ← (5s poll) ← UI
  Total lag: up to 15 seconds

NEW FLOW:
  User → Agent → OpenCode DB → (2s poll) → Server → (SSE push) → UI
  Wrapper scripts → POST /status on start/stop → Server → (SSE push) → UI
  Total lag: under 2 seconds for activity, instant for lifecycle
```

### Key Design Decision: DB Polling Over I/O Capture

**OpenCode and gh copilot are interactive TUI applications.** They use raw terminal I/O, ANSI escape sequences, cursor positioning, and other features that make `ProcessStartInfo` I/O redirection impossible — redirecting stdin/stdout breaks the TUI entirely.

Instead, the server polls the **OpenCode SQLite database** (which already records every message with model info, timestamps, and content) at a fast interval (2 seconds). This gives us:

- **Zero wrapper overhead** — Agents run unmodified in their native TUI
- **Reliable data** — OpenCode's own DB is the source of truth
- **Model, prompt, and response content** — All available from the `message` table
- **Works for all opencode agents** — planner, reviewer, refactor

For the **coder agent** (gh copilot, which doesn't use OpenCode), the wrapper script continues to handle lifecycle (start/stop) only. Coder activity tracking is out of scope until it migrates to opencode.

## Files Involved

| File | Changes |
|------|---------|
| `status-server.js` | Add SSE endpoint (`GET /stream`), add DB activity poller, in-memory state with periodic flush, unified feed |
| `agent-hub.html` | Replace polling with `EventSource`, real-time card updates, activity history UI, typing indicators (XSS-safe) |
| `scripts/planner.ps1` | Minor: remove hardcoded model string, keep lifecycle POST only |
| `scripts/reviewer.ps1` | Minor: remove hardcoded model string, keep lifecycle POST only |
| `scripts/refactor.ps1` | Minor: remove hardcoded model string, keep lifecycle POST only |
| `scripts/coder.ps1` | No changes (lifecycle POST only, no DB-based activity) |
| `package.json` | No new dependencies (already has `better-sqlite3`, `express`, `cors`) |

## Tasks

### Phase 1: Server-Side Streaming Foundation

#### Task 1.1: Move to in-memory state with periodic flush

**File:** `status-server.js`

**Problem:** The current code calls `writeJSON(STATUS_FILE, status)` synchronously on every incoming request. This blocks the event loop and creates race conditions when multiple agents post simultaneously.

**Solution:** Hold authoritative state in memory. Flush to disk periodically (every 5 seconds) for crash recovery only. Load from disk only on server startup.

Replace the current `loadStatus()`/`writeJSON()` pattern:

```javascript
// ─── In-Memory State ──────────────────────────────────────────
// Authoritative state lives in memory. Disk is for crash recovery only.

let agentState = null; // Loaded once at startup

function initState() {
  // Load from disk on startup, then memory is authoritative
  agentState = readJSON(STATUS_FILE, getDefaultStatus());
}

function getState() {
  return agentState;
}

function updateAgentState(agent, updates) {
  if (!agentState.agents[agent]) return;
  Object.assign(agentState.agents[agent], updates);
  agentState.agents[agent].updated = new Date().toISOString();
}

// Periodic flush to disk (every 5 seconds)
setInterval(() => {
  try {
    writeJSON(STATUS_FILE, agentState);
  } catch (e) {
    console.warn('[flush] Failed to write status.json:', e.message);
  }
}, 5000);

// Also flush on clean shutdown
process.on('SIGINT', () => {
  writeJSON(STATUS_FILE, agentState);
  process.exit(0);
});
```

**Key changes:**
- `loadStatus()` is called **only at startup** (renamed to `initState()`)
- `writeJSON()` is called **only by the periodic flush timer**, never in request handlers
- All request handlers read/write from `agentState` in memory (synchronous, non-blocking)
- State survives server restart via periodic disk flush

#### Task 1.2: Add Server-Sent Events (SSE) endpoint

**File:** `status-server.js`

Add a `GET /stream` endpoint that keeps connections open and pushes events to the browser:

```javascript
// ─── SSE ──────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[sse] Client connected (${sseClients.size} active)`);

  // Send full current state on connect
  const status = getState();
  const models = getLatestModels();
  for (const [agent, modelInfo] of Object.entries(models)) {
    if (status.agents[agent]) {
      status.agents[agent].model = modelInfo.model;
      status.agents[agent].provider = modelInfo.provider;
    }
  }
  // Include recent activity buffers
  for (const agent of VALID_AGENTS) {
    if (status.agents[agent]) {
      status.agents[agent].recentActivity = activityBuffers[agent].slice(0, 5);
    }
  }
  res.write(`data: ${JSON.stringify({ type: 'init', status, feed: feedBuffer })}\n\n`);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[sse] Client disconnected (${sseClients.size} active)`);
  });
});

function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch (e) {
      // Will be cleaned up on 'close' event
    }
  }
}
```

**Why SSE over WebSocket:**
- Simpler (unidirectional push, which is all we need)
- Browser's `EventSource` handles reconnection natively
- Works over standard HTTP, no extra packages
- No bidirectional communication needed

#### Task 1.3: Unified in-memory feed

**File:** `status-server.js`

**Problem:** The current design has two feed paths — a file-based `feed.json` (polled via `GET /feed`) and SSE push events. This creates confusion about which path is authoritative and can lead to duplicate or missing events.

**Solution:** One in-memory feed buffer that is both:
- **Pushed** to SSE clients in real-time
- **Served** via `GET /feed` for initial load and SSE-less fallback

```javascript
// ─── Unified Feed ─────────────────────────────────────────────
// Single in-memory feed. SSE clients get push, GET /feed gets snapshot.
const MAX_FEED_ITEMS = 50;
let feedBuffer = readJSON(FEED_FILE, []); // Seed from disk on startup

function addFeedItem(item) {
  const feedItem = {
    agent: item.agent,
    type: item.type || 'info',       // prompt, response, thinking, lifecycle, error, info
    message: item.message || '',
    time: item.time || new Date().toISOString()
  };

  feedBuffer.unshift(feedItem);
  if (feedBuffer.length > MAX_FEED_ITEMS) {
    feedBuffer.length = MAX_FEED_ITEMS;
  }

  // Push to SSE clients immediately
  broadcastSSE({ type: 'feed', item: feedItem });
}

// GET /feed — Returns current feed snapshot (for initial load or fallback)
app.get('/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, MAX_FEED_ITEMS);
  res.json(feedBuffer.slice(0, limit));
});

// Periodic flush feed to disk
setInterval(() => {
  try {
    writeJSON(FEED_FILE, feedBuffer);
  } catch (e) {
    console.warn('[flush] Failed to write feed.json:', e.message);
  }
}, 5000);
```

**Feed event flow (single path):**
1. Something happens (lifecycle POST, DB poller detects new message)
2. → `addFeedItem()` stores in `feedBuffer` and calls `broadcastSSE()`
3. SSE clients receive instantly; `GET /feed` returns the same data

Remove the old `POST /feed` endpoint and the direct `feed.json` writes from `POST /status`.

#### Task 1.4: Update POST /status for lifecycle events

**File:** `status-server.js`

Simplify `POST /status` to only handle lifecycle events (session start/stop) from wrapper scripts. It no longer writes to disk directly — it updates in-memory state and broadcasts via SSE:

```javascript
app.post('/status', (req, res) => {
  const { agent, state, message } = req.body;

  if (!agent || !VALID_AGENTS.includes(agent)) {
    return res.status(400).json({
      error: `Invalid agent. Must be one of: ${VALID_AGENTS.join(', ')}`
    });
  }
  if (!state || !VALID_STATES.includes(state)) {
    return res.status(400).json({
      error: `Invalid state. Must be one of: ${VALID_STATES.join(', ')}`
    });
  }

  // Update in-memory state (no disk write)
  updateAgentState(agent, {
    state,
    message: message || ''
  });

  // Add to unified feed
  addFeedItem({
    agent,
    type: 'lifecycle',
    message: message || `State changed to ${state}`,
    time: new Date().toISOString()
  });

  // Broadcast full agent state update via SSE
  broadcastSSE({
    type: 'agent-update',
    agent,
    data: agentState.agents[agent]
  });

  console.log(`[status] ${agent} → ${state}: ${message || '(no message)'}`);
  res.json({ ok: true, agent, state });
});
```

#### Task 1.5: Add DB activity poller

**File:** `status-server.js`

This is the core of real-time activity detection. Poll the OpenCode SQLite DB every 2 seconds for new messages. When a new message appears, extract the prompt/response content and model, update state, and push via SSE.

```javascript
// ─── DB Activity Poller ───────────────────────────────────────
// Polls the opencode DB for new messages every 2 seconds.
// This is how we detect prompts, responses, and model changes
// without intercepting TUI I/O.

const ACTIVITY_POLL_INTERVAL = 2000;

// Activity buffer — store last 10 items per agent for card display
const activityBuffers = {
  planner: [],
  coder: [],
  reviewer: [],
  refactor: []
};
const MAX_ACTIVITY_ITEMS = 10;

// Track the last seen message timestamp per agent to detect new messages
let lastSeenTimestamps = {};

function pollOpenCodeActivity() {
  if (!opencodeDb) return;

  try {
    // Query for messages newer than our last checkpoint, per agent
    const agents = ['planner', 'reviewer', 'refactor'];

    for (const agent of agents) {
      const lastSeen = lastSeenTimestamps[agent] || '1970-01-01T00:00:00Z';

      const rows = opencodeDb.prepare(`
        SELECT
          json_extract(data, '$.role') as role,
          json_extract(data, '$.modelID') as model,
          json_extract(data, '$.providerID') as provider,
          json_extract(data, '$.content') as content,
          time_created
        FROM message
        WHERE json_extract(data, '$.agent') = ?
          AND time_created > ?
        ORDER BY time_created ASC
      `).all(agent, lastSeen);

      for (const row of rows) {
        lastSeenTimestamps[agent] = row.time_created;

        const activityType = row.role === 'user' ? 'prompt' : 'response';

        // Extract first line / meaningful summary from content
        let contentSummary = '';
        if (row.content) {
          // Content may be a JSON array of content blocks or a plain string
          try {
            const parsed = JSON.parse(row.content);
            if (Array.isArray(parsed)) {
              // Find first text block
              const textBlock = parsed.find(b => b.type === 'text');
              contentSummary = textBlock?.text || '';
            } else if (typeof parsed === 'string') {
              contentSummary = parsed;
            }
          } catch {
            contentSummary = String(row.content);
          }
          // Truncate to 500 chars
          if (contentSummary.length > 500) {
            contentSummary = contentSummary.substring(0, 500) + '...';
          }
        }

        // Build activity event
        const activity = {
          type: activityType,
          content: contentSummary,
          model: row.model || undefined,
          timestamp: row.time_created
        };

        // Store in activity buffer
        activityBuffers[agent].unshift(activity);
        if (activityBuffers[agent].length > MAX_ACTIVITY_ITEMS) {
          activityBuffers[agent].length = MAX_ACTIVITY_ITEMS;
        }

        // Update agent state
        if (activityType === 'prompt') {
          const truncated = contentSummary.substring(0, 60);
          updateAgentState(agent, {
            state: 'active',
            message: `Working on: ${truncated}${contentSummary.length > 60 ? '...' : ''}`,
            lastActivity: row.time_created
          });
        } else if (activityType === 'response') {
          updateAgentState(agent, {
            state: 'active',
            message: 'Responded',
            lastActivity: row.time_created
          });
          // Update model from response (assistant messages carry the model)
          if (row.model) {
            updateAgentState(agent, { model: row.model, provider: row.provider });
          }
        }

        // Add to unified feed
        addFeedItem({
          agent,
          type: activityType,
          message: contentSummary.substring(0, 100) + (contentSummary.length > 100 ? '...' : ''),
          time: row.time_created
        });

        // Broadcast agent state update via SSE
        broadcastSSE({
          type: 'agent-update',
          agent,
          data: {
            ...agentState.agents[agent],
            recentActivity: activityBuffers[agent].slice(0, 3)
          }
        });
      }
    }
  } catch (e) {
    // Don't log on every poll failure — could be DB locked
    if (e.message && !e.message.includes('SQLITE_BUSY')) {
      console.warn('[activity-poll] Error:', e.message);
    }
  }
}

// Start polling (only if DB is available)
if (opencodeDb) {
  // Initialize lastSeenTimestamps to current latest per agent
  // so we don't replay the entire history on startup
  try {
    const latest = opencodeDb.prepare(`
      SELECT json_extract(data, '$.agent') as agent, MAX(time_created) as latest
      FROM message
      WHERE json_extract(data, '$.agent') IN ('planner', 'reviewer', 'refactor')
      GROUP BY json_extract(data, '$.agent')
    `).all();

    for (const row of latest) {
      lastSeenTimestamps[row.agent] = row.latest;
    }
    console.log('[activity-poll] Initialized timestamps, polling every 2s');
  } catch (e) {
    console.warn('[activity-poll] Could not initialize timestamps:', e.message);
  }

  setInterval(pollOpenCodeActivity, ACTIVITY_POLL_INTERVAL);
}
```

**Key design points:**
- Polls every 2 seconds (fast enough for real-time feel, low overhead)
- Tracks `lastSeenTimestamps` per agent so it only processes new messages
- On startup, initializes timestamps to the latest message per agent (no history replay)
- Handles `SQLITE_BUSY` silently (opencode may be writing)
- Content is truncated to 500 chars for privacy/memory
- Model info comes from assistant messages (the DB source of truth)
- Coder agent is excluded (uses gh copilot, not opencode)

#### Task 1.6: Simplify GET /status

**File:** `status-server.js`

Since model info now comes from the DB poller (stored in `agentState`), and activity is in `activityBuffers`, the status endpoint is a simple read:

```javascript
app.get('/status', (req, res) => {
  const status = getState();

  // Enrich with model data from DB poller (already in agentState for opencode agents)
  // Also run getLatestModels() as fallback for agents that haven't posted activity yet
  const models = getLatestModels();
  for (const [agent, modelInfo] of Object.entries(models)) {
    if (status.agents[agent] && !status.agents[agent].model) {
      status.agents[agent].model = modelInfo.model;
      status.agents[agent].provider = modelInfo.provider;
    }
  }

  // Include recent activity
  for (const agent of VALID_AGENTS) {
    if (status.agents[agent]) {
      status.agents[agent].recentActivity = activityBuffers[agent].slice(0, 3);
    }
  }

  res.json(status);
});
```

**Note:** `getLatestModels()` (the existing cached DB query from the prior plan) is kept as a fallback for cases where the activity poller hasn't run yet. Reduce its cache TTL from 10s to 30s since it's now just a fallback, not the primary source.

---

### Phase 2: Wrapper Script Cleanup

#### Task 2.1: Simplify wrapper scripts

**Files:** `scripts/planner.ps1`, `scripts/reviewer.ps1`, `scripts/refactor.ps1`

The wrappers no longer need hardcoded model strings or streaming logic. They handle **lifecycle only** (session start/stop). Model info comes from the DB poller.

**Example for `planner.ps1`:**

```powershell
# Agent Hub — Planner Wrapper
# Posts lifecycle status to the hub server on start/exit
# Model detection is automatic via OpenCode DB polling
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

**What changed from current wrappers:**
- Removed hardcoded model string from banner (`Write-Host "  Model: Claude Opus 4.6"`)
- Removed `-m` flag from opencode command (model is set in opencode config, not the wrapper)
- Added informational line about DB-based activity streaming
- Everything else stays the same

**Repeat for `reviewer.ps1` and `refactor.ps1`** with appropriate agent name and colors.

**`coder.ps1` stays as-is** — no changes needed. It continues to post lifecycle events. Coder activity tracking is out of scope until it migrates to opencode.

---

### Phase 3: Real-Time UI Updates

#### Task 3.1: Replace polling with SSE

**File:** `agent-hub.html`

Replace the current polling-based `setInterval(pollStatus, 5000)` with an SSE `EventSource` connection. Let the browser handle reconnection natively — **do not fight the built-in auto-reconnect**.

```javascript
// ─── SSE Connection ────────────────────────────────────────────
let eventSource = null;

function connectSSE() {
  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    console.log('[sse] Connected');
    setOnline(true);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'init':
          // Full state on connect/reconnect
          updateCards(data.status.agents);
          lastAgentsData = data.status.agents || {};
          updateFeed(data.feed || []);
          break;

        case 'agent-update':
          // Single agent state change (from lifecycle POST or DB poller)
          if (lastAgentsData[data.agent]) {
            lastAgentsData[data.agent] = data.data;
          }
          updateCards(lastAgentsData);
          break;

        case 'feed':
          // New feed item
          addFeedItem(data.item);
          break;
      }
    } catch (e) {
      console.error('[sse] Failed to parse event:', e);
    }
  };

  eventSource.onerror = () => {
    // Browser will auto-reconnect with backoff.
    // Just update UI to show offline state.
    setOnline(false);
  };
}
```

**Key differences from original plan:**
- **No manual close/reconnect** — `EventSource` natively reconnects with exponential backoff. The `onerror` handler only updates the UI; it does NOT close the connection or `setTimeout` to reconnect.
- **No parallel polling fallback** — Remove `setInterval(pollStatus, POLL_INTERVAL)` and `setInterval(pollFeed, POLL_INTERVAL)`. SSE `init` event on (re)connect provides the full state, making polling redundant.
- **Three event types:** `init` (full sync), `agent-update` (single agent change), `feed` (new feed item)

**Remove from init section:**
```javascript
// DELETE these lines — SSE replaces them:
// pollStatus();
// pollFeed();
// setInterval(pollStatus, POLL_INTERVAL);
// setInterval(pollFeed, POLL_INTERVAL);

// REPLACE with:
connectSSE();
```

Keep the `pollStatus()` and `pollFeed()` functions in the code but don't call them on a timer — they can serve as manual refresh if needed.

#### Task 3.2: Update feed rendering for unified feed

**File:** `agent-hub.html`

The feed now receives items via SSE `feed` events. Add a function to append a single item to the DOM (the existing `updateFeed()` handles full replacement for `init`):

```javascript
function addFeedItem(item) {
  const feed = document.getElementById('feed');
  const countEl = document.getElementById('feedCount');

  // Clear empty placeholder
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();

  const agentColors = {
    planner: 'var(--planner-primary)',
    coder: 'var(--coder-primary)',
    reviewer: 'var(--reviewer-primary)',
    refactor: 'var(--refactor-primary)'
  };
  const agentNames = {
    planner: 'Planner',
    coder: 'Coder',
    reviewer: 'Reviewer',
    refactor: 'Refactor'
  };

  const time = new Date(item.time).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const color = agentColors[item.agent] || 'var(--muted)';
  const name = agentNames[item.agent] || item.agent;

  const el = document.createElement('div');
  el.className = 'feed-item';
  el.innerHTML = `
    <span class="feed-time">${escapeHtml(time)}</span>
    <div class="feed-dot" style="background:${color}"></div>
    <div class="feed-msg"><strong style="color:${color}">${escapeHtml(name)}</strong> &mdash; ${escapeHtml(item.message)}</div>
  `;

  feed.insertBefore(el, feed.firstChild);

  // Cap at 20 visible items
  while (feed.children.length > 20) {
    feed.removeChild(feed.lastChild);
  }

  countEl.textContent = `${feed.children.length} event${feed.children.length !== 1 ? 's' : ''}`;
}
```

**Note:** All dynamic content uses `escapeHtml()` — no raw string interpolation into `innerHTML`.

#### Task 3.3: Add current activity display to agent cards

**File:** `agent-hub.html`

**3.3a. Add activity section to card HTML**

Inside each agent card's `.agent-body`, after the `.agent-stack` div and before `.agent-status-row`, add:

```html
<div class="agent-current-activity" id="activity-planner" style="display:none;">
  <div class="activity-label">Currently:</div>
  <div class="activity-text" id="activity-text-planner"></div>
  <div class="activity-time" id="activity-time-planner"></div>
</div>
```

Repeat for all agents: `activity-coder`, `activity-reviewer`, `activity-refactor`.

**3.3b. Add CSS for activity display and typing indicator**

```css
.agent-current-activity {
  margin-bottom: 14px;
  padding: 10px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border);
}

.activity-label {
  font-size: 9px;
  font-family: 'Share Tech Mono', monospace;
  letter-spacing: 0.15em;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 6px;
}

.activity-text {
  font-size: 11px;
  color: var(--text);
  line-height: 1.5;
  max-height: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.activity-time {
  font-size: 9px;
  color: var(--muted);
  margin-top: 4px;
  font-style: italic;
}

/* Typing indicator */
.typing-indicator {
  display: inline-flex;
  gap: 4px;
  margin-left: 6px;
  vertical-align: middle;
}

.typing-indicator span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--agent-color);
  animation: typingPulse 1.2s infinite;
}

.typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

@keyframes typingPulse {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}
```

**3.3c. Update `updateCards()` to show current activity (XSS-safe)**

Inside the `for` loop in `updateCards()`, after updating model and status, add activity display logic. **All dynamic content must use `textContent`, not `innerHTML`:**

```javascript
// Update current activity display
const activityEl = document.getElementById(`activity-${name}`);
const activityTextEl = document.getElementById(`activity-text-${name}`);
const activityTimeEl = document.getElementById(`activity-time-${name}`);

if (activityEl && info.recentActivity && info.recentActivity.length > 0) {
  const latest = info.recentActivity[0];

  activityEl.style.display = 'block';

  // SAFE: Use textContent, never innerHTML with user content
  activityTextEl.textContent = latest.content.substring(0, 150);

  // Append typing indicator as DOM nodes (not innerHTML)
  if (latest.type === 'prompt' && state === 'active') {
    const indicator = document.createElement('span');
    indicator.className = 'typing-indicator';
    indicator.innerHTML = '<span></span><span></span><span></span>'; // Static HTML, no user data
    activityTextEl.appendChild(indicator);
  }

  // Show relative time
  activityTimeEl.textContent = getTimeAgo(new Date(latest.timestamp));
} else if (activityEl) {
  activityEl.style.display = 'none';
}
```

**XSS fix:** The original plan used `innerHTML` to inject `latest.content` directly, which is an XSS vector. The fix:
- Set `textContent` for the content string (auto-escapes HTML entities)
- Create the typing indicator as DOM elements and `appendChild()` them
- The typing indicator's `innerHTML` contains only static markup (no user data)

**3.3d. Add time-ago helper**

```javascript
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

// Refresh time-ago displays every 10 seconds
setInterval(() => {
  for (const name of Object.keys(lastAgentsData)) {
    const activityTimeEl = document.getElementById(`activity-time-${name}`);
    const info = lastAgentsData[name];

    if (activityTimeEl && info?.recentActivity?.[0]) {
      activityTimeEl.textContent = getTimeAgo(new Date(info.recentActivity[0].timestamp));
    }
  }
}, 10000);
```

---

### Phase 4: Testing & Verification

#### Task 4.1: Manual testing checklist

After implementing all tasks, verify with this sequence:

1. **Start the status server:**
   ```bash
   npm start
   ```
   Should see: `AGENT HUB — Status Server` banner, `[activity-poll] Initialized timestamps, polling every 2s`

2. **Open the dashboard:**
   ```
   http://localhost:3747
   ```
   Should see: All 4 agent cards in "Idle" state, "CONNECTING..." status, then "LIVE". Check browser console for `[sse] Connected`.

3. **Launch an agent with the wrapper:**
   ```powershell
   .\scripts\planner.ps1
   ```
   **Expected:**
   - Dashboard immediately shows Planner in "Active" state (via lifecycle POST → SSE push)
   - Activity feed shows "Session started"

4. **Send a prompt to the agent:**
   Type a question in the opencode TUI and press Enter.
   **Expected (within 2 seconds):**
   - Dashboard shows "Currently: [your prompt]" in Planner card
   - Model tag updates to the actual model being used (from DB)
   - Activity feed shows new entry with prompt text

5. **Wait for agent response:**
   **Expected (within 2 seconds of response completing):**
   - Activity area updates with response text
   - Typing indicator appears after prompt, disappears after response
   - "just now" timestamp shows

6. **Switch models mid-session (in opencode):**
   Change model via opencode's UI, then send a prompt.
   **Expected:**
   - Model tag updates automatically within 2 seconds (DB poller detects new model from assistant message)
   - No wrapper restart needed

7. **Test offline resilience:**
   - Kill status server with Ctrl+C
   **Expected:**
   - Dashboard shows "OFFLINE" banner
   - Browser's native SSE reconnection kicks in (check console — no manual reconnect spam)
   - Agent continues working normally (wrapper POST failures are silent)
   - When server restarts, SSE reconnects and `init` event re-syncs full state

8. **Test multiple agents:**
   - Launch planner, reviewer simultaneously
   **Expected:**
   - Both cards show "Active" state
   - Each card shows its own current activity (from DB, per-agent)
   - Activity feed interleaves events from both agents
   - Header shows "2 active"

9. **Long-running session:**
   - Keep agent running for 5+ minutes
   **Expected:**
   - Time-ago updates every 10s ("2m ago" → "3m ago")
   - SSE heartbeat keeps connection alive (no reconnects in console)
   - Activity buffer caps at 10 items per agent

10. **Server restart during session:**
    - Restart `npm start` while agent is running
    **Expected:**
    - State loads from `status.json` (periodic flush)
    - SSE reconnects and sends `init` with current state
    - DB poller resumes with last-seen timestamps

#### Task 4.2: Edge case testing

1. **Agent never used in opencode DB** — No DB rows for that agent → model shows `defaultModel`, no activity, no errors
2. **OpenCode DB locked** — Agent is writing at same time → `SQLITE_BUSY` handled silently, retry on next poll
3. **OpenCode DB doesn't exist** — Server starts normally, activity polling disabled, lifecycle events still work
4. **Very long message content** — DB poller truncates to 500 chars, UI truncates to 150 chars
5. **Rapid messages** — Multiple messages within 2s polling window → all processed in order on next poll
6. **Server crash/kill** — State flushed to disk every 5s, at most 5s of data loss on restart

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ User Terminal (TUI — unmodified)                           │
│   User types prompt → opencode processes → writes to DB    │
└────────────┬────────────────────────────────────────────────┘
             │ (opencode writes to its own SQLite DB)
             ▼
┌─────────────────────────────────────────────────────────────┐
│ OpenCode SQLite DB                                         │
│   message table: role, agent, modelID, content, timestamp  │
└────────────┬────────────────────────────────────────────────┘
             │ read-only query (every 2s)
             ▼
┌─────────────────────────────────────────────────────────────┐
│ Express Server (status-server.js)                          │
│   DB Poller → detects new messages                         │
│   → updates in-memory agentState                           │
│   → adds to unified feedBuffer                             │
│   → broadcastSSE() to all clients                          │
│                                                             │
│   Also receives:                                            │
│   POST /status from wrappers (lifecycle start/stop)        │
│   → same path: update state, feed, broadcast SSE           │
│                                                             │
│   Periodic flush: state + feed → disk (every 5s)           │
└────────────┬────────────────────────────────────────────────┘
             │ Server-Sent Event (instant)
             ▼
┌─────────────────────────────────────────────────────────────┐
│ Browser UI (agent-hub.html)                                │
│   EventSource receives:                                     │
│     init       → full state sync on connect                │
│     agent-update → update single agent card                │
│     feed       → prepend item to activity feed             │
│                                                             │
│   All content rendered via textContent (XSS-safe)          │
└─────────────────────────────────────────────────────────────┘

Latency:
  Lifecycle events (start/stop): < 500ms (direct POST → SSE)
  Activity events (prompts/responses): < 2.5s (DB poll interval + processing)
  Model changes: < 2.5s (detected from next assistant message in DB)
```

## Design Decisions

### 1. DB Polling vs. I/O Capture

**Decision:** DB polling (2-second interval)

**Why:** OpenCode and gh copilot are interactive TUI applications that use raw terminal I/O (ANSI escape codes, cursor positioning, alternate screen buffers). `ProcessStartInfo` I/O redirection breaks TUI rendering entirely. The OpenCode SQLite DB already records every message with full metadata — it's a reliable, non-invasive source of truth.

**Trade-off:** 2-second delay vs. truly instant updates. Acceptable because:
- Lifecycle events (start/stop) are still instant via wrapper POST
- 2 seconds is fast enough for a monitoring dashboard
- No risk of breaking agent functionality

### 2. In-Memory State with Periodic Flush

**Decision:** Hold state in memory, flush to disk every 5 seconds

**Why:** The original code called `writeJSON()` synchronously on every incoming request, which:
- Blocks the Node.js event loop during disk I/O
- Creates race conditions when multiple agents POST simultaneously
- Causes unnecessary disk wear for transient state

In-memory state is fast and race-free (single-threaded Node.js). Disk persistence is only for crash recovery.

### 3. Unified Feed Path (SSE only)

**Decision:** One in-memory feed buffer, pushed via SSE, served via GET /feed for initial load

**Why:** The original design had two feed paths — file-based `feed.json` (polled) and SSE push — creating confusion about which was authoritative. The unified approach:
- Single source of truth (`feedBuffer` array)
- SSE clients get real-time push
- `GET /feed` returns the same data (for SSE `init` and potential non-SSE clients)
- Disk flush is for persistence only, never read in request handlers

### 4. Native SSE Reconnection

**Decision:** Let `EventSource` handle its own reconnection

**Why:** The original plan's `onerror` handler closed the connection and did `setTimeout(connectSSE, 3000)`, which fights the browser's built-in reconnection (which already does exponential backoff). The fix:
- `onerror` only updates UI state (show offline banner)
- Browser reconnects automatically
- On reconnect, `init` event re-syncs full state
- No duplicate connections, no manual retry logic

### 5. Model Detection from DB (not wrapper)

**Decision:** Model info comes from the OpenCode DB, not hardcoded in wrapper scripts

**Why:** Hardcoding `$Model = "github-copilot/claude-sonnet-4.5"` in wrapper scripts reintroduces the exact staleness problem we're solving. Users change models in opencode's config or via CLI flags — the wrapper wouldn't know. The DB records the actual model used on every assistant message, which is the true source of truth.

## Success Criteria

This plan is successfully implemented when:

✅ **Model updates automatically** — Switching models in opencode shows in dashboard within 2 seconds, no wrapper restart needed
✅ **Live activity visible** — Can see what each agent is currently working on (prompt text)
✅ **Fast updates** — Lifecycle events (start/stop) appear within 500ms, activity within 2.5s
✅ **Activity history** — Last 10 prompts/responses visible per agent
✅ **SSE-driven UI** — No polling timers, instant push for all updates
✅ **XSS-safe** — All user content rendered via `textContent`, no raw `innerHTML`
✅ **Graceful degradation** — Works even if hub server or OpenCode DB is unavailable
✅ **No agent overhead** — Agents run unmodified in native TUI, zero wrapper I/O capture
✅ **Multi-agent support** — All opencode agents tracked simultaneously from shared DB

## Notes

- The **coder agent** (gh copilot) is excluded from DB-based activity tracking because it doesn't use opencode. It gets lifecycle events only (start/stop). Activity tracking for coder will come when it migrates to opencode.
- The existing `getLatestModels()` function is kept as a **fallback** for model detection when the activity poller hasn't run yet. Its cache TTL should be increased to 30s since it's no longer the primary source.
- The `POST /feed` endpoint can be removed — all feed items now come from internal sources (DB poller, lifecycle POST handler).
- Future enhancements: session replay, activity search, coder agent integration, metrics.
