# Plan: Agent Message Bus — Inter-Agent Communication

## Goal

Add a SQLite-backed message bus that enables structured, threaded communication between the four agents (planner, coder, reviewer, refactor). Agents write via a standalone CLI tool (`~/.agent/msg.js`); the dashboard reads the DB and surfaces unread counts per agent, a messages panel, and a message detail modal.

## Background

Communication between agents today relies on markdown files — good for persistent artifacts, but not suited for transient feedback like reviewer commentary on plans, blocking questions, or approval signals. This plan introduces a lightweight message bus to fill that gap.

### Architecture

All four agents run on the same machine. The message bus consists of:

1. **`~/.agent/msg.js`** — CLI tool (standalone Node script). Agents call this from their terminal to send, read, and address messages. All DB writes happen here.
2. **`~/.agent/messages.db`** — SQLite database (auto-created on first `msg setup`). Single `messages` table with threading, severity, and lifecycle tracking.
3. **Agent Hub dashboard** — reads `messages.db` read-only (same pattern as opencode DB, learnings DB, QMD DB). Shows unread counts on agent cards, a messages panel, and a click-to-open message detail modal.
4. **`SKILL.md`** — loaded into each agent's system prompt. Defines inbox-check-on-start protocol, message conventions, and agent-specific guidance.

### Why not MCP?

The message bus is intentionally not an MCP server. Agents already have terminal access — `node ~/.agent/msg.js send ...` is simpler than adding another MCP connection. The CLI approach also means the bus works with any agent framework (opencode, gh copilot, etc.) without framework-specific integration.

### Existing patterns this follows

The agent-hub already has three read-only SQLite DB connections following an identical pattern:

| DB | Path constant | Env override | Config injectable | Purpose |
|---|---|---|---|---|
| opencode | `OPENCODE_DB_PATH` | N/A | `config.opencodeDb` | Live model display, activity polling |
| learnings | `LEARNINGS_DB_PATH` | `LEARNINGS_DB_PATH` | `config.learningsDb` | Recent learnings feed |
| QMD | `QMD_DB_PATH` | `QMD_DB_PATH` | `config.qmdDb` | Documentation search |
| **messages** (new) | `MESSAGES_DB_PATH` | `MESSAGES_DB_PATH` | `config.messagesDb` | **Agent message bus** |

The messages DB connection follows this exact pattern: path constant, env var override, `config.messagesDb` injectable for tests, graceful degradation if the DB doesn't exist.

### Database Schema

Single table. No joins required for any query.

```sql
CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,        -- uuid
  thread_id      TEXT NOT NULL,           -- uuid; equals id for root messages
  parent_id      TEXT,                    -- null for root; parent msg id for replies
  from_agent     TEXT NOT NULL,           -- planner | coder | reviewer | refactor
  to_agent       TEXT NOT NULL,
  type           TEXT NOT NULL,           -- plan_feedback | diff_feedback | question | approval | info
  severity       TEXT NOT NULL DEFAULT 'advisory',  -- blocking | advisory | info
  ref            TEXT,                    -- Shortcut story ID, commit SHA, PR number
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unread',    -- unread | read | addressed
  created_at     TEXT NOT NULL,
  read_at        TEXT,
  addressed_at   TEXT,
  addressed_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
```

### Message Lifecycle

```
unread --> read --> addressed
  |                   ^
  └───────────────────┘  (direct: `address` on unread message)
```

- **unread** — message has been sent, recipient has not opened it
- **read** — recipient has seen it and is working on it
- **addressed** — recipient has applied the feedback; includes a resolution note

The `address` command accepts messages in either `unread` or `read` status, allowing agents to skip the `read` step when they can immediately resolve a message.

### CLI Tool (`msg.js`)

Installed at `~/.agent/msg.js`. Single dependency: `better-sqlite3`.

```bash
msg setup                           # Initialize ~/.agent/ and create messages.db
msg send <from> <to> <type> --ref <ref> [--blocking] --body "..."
msg reply <parent-id> <from> --body "..." [--blocking] [--to <agent>]
msg inbox <agent> [--ref <ref>] [--status unread|read|addressed|all]
msg read <id>                       # Transition: unread --> read
msg address <id> [--note "..."]     # Transition: read|unread --> addressed
msg thread <thread-id>              # Show full thread chronologically
```

Validation rules:
- `from` / `to` must be one of: `planner`, `coder`, `reviewer`, `refactor`
- `type` must be one of: `plan_feedback`, `diff_feedback`, `question`, `approval`, `info`
- `severity` must be one of: `blocking`, `advisory`, `info`
- `body` is required for send and reply
- WAL mode is enabled on every DB open for safe concurrent access

## Files to Change

| File | What changes |
|---|---|
| `~/.agent/msg.js` (NEW) | CLI tool — all agent read/write operations (Tasks 1–2) |
| `status-server.js` | Add messages DB connection, message query functions, REST endpoints, SSE integration (Tasks 3–6) |
| `agent-hub.html` | Add unread count badges on agent cards, messages panel HTML/CSS/JS, message detail modal (Tasks 7–11) |
| `~/.agent/SKILL.md` (NEW) | Agent skill file for system prompts (Task 12) |

**No changes needed to**: `package.json` (already has `better-sqlite3`), `test/` files (new tests should be added separately), wrapper scripts, or other plan files.

## Tasks

### Task 1: Create the CLI tool (`~/.agent/msg.js`)

Create the file at `~/.agent/msg.js`. This is a standalone Node.js script — not part of the agent-hub repo. It owns all writes to `messages.db`.

The script should:

1. **Parse CLI arguments** using a simple hand-rolled parser (no dependencies beyond `better-sqlite3`). The command is `argv[2]`, remaining args are positional + flags.
2. **Open the DB** at `~/.agent/messages.db` with WAL mode enabled (`PRAGMA journal_mode=WAL`).
3. **Implement all commands** from the CLI spec above.

```js
#!/usr/bin/env node
'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.agent', 'messages.db');
const VALID_AGENTS = ['planner', 'coder', 'reviewer', 'refactor'];
const VALID_TYPES = ['plan_feedback', 'diff_feedback', 'question', 'approval', 'info'];
const VALID_SEVERITIES = ['blocking', 'advisory', 'info'];
const VALID_STATUSES = ['unread', 'read', 'addressed'];

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      thread_id      TEXT NOT NULL,
      parent_id      TEXT,
      from_agent     TEXT NOT NULL,
      to_agent       TEXT NOT NULL,
      type           TEXT NOT NULL,
      severity       TEXT NOT NULL DEFAULT 'advisory',
      ref            TEXT,
      body           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'unread',
      created_at     TEXT NOT NULL,
      read_at        TEXT,
      addressed_at   TEXT,
      addressed_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  `);
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--body' || args[i] === '--ref' || args[i] === '--note' || args[i] === '--status' || args[i] === '--to') {
      flags[args[i].slice(2)] = args[++i] || '';
    } else if (args[i] === '--blocking') {
      flags.blocking = true;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function validate(field, value, validList) {
  if (!validList.includes(value)) {
    console.error(`Invalid ${field}: "${value}". Must be one of: ${validList.join(', ')}`);
    process.exit(1);
  }
}

function formatMessage(msg) {
  const sev = msg.severity === 'blocking' ? ' [BLOCKING]' : '';
  const ref = msg.ref ? ` ref=${msg.ref}` : '';
  const status = msg.status.toUpperCase();
  console.log(`\n  ${msg.id}`);
  console.log(`  ${msg.from_agent} -> ${msg.to_agent}  ${msg.type}${sev}${ref}`);
  console.log(`  Status: ${status}  Created: ${msg.created_at}`);
  if (msg.read_at) console.log(`  Read: ${msg.read_at}`);
  if (msg.addressed_at) console.log(`  Addressed: ${msg.addressed_at}`);
  if (msg.addressed_note) console.log(`  Note: ${msg.addressed_note}`);
  console.log(`  ---`);
  console.log(`  ${msg.body}`);
  console.log();
}

// --- Commands ---

const commands = {
  setup() {
    const dir = path.join(os.homedir(), '.agent');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = openDb();
    createSchema(db);
    db.close();
    console.log(`Initialized messages DB at ${DB_PATH}`);
  },

  send(args) {
    const { flags, positional } = parseFlags(args);
    const [from, to, type] = positional;
    if (!from || !to || !type) {
      console.error('Usage: msg send <from> <to> <type> --body "..." [--ref <ref>] [--blocking]');
      process.exit(1);
    }
    validate('from', from, VALID_AGENTS);
    validate('to', to, VALID_AGENTS);
    validate('type', type, VALID_TYPES);
    if (!flags.body) { console.error('--body is required'); process.exit(1); }

    const id = crypto.randomUUID();
    const severity = flags.blocking ? 'blocking' : 'advisory';
    const now = new Date().toISOString();

    const db = openDb();
    createSchema(db);
    db.prepare(`
      INSERT INTO messages (id, thread_id, parent_id, from_agent, to_agent, type, severity, ref, body, status, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'unread', ?)
    `).run(id, id, from, to, type, severity, flags.ref || null, flags.body, now);
    db.close();

    console.log(`Sent message ${id} from ${from} to ${to} (${type}, ${severity})`);
  },

  reply(args) {
    const { flags, positional } = parseFlags(args);
    const [parentId, from] = positional;
    if (!parentId || !from) {
      console.error('Usage: msg reply <parent-id> <from> --body "..." [--blocking] [--to <agent>]');
      process.exit(1);
    }
    validate('from', from, VALID_AGENTS);
    if (!flags.body) { console.error('--body is required'); process.exit(1); }

    const db = openDb();
    createSchema(db);
    const parent = db.prepare('SELECT * FROM messages WHERE id = ?').get(parentId);
    if (!parent) { console.error(`Parent message not found: ${parentId}`); process.exit(1); }

    const id = crypto.randomUUID();
    // Default: reply to the sender of parent. Override with --to for multi-party threads.
    const to = flags.to || parent.from_agent;
    if (flags.to) validate('to', flags.to, VALID_AGENTS);
    const severity = flags.blocking ? 'blocking' : 'advisory';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO messages (id, thread_id, parent_id, from_agent, to_agent, type, severity, ref, body, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?)
    `).run(id, parent.thread_id, parentId, from, to, parent.type, severity, parent.ref, flags.body, now);
    db.close();

    console.log(`Replied ${id} in thread ${parent.thread_id} from ${from} to ${to}`);
  },

  inbox(args) {
    const { flags, positional } = parseFlags(args);
    const [agent] = positional;
    if (!agent) { console.error('Usage: msg inbox <agent> [--ref <ref>] [--status unread|read|addressed|all]'); process.exit(1); }
    validate('agent', agent, VALID_AGENTS);

    const statusFilter = flags.status || 'unread';
    if (statusFilter !== 'all') validate('status', statusFilter, VALID_STATUSES);

    const db = openDb();
    createSchema(db);

    let query = 'SELECT * FROM messages WHERE to_agent = ?';
    const params = [agent];
    if (statusFilter !== 'all') { query += ' AND status = ?'; params.push(statusFilter); }
    if (flags.ref) { query += ' AND ref = ?'; params.push(flags.ref); }
    query += ` ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'advisory' THEN 1 ELSE 2 END, created_at ASC`;

    const rows = db.prepare(query).all(...params);
    db.close();

    if (rows.length === 0) {
      console.log(`No ${statusFilter} messages for ${agent}.`);
      return;
    }

    console.log(`\n${rows.length} ${statusFilter} message(s) for ${agent}:`);
    for (const msg of rows) formatMessage(msg);
  },

  read(args) {
    const [id] = args;
    if (!id) { console.error('Usage: msg read <id>'); process.exit(1); }

    const db = openDb();
    createSchema(db);
    const result = db.prepare(`
      UPDATE messages SET status = 'read', read_at = ? WHERE id = ? AND status = 'unread'
    `).run(new Date().toISOString(), id);
    db.close();

    if (result.changes === 0) console.log(`No unread message with id ${id} (already read or not found).`);
    else console.log(`Marked ${id} as read.`);
  },

  address(args) {
    const { flags, positional } = parseFlags(args);
    const [id] = positional;
    if (!id) { console.error('Usage: msg address <id> [--note "..."]'); process.exit(1); }

    const db = openDb();
    createSchema(db);
    const result = db.prepare(`
      UPDATE messages SET status = 'addressed', addressed_at = ?, addressed_note = ?
      WHERE id = ? AND status IN ('unread', 'read')
    `).run(new Date().toISOString(), flags.note || null, id);
    db.close();

    if (result.changes === 0) console.log(`No pending message with id ${id}.`);
    else console.log(`Addressed ${id}.${flags.note ? ' Note: ' + flags.note : ''}`);
  },

  thread(args) {
    const [threadId] = args;
    if (!threadId) { console.error('Usage: msg thread <thread-id>'); process.exit(1); }

    const db = openDb();
    createSchema(db);
    const rows = db.prepare(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
    ).all(threadId);
    db.close();

    if (rows.length === 0) { console.log(`No messages in thread ${threadId}.`); return; }

    console.log(`\nThread ${threadId} (${rows.length} message(s)):`);
    for (const msg of rows) formatMessage(msg);
  }
};

// --- Main ---
const [,, cmd, ...rest] = process.argv;
if (!cmd || !commands[cmd]) {
  console.log('Usage: msg <command> [args]');
  console.log('Commands: setup, send, reply, inbox, read, address, thread');
  process.exit(cmd ? 1 : 0);
}
commands[cmd](rest);
```

Key design decisions:
- **Self-contained** — no imports beyond `better-sqlite3`, `crypto`, `os`, `path`, `fs`
- **`createSchema()` on every command** — idempotent `CREATE TABLE IF NOT EXISTS` ensures the DB is always valid, even without running `setup` first
- **Reply auto-routes with override** — `msg reply` sends to the `from_agent` of the parent message by default, keeping threads bidirectional. Use `--to <agent>` to redirect to a different agent for multi-party threads (e.g., reviewer escalating to planner within a coder thread).
- **Blocking sorts first** — inbox results show blocking messages before advisory
- **UUID IDs** — `crypto.randomUUID()` (Node 19+) for message and thread IDs

---

### Task 2: Create the setup and support files

**`~/.agent/package.json`** (if not already present):

Run `cd ~/.agent && npm init -y && npm install better-sqlite3` to set up the dependency.

**`SKILL.md`** — see Task 12 for the full skill file content.

---

### Task 3: Add messages DB connection in `status-server.js`

After the `QMD_DB_PATH` constant (line 18–19), add:

```js
const MESSAGES_DB_PATH = process.env.MESSAGES_DB_PATH
  || path.join(os.homedir(), '.agent', 'messages.db');
```

After the `QMD_MAX_LIMIT` constant (line 35), add:

```js
const MESSAGES_CACHE_TTL = 5_000;
const MESSAGES_POLL_INTERVAL = 5_000;
```

Inside `createApp()`, after the `hasQmdDb` line (line 65), add:

```js
const hasMessagesDb = Object.prototype.hasOwnProperty.call(config, 'messagesDb');
```

After the QMD DB connection block (lines 89–96), add:

```js
let messagesDb = hasMessagesDb ? config.messagesDb : null;
if (!hasMessagesDb) {
  try {
    messagesDb = new Database(MESSAGES_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.warn(`[messages] Could not open messages DB at ${MESSAGES_DB_PATH}: ${e.message}`);
  }
}
```

After the `learningsCache` declaration (line 99), add:

```js
let messagesCache = { counts: {}, timestamp: 0 };
```

Design notes:
- **Read-only** — the dashboard never writes to the messages DB. Agents own all writes via `msg.js`.
- **5-second cache TTL** — message counts are polled on a timer (like model info) rather than on every request. 5 seconds is responsive enough for a dashboard without hammering the DB.
- **`config.messagesDb`** — injectable for tests, following the existing `config.opencodeDb` / `config.learningsDb` / `config.qmdDb` pattern.

---

### Task 4: Add message query functions in `status-server.js`

After the `searchQmdDocs()` function, add two functions:

```js
function getMessageCounts() {
  const now = Date.now();
  if (now - messagesCache.timestamp < MESSAGES_CACHE_TTL) {
    return messagesCache.counts;
  }

  if (!messagesDb) {
    return messagesCache.counts;
  }

  try {
    const rows = messagesDb.prepare(`
      SELECT
        to_agent,
        COUNT(*) as total,
        SUM(CASE WHEN severity = 'blocking' THEN 1 ELSE 0 END) as blocking
      FROM messages
      WHERE status = 'unread'
      GROUP BY to_agent
    `).all();

    const counts = {};
    for (const agent of VALID_AGENTS) {
      counts[agent] = { total: 0, blocking: 0 };
    }
    for (const row of rows) {
      if (counts[row.to_agent]) {
        counts[row.to_agent] = { total: row.total, blocking: row.blocking };
      }
    }
    messagesCache = { counts, timestamp: now };
    return counts;
  } catch (e) {
    console.warn('[messages] Failed to read message counts:', e.message);
    return messagesCache.counts;
  }
}

function getMessages(options = {}) {
  if (!messagesDb) return [];

  try {
    let query = 'SELECT * FROM messages WHERE 1=1';
    const params = [];

    if (options.to) {
      query += ' AND to_agent = ?';
      params.push(options.to);
    }
    if (options.from) {
      query += ' AND from_agent = ?';
      params.push(options.from);
    }
    if (options.status && options.status !== 'all') {
      query += ' AND status = ?';
      params.push(options.status);
    }
    if (options.ref) {
      query += ' AND ref = ?';
      params.push(options.ref);
    }
    if (options.threadId) {
      query += ' AND thread_id = ?';
      params.push(options.threadId);
    }
    if (options.severity) {
      query += ' AND severity = ?';
      params.push(options.severity);
    }

    query += ` ORDER BY CASE severity WHEN 'blocking' THEN 0 WHEN 'advisory' THEN 1 ELSE 2 END, created_at DESC`;

    const limit = Math.min(parseInt(options.limit, 10) || 50, 200);
    query += ' LIMIT ?';
    params.push(limit);

    return messagesDb.prepare(query).all(...params);
  } catch (e) {
    console.warn('[messages] Query failed:', e.message);
    return [];
  }
}
```

Design notes:
- **`getMessageCounts()`** — cached with a 5-second TTL, returns `{ planner: { total, blocking }, coder: { ... }, ... }`. Used for badge counts on agent cards and included in SSE `init` payload.
- **`getMessages()`** — uncached, on-demand query for the messages panel. Supports filtering by `to`, `from`, `status`, `ref`, `threadId`, `severity`. Blocking messages sort first, then newest first within each severity.
- **200-row hard limit** — prevents accidentally loading the entire message history.

---

### Task 5: Add REST endpoints in `status-server.js`

After the `GET /qmd/doc/:id` route (line 1194), add the following routes. **Route order matters** — Express matches routes in definition order, so static segments (`counts`, `thread`) must come before the `:id` parameter route to prevent Express from treating `"counts"` or `"thread"` as an `:id` value.

```js
// GET /api/messages/counts — Unread message counts per agent
app.get('/api/messages/counts', (req, res) => {
  res.json(getMessageCounts());
});

// GET /api/messages/thread/:threadId — Get all messages in a thread
app.get('/api/messages/thread/:threadId', (req, res) => {
  if (!messagesDb) {
    return res.json([]);
  }

  try {
    const rows = messagesDb.prepare(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC'
    ).all(req.params.threadId);
    return res.json(rows);
  } catch (e) {
    console.warn('[messages] Thread query failed:', e.message);
    return res.json([]);
  }
});

// GET /api/messages/:id — Get a single message by ID
app.get('/api/messages/:id', (req, res) => {
  if (!messagesDb) {
    return res.status(404).json({ error: 'Messages DB not available' });
  }

  try {
    const msg = messagesDb.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }
    return res.json(msg);
  } catch (e) {
    console.warn('[messages] Failed to fetch message:', e.message);
    return res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// GET /api/messages — List messages with optional filters
app.get('/api/messages', (req, res) => {
  const messages = getMessages({
    to: req.query.to || undefined,
    from: req.query.from || undefined,
    status: req.query.status || 'all',
    severity: req.query.severity || undefined,
    ref: req.query.ref || undefined,
    threadId: req.query.thread || undefined,
    limit: req.query.limit
  });
  res.json(messages);
});
```

Update the startup banner to include the new endpoints:

```diff
    GET  /qmd/search → Search QMD docs (FTS5)
    GET  /qmd/doc/:id → Get full document content
+   GET  /api/messages → List messages (filterable)
+   GET  /api/messages/counts → Unread counts per agent
+   GET  /api/messages/:id → Single message detail
+   GET  /api/messages/thread/:id → Thread view
```

Also add the messages DB path to the status output:

```diff
  QMD DB: ${process.env.QMD_DB_PATH || QMD_DB_PATH}
+ Messages DB: ${process.env.MESSAGES_DB_PATH || MESSAGES_DB_PATH}
```

---

### Task 6: Add message counts to SSE `init` payload and polling

In the SSE `init` event (around line 1031–1036), add `messageCounts` to the payload:

```js
res.write(`data: ${JSON.stringify({
  type: 'init',
  status: buildStatusSnapshot(),
  feed: feedBuffer.slice(0, MAX_FEED_ITEMS),
  learnings: getRecentLearnings(20),
  messageCounts: getMessageCounts()
})}\n\n`);
```

Add a periodic broadcast of message counts. After the existing Copilot polling interval setup (around line 1217–1224), add:

```js
if (!config.skipPolling) {
  let lastMessageCounts = JSON.stringify({});
  intervals.push(setInterval(() => {
    const counts = getMessageCounts();
    const serialized = JSON.stringify(counts);
    if (serialized !== lastMessageCounts) {
      lastMessageCounts = serialized;
      broadcastSSE({ type: 'message-counts', counts });
    }
  }, MESSAGES_POLL_INTERVAL));
}
```

Design notes:
- **Diff-based broadcasting** — only sends a `message-counts` SSE event when counts actually change. Prevents unnecessary re-renders.
- **5-second polling** — responsive enough for a dashboard (a message sent by one agent appears on the dashboard within 5 seconds).
- **New SSE event type `message-counts`** — keeps message updates separate from `agent-update` events. The frontend handles this event type to update badge counts.

---

### Task 7: Add envelope message indicator on agent cards in `agent-hub.html`

Add an envelope icon element to each agent card, inside the `agent-header` div next to the existing badge. The envelope only appears when the agent has unread messages; otherwise nothing is shown. A tooltip on hover gives the exact count.

For each agent card (planner, coder, reviewer, refactor), add after the existing `agent-badge` div:

```html
<div class="agent-msg-envelope" id="msgcount-{agent}" style="display:none;" title="0 unread messages">&#9993;</div>
```

The `&#9993;` is the ✉ (envelope) Unicode character.

For example, the planner card header becomes:

```html
<div class="agent-header">
  <div class="agent-icon-wrap">&#129504;</div>
  <div style="display:flex;gap:6px;align-items:center;margin-left:auto;">
    <div class="agent-badge" id="badge-planner">Idle</div>
    <div class="agent-msg-envelope" id="msgcount-planner" style="display:none;" title="0 unread messages">&#9993;</div>
  </div>
</div>
```

**Note on flex layout:** The existing `agent-header` uses `display: flex; justify-content: space-between;` with the icon and badge as direct children. Wrapping the badge + envelope in a div changes the flex children from `[icon, badge]` to `[icon, wrapper]`. Adding `margin-left: auto;` on the wrapper div replicates the push-right behavior that `space-between` gave the badge as a direct child.

Apply the same pattern to `card-coder`, `card-reviewer`, `card-refactor`.

**Behavior:**
- `display:none` by default — nothing shows when there are zero unread messages
- When unread count > 0: displayed, tooltip shows "N unread messages" (or "N unread (M blocking)" if any are blocking)
- When blocking messages exist: adds `.has-blocking` class for pulsing red animation
- When all messages are read/addressed: hidden again

---

### Task 8: Add CSS for message badges and messages panel in `agent-hub.html`

Add to the `<style>` block, after the QMD panel CSS:

```css
/* Envelope message indicator on agent cards */
.agent-msg-envelope {
  font-size: 14px;
  cursor: default;
  color: rgba(239, 68, 68, 0.9);
  transition: opacity 0.2s;
}
.agent-msg-envelope:hover {
  opacity: 0.7;
}
.agent-msg-envelope.has-blocking {
  color: #dc2626;
  animation: blockingPulse 1.5s infinite;
}
@keyframes blockingPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Messages panel */
.messages-panel {
  margin-bottom: 32px;
}

.messages-toolbar {
  padding: 12px 18px 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.messages-filter-btn {
  font-family: 'Share Tech Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.05em;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
}
.messages-filter-btn:hover {
  border-color: var(--text);
  color: var(--text);
}
.messages-filter-btn.active {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--planner-primary);
  color: var(--planner-primary);
}

.messages-list {
  padding: 14px 18px;
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.messages-list::-webkit-scrollbar { width: 4px; }
.messages-list::-webkit-scrollbar-track { background: transparent; }
.messages-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.message-item {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.2s;
  animation: fadeSlide 0.3s ease;
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.message-item:hover {
  background: rgba(255, 255, 255, 0.03);
  border-color: var(--text);
}
.message-item.severity-blocking {
  border-left: 3px solid #dc2626;
}
.message-item.severity-advisory {
  border-left: 3px solid var(--planner-primary);
}
.message-item.severity-info {
  border-left: 3px solid var(--muted);
}
.message-item.status-addressed {
  opacity: 0.5;
}

.message-severity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 4px;
}
.message-severity-dot.blocking { background: #dc2626; }
.message-severity-dot.advisory { background: var(--planner-primary); }
.message-severity-dot.info { background: var(--muted); }

.message-body-preview {
  flex: 1;
  min-width: 0;
}

.message-header-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.message-route {
  font-family: 'Share Tech Mono', monospace;
  font-size: 11px;
  color: var(--text);
  font-weight: 500;
}

.message-type-tag {
  font-family: 'Share Tech Mono', monospace;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
  text-transform: uppercase;
}

.message-status-tag {
  font-family: 'Share Tech Mono', monospace;
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 3px;
  text-transform: uppercase;
}
.message-status-tag.unread { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.message-status-tag.read { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
.message-status-tag.addressed { background: rgba(16, 185, 129, 0.15); color: #34d399; }

.message-snippet {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.4;
  max-height: 40px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.message-meta {
  font-size: 9px;
  color: var(--muted);
  margin-top: 4px;
  opacity: 0.7;
}

/* Message detail modal */
.message-modal {
  width: 600px;
  max-width: 95vw;
  max-height: 80vh;
  overflow-y: auto;
}

.message-modal-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border);
}

.message-modal-route {
  font-family: 'Syne', sans-serif;
  font-weight: 700;
  font-size: 16px;
  color: #fff;
  margin-bottom: 8px;
}

.message-modal-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.message-modal-body {
  padding: 20px 24px;
  font-size: 13px;
  color: var(--text);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-modal-meta {
  padding: 16px 24px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.message-modal-thread {
  padding: 0 24px 20px;
}

.message-modal-thread-title {
  font-family: 'Share Tech Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.15em;
  color: var(--muted);
  text-transform: uppercase;
  margin-bottom: 10px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.thread-message {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-bottom: 6px;
  font-size: 11px;
}

.thread-message-header {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 6px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 10px;
  color: var(--muted);
}

.thread-message-body {
  color: var(--text);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
```

---

### Task 9: Add messages panel HTML in `agent-hub.html`

Insert a new section between the QMD panel and the `bottom-grid` div (after line 1099, before line 1101). This places it below the documentation search panel.

```html
<div class="section-label">Agent Messages</div>
<div class="panel messages-panel">
  <div class="panel-head">
    <span>Message Bus</span>
    <span id="messagesCount">0 messages</span>
  </div>
  <div class="messages-toolbar">
    <button class="messages-filter-btn active" data-filter="all" onclick="setMessageFilter('all', this)">All</button>
    <button class="messages-filter-btn" data-filter="unread" onclick="setMessageFilter('unread', this)">Unread</button>
    <button class="messages-filter-btn" data-filter="blocking" onclick="setMessageFilter('blocking', this)">Blocking</button>
    <button class="messages-filter-btn" data-filter="planner" onclick="setMessageFilter('planner', this)">Planner</button>
    <button class="messages-filter-btn" data-filter="coder" onclick="setMessageFilter('coder', this)">Coder</button>
    <button class="messages-filter-btn" data-filter="reviewer" onclick="setMessageFilter('reviewer', this)">Reviewer</button>
    <button class="messages-filter-btn" data-filter="refactor" onclick="setMessageFilter('refactor', this)">Refactor</button>
  </div>
  <div class="messages-list" id="messagesList">
    <div class="feed-empty">No messages yet. Agents use <code>msg.js</code> to communicate.</div>
  </div>
</div>
```

---

### Task 10: Add messages JS in `agent-hub.html`

Add to the `<script>` block, before the `// --- Init ---` section:

```js
// ─── Agent Messages ───────────────────────────────────────────

const MESSAGES_POLL_INTERVAL = 10_000;
let currentMessageFilter = 'all';
let cachedMessages = [];

// Handle SSE message-counts event
// (Add this case inside the eventSource.onmessage switch statement)
// case 'message-counts':
//   updateMessageBadges(data.counts);
//   break;

function updateMessageBadges(counts) {
  if (!counts) return;
  for (const agent of ['planner', 'coder', 'reviewer', 'refactor']) {
    const el = document.getElementById(`msgcount-${agent}`);
    if (!el) continue;
    const c = counts[agent] || { total: 0, blocking: 0 };
    if (c.total > 0) {
      el.style.display = '';
      el.classList.toggle('has-blocking', c.blocking > 0);
      el.title = c.blocking > 0
        ? `${c.total} unread (${c.blocking} blocking)`
        : `${c.total} unread message${c.total !== 1 ? 's' : ''}`;
    } else {
      el.style.display = 'none';
    }
  }
}

async function pollMessages() {
  try {
    // Fetch counts for badges
    const countsRes = await fetch(`${API_BASE}/api/messages/counts`);
    if (countsRes.ok) {
      const counts = await countsRes.json();
      updateMessageBadges(counts);
    }

    // Fetch messages for the panel
    let url = `${API_BASE}/api/messages?limit=50`;
    if (currentMessageFilter === 'unread') {
      url += '&status=unread';
    } else if (currentMessageFilter === 'blocking') {
      url += '&severity=blocking';
    } else if (['planner', 'coder', 'reviewer', 'refactor'].includes(currentMessageFilter)) {
      url += `&to=${currentMessageFilter}`;
    }

    const msgRes = await fetch(url);
    if (!msgRes.ok) return;
    const messages = await msgRes.json();

    cachedMessages = messages;
    renderMessages(messages);
  } catch (e) {
    // silent
  }
}

function setMessageFilter(filter, btnEl) {
  currentMessageFilter = filter;
  // Update active button
  document.querySelectorAll('.messages-filter-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  pollMessages();
}

function renderMessages(messages) {
  const container = document.getElementById('messagesList');
  const countEl = document.getElementById('messagesCount');

  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="feed-empty">No messages match the current filter.</div>';
    countEl.textContent = '0 messages';
    return;
  }

  const agentColors = {
    planner: 'var(--planner-primary)',
    coder: 'var(--coder-primary)',
    reviewer: 'var(--reviewer-primary)',
    refactor: 'var(--refactor-primary)'
  };

  container.innerHTML = messages.map(msg => {
    const from = escapeHtml(msg.from_agent || '');
    const to = escapeHtml(msg.to_agent || '');
    const type = escapeHtml((msg.type || '').replace(/_/g, ' '));
    const severity = msg.severity || 'advisory';
    const status = msg.status || 'unread';
    const body = escapeHtml((msg.body || '').substring(0, 120));
    const ref = msg.ref ? escapeHtml(msg.ref) : '';
    const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : '';

    return `
      <div class="message-item severity-${severity} status-${status}"
           onclick="openMessageModal('${escapeHtml(msg.id)}')">
        <div class="message-severity-dot ${severity}"></div>
        <div class="message-body-preview">
          <div class="message-header-row">
            <span class="message-route" style="color:${agentColors[msg.from_agent] || 'var(--text)'}">
              ${from}
            </span>
            <span style="color:var(--muted);font-size:10px;">&rarr;</span>
            <span class="message-route" style="color:${agentColors[msg.to_agent] || 'var(--text)'}">
              ${to}
            </span>
            <span class="message-type-tag">${type}</span>
            <span class="message-status-tag ${status}">${status}</span>
          </div>
          <div class="message-snippet">${body}</div>
          <div class="message-meta">
            ${ref ? `ref: ${ref} &middot; ` : ''}${time}
          </div>
        </div>
      </div>
    `;
  }).join('');

  countEl.textContent = `${messages.length} message${messages.length !== 1 ? 's' : ''}`;
}

async function openMessageModal(messageId) {
  // Fetch the full message
  try {
    const res = await fetch(`${API_BASE}/api/messages/${encodeURIComponent(messageId)}`);
    if (!res.ok) { showToast('Failed to load message'); return; }
    const msg = await res.json();

    // Fetch the thread if it has one
    let thread = [];
    if (msg.thread_id) {
      try {
        const threadRes = await fetch(`${API_BASE}/api/messages/thread/${encodeURIComponent(msg.thread_id)}`);
        if (threadRes.ok) thread = await threadRes.json();
      } catch { /* ignore */ }
    }

    renderMessageModal(msg, thread);
  } catch (e) {
    showToast('Failed to load message');
  }
}

function renderMessageModal(msg, thread) {
  const agentColors = {
    planner: 'var(--planner-primary)',
    coder: 'var(--coder-primary)',
    reviewer: 'var(--reviewer-primary)',
    refactor: 'var(--refactor-primary)'
  };

  const severity = msg.severity || 'advisory';
  const status = msg.status || 'unread';
  const from = escapeHtml(msg.from_agent || '');
  const to = escapeHtml(msg.to_agent || '');
  const type = escapeHtml((msg.type || '').replace(/_/g, ' '));
  const ref = msg.ref ? escapeHtml(msg.ref) : '';

  const barColor = severity === 'blocking' ? '#dc2626' : (agentColors[msg.from_agent] || 'var(--planner-primary)');

  const modal = document.querySelector('.modal');
  modal.classList.add('message-modal');
  document.getElementById('modalBar').style.background = barColor;
  document.getElementById('modalBar').className = 'modal-bar';
  document.getElementById('modalIcon').textContent = severity === 'blocking' ? '\u{1F6A8}' : '\u{1F4E8}';
  document.getElementById('modalTitle').textContent = `${from} \u2192 ${to}`;
  document.getElementById('modalSubtitle').textContent = `${type} \u00b7 ${severity}${ref ? ' \u00b7 ' + ref : ''}`;
  document.querySelector('.modal').style.setProperty('--modal-color', agentColors[msg.from_agent] || '#00d4ff');

  let threadHtml = '';
  if (thread.length > 1) {
    threadHtml = `
      <div class="message-modal-thread">
        <div class="message-modal-thread-title">Thread (${thread.length} messages)</div>
        ${thread.map(t => {
          const tFrom = escapeHtml(t.from_agent || '');
          const tTo = escapeHtml(t.to_agent || '');
          const tTime = t.created_at ? new Date(t.created_at).toLocaleString() : '';
          const tStatus = t.status || '';
          const highlight = t.id === msg.id ? 'border-color: var(--planner-primary);' : '';
          return `
            <div class="thread-message" style="${highlight}">
              <div class="thread-message-header">
                <span style="color:${agentColors[t.from_agent] || 'var(--text)'}">${tFrom}</span>
                <span>&rarr;</span>
                <span style="color:${agentColors[t.to_agent] || 'var(--text)'}">${tTo}</span>
                <span class="message-status-tag ${tStatus}">${tStatus}</span>
                <span>${tTime}</span>
              </div>
              <div class="thread-message-body">${escapeHtml(t.body || '')}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  document.getElementById('modalBody').innerHTML = `
    <div class="message-modal-tags">
      <span class="message-type-tag">${type}</span>
      <span class="message-status-tag ${status}">${status}</span>
      ${severity === 'blocking' ? '<span class="message-status-tag unread">BLOCKING</span>' : ''}
    </div>
    <div class="message-modal-body">${escapeHtml(msg.body || '')}</div>
    <div class="message-modal-meta">
      <span>ID: ${escapeHtml(msg.id || '')}</span>
      <span>Created: ${msg.created_at ? new Date(msg.created_at).toLocaleString() : 'N/A'}</span>
      ${msg.read_at ? `<span>Read: ${new Date(msg.read_at).toLocaleString()}</span>` : ''}
      ${msg.addressed_at ? `<span>Addressed: ${new Date(msg.addressed_at).toLocaleString()}</span>` : ''}
      ${msg.addressed_note ? `<span>Note: ${escapeHtml(msg.addressed_note)}</span>` : ''}
      ${ref ? `<span>Ref: ${ref}</span>` : ''}
      <span>Thread: ${escapeHtml(msg.thread_id || '')}</span>
    </div>
    ${threadHtml}
    <button class="modal-close" onclick="closeModal()">Close</button>
  `;

  document.getElementById('modalOverlay').classList.add('open');
}

// Also update the existing closeModal() function or agent detail modal opener
// to remove the message-modal class so non-message modals render at their default size:
// document.querySelector('.modal').classList.remove('message-modal');
```

**Wire up SSE event:** Inside the existing `eventSource.onmessage` switch statement, add a new case:

```js
case 'message-counts':
  updateMessageBadges(data.counts);
  break;
```

---

### Task 11: Wire up messages polling in `agent-hub.html` init

At the bottom of the `<script>` block, in the init section (after `connectSSE()`), add:

```js
// Delay first poll to avoid double-fetching counts (SSE init already delivers messageCounts).
// The SSE init handler calls updateMessageBadges() immediately, so we only need the poll
// for the messages list and subsequent badge refreshes.
setTimeout(pollMessages, MESSAGES_POLL_INTERVAL);
setInterval(pollMessages, MESSAGES_POLL_INTERVAL);
```

Also update the SSE `init` handler to process initial message counts:

```js
// Inside case 'init':
if (data.messageCounts) updateMessageBadges(data.messageCounts);
```

---

### Task 12: Create the SKILL.md agent skill file

Create `SKILL.md` at the root of the `agent-hub` repo (or wherever agent skills are loaded from — see the user's `~/.claude/skills/` pattern). This file is loaded into each agent's system prompt and defines the message bus protocol.

```markdown
# Agent Message Bus — Communication Protocol

## Overview

You have access to a message bus for structured communication with other agents (planner, coder, reviewer, refactor). Messages are sent and received via the `msg.js` CLI tool.

## Your Identity

You are the **{AGENT_NAME}** agent. Replace `{AGENT_NAME}` with your role when using commands.

> **How to determine your agent name:** Your agent name matches your role as defined in your system prompt — one of `planner`, `coder`, `reviewer`, or `refactor`. For example, if your system prompt says "You are the **Coder** agent", your agent name is `coder`. This skill file is shared across all agents; each agent infers its own name from its role context.

## Mandatory: Check Inbox on Session Start

At the beginning of every session, check your inbox:

```bash
node ~/.agent/msg.js inbox {AGENT_NAME}
```

If there are **blocking** messages, you MUST resolve them before doing anything else. Read the message, do the work, then address it:

```bash
node ~/.agent/msg.js read <message-id>
# ... do the work ...
node ~/.agent/msg.js address <message-id> --note "Description of what was done"
```

## Commands

```bash
# Check inbox (unread messages, blocking first)
node ~/.agent/msg.js inbox {AGENT_NAME}

# Send a new message
node ~/.agent/msg.js send {AGENT_NAME} <to> <type> --ref <ref> --body "..."

# Send a blocking message (use sparingly)
node ~/.agent/msg.js send {AGENT_NAME} <to> <type> --ref <ref> --blocking --body "..."

# Reply to an existing message
node ~/.agent/msg.js reply <parent-id> {AGENT_NAME} --body "..."

# Reply to a different agent in the thread (multi-party)
node ~/.agent/msg.js reply <parent-id> {AGENT_NAME} --to <agent> --body "..."

# Mark as read (you've seen it, working on it)
node ~/.agent/msg.js read <id>

# Mark as addressed (done, with specific note)
node ~/.agent/msg.js address <id> --note "What was done"

# View a thread
node ~/.agent/msg.js thread <thread-id>
```

## Message Types

| Type | When to use |
|---|---|
| `plan_feedback` | Reviewer/coder commenting on a plan |
| `diff_feedback` | Reviewer commenting on code changes |
| `question` | Asking another agent for clarification |
| `approval` | Approving a plan, diff, or approach |
| `info` | FYI — no action required |

## Conventions

### Always use `--ref`
Tie every message to a Shortcut story ID (e.g., `sc-12345`), PR number, or commit SHA.

### Addressed notes must be specific
- Bad: "fixed", "done", "addressed"
- Good: "Added input validation in src/api/users.ts:88"
- Good: "Revised plan section 3 — separated fetch from transform"

### Use `--blocking` sparingly
Blocking means the recipient cannot safely proceed. Style issues, suggestions, and non-critical observations should NOT be blocking.

### Reply, don't re-send
If responding to a message, use `msg reply <parent-id>` to keep the thread intact.

## Agent-Specific Guidance

### Planner
- Send `plan_feedback` responses when reviewer or coder comment on your plans
- Use `question` to ask coder for implementation feasibility
- Send `approval` when a coder's approach looks correct

### Coder
- Check inbox before starting work — planner may have updated requirements
- Address `diff_feedback` from reviewer with specific file:line references
- Use `question` to ask planner for clarification on ambiguous requirements

### Reviewer
- Send `diff_feedback` with severity appropriate to the issue
- Use `--blocking` only for correctness bugs, security issues, or data loss risks
- Style issues and suggestions should be `advisory`

### Refactor
- Check for `plan_feedback` from reviewer before starting refactoring work
- Send `info` messages to planner when you discover architectural concerns
- Address feedback with commit SHAs showing what changed
```

---

## Data Flow

```
┌──────────────────────────────┐
│ Agent Terminal Sessions      │
│ (planner, coder, reviewer,  │
│  refactor)                   │
│                              │
│ node ~/.agent/msg.js send .. │
│ node ~/.agent/msg.js inbox . │
└─────────┬────────────────────┘
          │ read + write (WAL mode)
          ▼
┌──────────────────────────────┐
│ ~/.agent/messages.db         │
│ (single messages table)      │
└─────────┬────────────────────┘
          │ read-only (better-sqlite3)
          ▼
┌──────────────────────────────┐         ┌─────────────────────────────────┐
│  status-server.js            │         │  agent-hub.html                 │
│                              │         │                                 │
│  GET /api/messages           │──json──▶│  Messages panel (list + filter) │
│  GET /api/messages/counts    │──json──▶│  Envelope icons on agent cards  │
│  GET /api/messages/:id       │──json──▶│  Message detail modal           │
│  GET /api/messages/thread/:id│──json──▶│  Thread view in modal           │
│                              │         │                                 │
│  SSE: message-counts event   │──sse───▶│  Real-time envelope updates     │
│  SSE: init includes counts   │         │                                 │
└──────────────────────────────┘         └─────────────────────────────────┘

Dashboard flow:
  1. On load → SSE init includes messageCounts → badges update
  2. Every 10s → pollMessages() fetches /api/messages + /api/messages/counts
  3. Every 5s → server checks if counts changed → broadcasts SSE message-counts event
  4. User clicks message → fetch /api/messages/:id + /api/messages/thread/:id → modal opens
  5. Filter buttons → re-fetch with query params → re-render list
```

## Verification

After implementation, verify with this sequence:

1. **Set up the CLI tool**:
   ```bash
   mkdir -p ~/.agent
   # Copy msg.js to ~/.agent/msg.js
   cd ~/.agent && npm init -y && npm install better-sqlite3
   node ~/.agent/msg.js setup
   ```

2. **Send test messages**:
   ```bash
   node ~/.agent/msg.js send reviewer coder diff_feedback --ref sc-12345 --blocking --body "The API endpoint at line 42 has no input validation. This will accept arbitrary SQL in the filter parameter."
   node ~/.agent/msg.js send planner coder question --ref sc-12345 --body "Should the new endpoint support pagination? The plan doesn't mention it but the data set could grow."
   node ~/.agent/msg.js send coder reviewer info --ref sc-12345 --body "Implemented the API changes. Ready for review."
   ```

3. **Check inbox**:
   ```bash
   node ~/.agent/msg.js inbox coder
   # Should show 2 messages: blocking one first, then the question
   ```

4. **Start the hub server**: `npm start`
   - Should see `Messages DB: ~/.agent/messages.db` in the startup banner (or a warning if not found)

5. **Check API endpoints**:
   ```bash
   curl http://localhost:3747/api/messages/counts
   # Should return { "planner": { "total": 0, "blocking": 0 }, "coder": { "total": 2, "blocking": 1 }, ... }

   curl http://localhost:3747/api/messages?status=unread
   # Should return the 3 messages sent above

   curl "http://localhost:3747/api/messages?to=coder"
   # Should return 2 messages (the ones sent to coder)
   ```

6. **Open the dashboard**: `http://localhost:3747`
   - Coder card should show an ✉ envelope icon (2 unread messages)
   - Hover the envelope → tooltip says "2 unread (1 blocking)"
   - Envelope should pulse red due to the blocking message (`has-blocking` class)
   - Reviewer card should show an envelope too (1 unread from coder)
   - Planner card: no envelope (0 unread)
   - Messages panel should show all 3 messages with severity indicators
   - Click "Unread" filter → should show all 3 (all are unread)
   - Click "Blocking" filter → should show only the reviewer→coder message
   - Click "Coder" filter → should show the 2 messages addressed to coder

7. **Open message detail modal**:
   - Click any message in the list → modal opens with full body
   - Should show from → to, type, severity, ref, timestamps
   - Thread section should appear if the message has replies

8. **Test threading**:
   ```bash
   # Reply to the blocking message (use the ID from step 2)
   node ~/.agent/msg.js reply <blocking-msg-id> coder --body "Added input validation. See commit abc123."
   node ~/.agent/msg.js address <blocking-msg-id> --note "Added input validation in src/api/users.ts:42"
   ```
   - Dashboard should update within 10 seconds
   - Coder envelope should disappear (0 unread remaining) or stay with updated tooltip if 1 unread remains
   - Clicking the original message should show the thread with 2 messages

9. **Missing DB test**: Stop server, rename `messages.db`, restart. Dashboard should show no envelope icons, messages panel should show "No messages" — no crashes.

## Edge Cases

- **Messages DB doesn't exist**: Server starts normally, endpoints return `[]` / empty counts, envelope icons hidden, panel shows empty state. No crash.
- **Messages DB is locked by `msg.js`**: WAL mode allows concurrent readers. `better-sqlite3` readonly open is safe alongside the CLI's write operations.
- **Many messages**: Panel is capped at 50 per fetch, API hard-limits at 200. Scrollable container with `max-height: 400px`.
- **Rapid message sends**: 5-second server-side polling + 10-second client-side polling means ≤15 second latency in the worst case. SSE `message-counts` events bridge the gap for badge updates (5-second server poll).
- **Agent sends message to itself**: Valid (e.g., planner→planner for notes). Schema doesn't prevent it.
- **Empty body**: CLI validates that `--body` is required. The DB has `body TEXT NOT NULL`.
- **Very long message body**: Modal renders with `white-space: pre-wrap` and `word-break: break-word` in a scrollable container. List shows truncated preview (120 chars).
- **No Node.js 19+ (no `crypto.randomUUID()`)**: Fallback needed for older Node versions. Use `require('crypto').randomBytes(16).toString('hex')` formatted as UUID if `randomUUID` is not available, or just use a hex string.
- **Express route ordering**: `/api/messages/counts` and `/api/messages/thread/:threadId` must be defined before `/api/messages/:id` to prevent Express from matching "counts" or "thread" as an `:id`.

## Notes

- Zero new dependencies — `better-sqlite3` is already installed for the hub server; the CLI tool uses it at `~/.agent/`.
- ~250 lines CLI tool, ~80 lines backend, ~250 lines frontend (CSS + JS + HTML).
- The CLI tool lives outside the agent-hub repo at `~/.agent/msg.js`. It's not a module — it's a standalone script.
- Dashboard is strictly read-only. All writes go through `msg.js`. This keeps the architecture simple and prevents accidental mutation from the UI.
- The `SKILL.md` file should be added to each agent's system prompt or loaded via the skill mechanism (e.g., `~/.claude/skills/agent-message-bus/SKILL.md`).
- Future enhancements: notification sounds for blocking messages, message search/filter by body text, auto-archive addressed messages older than N days, metrics on message response times.
