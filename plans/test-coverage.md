# Plan: Behavioral Test Coverage

## Goal

Add automated behavioral tests that verify agent-hub's external contracts (HTTP API, SSE stream, dashboard UI) using mocked data sources, so that internals can change freely without breaking consumers.

## Background

### Current State

- **Zero automated tests.** No test runner, no test files, no devDependencies for testing.
- `smoke-test.ps1` exists but is manual, PowerShell-only, and tests a narrow happy path.
- `status-server.js` (~642 lines) has module-level side effects: DB connections open at `require()` time, Express app created at module scope, `app.listen()` called unconditionally. **This means you can't import the module in a test** without starting the server and requiring the real DBs to exist.

### Testing Philosophy

**Behavioral tests at the edges, not unit tests of internals.**

- The system has two external edges: the **HTTP/SSE API** (consumed by the dashboard and wrapper scripts) and the **browser dashboard** (consumed by the user).
- Tests should verify what the system does, not how it does it. Internal functions, state shapes, and data flow can change freely as long as the external behavior is preserved.
- Data sources (OpenCode DB, Learnings DB, JSON files) are mocked using **in-memory SQLite databases** — real SQL queries run against controlled test data, but no files on disk are needed.
- Frontend behavior is tested with **Playwright** against a running server with controlled state.

### Test Layers

```
Layer 1: Server behavioral tests (node:test + supertest)
  Tests the HTTP/SSE contract with in-memory DBs

Layer 2: Pure function tests (node:test, no mocking)
  Tests input parsing and pattern matching at the boundary

Layer 3: Frontend behavioral tests (Playwright)
  Tests what the user actually sees and interacts with
```

## Files to Change

| File | What changes |
|---|---|
| `status-server.js` | Extract `createApp(config)` factory, guard `app.listen()` with `require.main === module` |
| `package.json` | Add `devDependencies` and `test`/`test:e2e` scripts |

## Files to Create

| File | Purpose |
|---|---|
| `tests/helpers/create-app.js` | Thin wrapper that calls `createApp()` with test defaults |
| `tests/helpers/db-fixtures.js` | Factory functions for in-memory SQLite DBs with test data |
| `tests/helpers/sse-helper.js` | Parse SSE events from a supertest response stream |
| `tests/api.test.js` | HTTP API contract tests |
| `tests/state.test.js` | State machine behavioral tests |
| `tests/attention.test.js` | Attention detection pattern tests |
| `tests/summarize.test.js` | Content summarization edge tests |
| `tests/sse.test.js` | SSE contract smoke tests (fast, supplement to Playwright) |
| `tests/integration.test.js` | OpenCode DB integration tests with fixture data |
| `tests/e2e/test-server.js` | Test server for Playwright (no external DBs, port 3748) |
| `tests/e2e/dashboard.spec.js` | Playwright frontend behavioral tests |
| `playwright.config.js` | Playwright configuration |

## Tasks

### Task 0 — Make the server testable

**File:** `status-server.js`

**What:** Extract a `createApp(config)` factory function and guard `app.listen()`.

**Why:** This is the gate for all other tasks. Without it, you can't import the server in a test without starting it and requiring real DB files on disk. This changes zero behavior — it just makes the existing behavior importable.

**Config shape:**

```js
function createApp(config = {}) {
  // config:
  //   opencodeDb:    Database | null    (default: open from OPENCODE_DB_PATH)
  //   learningsDb:   Database | null    (default: open from LEARNINGS_DB_PATH)
  //   statusFile:    string             (default: STATUS_FILE)
  //   feedFile:      string             (default: FEED_FILE)
  //   skipPolling:   boolean            (default: false — skip setInterval for DB polling)
  //   skipFlush:     boolean            (default: false — skip setInterval for disk flush)
  //
  // Returns: { app, getState, pollOpenCodeActivity, cleanup, checkNeedsAttention, summarizeContent }
  //
  // Also exported at module level: VALID_AGENTS, VALID_STATES, ATTENTION_PATTERNS
}
```

**Changes:**

1. Keep constants at module level — `VALID_AGENTS`, `VALID_STATES`, `ATTENTION_PATTERNS`, `MAX_FEED_ITEMS`, `MAX_ACTIVITY_ITEMS`, `LEARNINGS_MAX_FETCH`, `OPENCODE_AGENTS`. These are true constants, not per-instance config. They should NOT move inside `createApp()`.
2. Wrap everything from line 8 (`const app = express()`) through line 576 (end of routes) inside `createApp(config)`, **excluding** the constants from step 1.
3. Replace hardcoded `opencodeDb`/`learningsDb` with `config.opencodeDb` / `config.learningsDb`. Keep the current `try/catch` open-from-disk as the default when config doesn't provide them.
4. Replace hardcoded `STATUS_FILE`/`FEED_FILE` with `config.statusFile` / `config.feedFile`.
5. When `config.skipPolling` is true, don't call `setInterval(pollOpenCodeActivity, ...)`.
6. When `config.skipFlush` is true, don't call `setInterval(flushToDisk, ...)`.
7. **Call `initState()` at the end of `createApp()` setup**, after `statusFile`/`feedFile` are configured from config. Currently `initState()` is called inside `app.listen()` (line 581) — it must move into `createApp()` so that `agentState` is populated before any route handler runs. Without this, `agentState` is `null` and every route crashes with `TypeError: Cannot read properties of null`.
8. Add a `cleanup()` function inside `createApp()` that clears all active intervals (polling, flush) and destroys all SSE connections (iterates `sseClients`, calls `res.end()`, clears the set). This prevents `node:test` from hanging after SSE tests.
9. Return `{ app, getState, pollOpenCodeActivity, cleanup, checkNeedsAttention, summarizeContent }`. Note: `pollOpenCodeActivity` must be exposed so integration tests (Task 7) can manually trigger a poll cycle when `skipPolling: true`. `pollAgentSubstatus` is called internally by `pollOpenCodeActivity`, so only the outer function is needed.
10. Guard `app.listen()` block (lines 580-642) with `if (require.main === module)`.
11. Add `module.exports = { createApp, VALID_AGENTS, VALID_STATES, ATTENTION_PATTERNS }` at the bottom. Constants are exported at module level alongside the factory.

**Verification:** `npm start` still works identically. The exported `createApp()` can be called from a test file. `cleanup()` can be called in test teardown to prevent hangs.

---

### Task 1 — Test infrastructure

**New devDependencies:**

```json
{
  "devDependencies": {
    "supertest": "^7.0.0",
    "@playwright/test": "^1.50.0"
  }
}
```

No test runner dependency — use Node.js built-in `node:test` (ships with Node 18+).

**package.json additions:**

Add `engines` field to guard against older Node versions (since `node:test` requires 18+):

```json
{
  "engines": { "node": ">=18" }
}
```

Add scripts:

```json
{
  "scripts": {
    "start": "node status-server.js",
    "test": "node --test tests/*.test.js",
    "test:e2e": "npx playwright test"
  }
}
```

**Install Playwright browsers:**

```powershell
npx playwright install chromium
```

**Create directory structure:**

```
tests/
  helpers/
    create-app.js
    db-fixtures.js
    sse-helper.js
  e2e/
    dashboard.spec.js
  api.test.js
  state.test.js
  attention.test.js
  summarize.test.js
  sse.test.js
  integration.test.js
```

**`tests/helpers/create-app.js`** — Thin wrapper:

```js
const { createApp } = require('../../status-server');
const os = require('os');
const path = require('path');
const fs = require('fs');

function createTestApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
  const defaults = {
    opencodeDb: null,
    learningsDb: null,
    statusFile: path.join(tmpDir, 'status.json'),
    feedFile: path.join(tmpDir, 'feed.json'),
    skipPolling: true,
    skipFlush: true,
  };
  const result = createApp({ ...defaults, ...overrides });
  // Attach tmpDir cleanup for use in afterEach/after hooks
  result.cleanupTmpDir = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

module.exports = { createTestApp };
```

Tests should call `cleanup()` (clears intervals/SSE connections) and `cleanupTmpDir()` (removes temp files) in `after` hooks to prevent hangs and temp dir accumulation.

**`tests/helpers/db-fixtures.js`** — In-memory SQLite factories:

```js
const Database = require('better-sqlite3');

function createOpenCodeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created TEXT
    )
  `);
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      data TEXT,
      time_created TEXT
    )
  `);
  return db;
}

function insertMessage(db, { id, agent, role, content, model, provider, time }) {
  const data = JSON.stringify({ agent, role, content, modelID: model, providerID: provider });
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, 'test-session', data, time);
}

function insertPart(db, { id, messageId, type, text, tool, toolStatus, reason, time }) {
  const partData = { type };
  if (text !== undefined) partData.text = text;
  if (tool !== undefined) partData.tool = tool;
  if (toolStatus !== undefined) partData.state = { status: toolStatus };
  if (reason !== undefined) partData.reason = reason;
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    .run(id, messageId, 'test-session', JSON.stringify(partData), time);
}

function createLearningsDb(entries = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      type TEXT,
      title TEXT,
      content TEXT,
      project TEXT,
      tags TEXT,
      created_at TEXT
    )
  `);
  for (const entry of entries) {
    db.prepare('INSERT INTO entries (type, title, content, project, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.type, entry.title, entry.content, entry.project || null, entry.tags || null, entry.created_at);
  }
  return db;
}

module.exports = { createOpenCodeDb, insertMessage, insertPart, createLearningsDb };
```

**`tests/helpers/sse-helper.js`** — Parse SSE events from supertest:

```js
function collectSSEEvents(response, { count = 1, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    const timer = setTimeout(() => resolve(events), timeoutMs);

    response.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch { /* skip non-JSON (heartbeats etc.) */ }
          if (events.length >= count) {
            clearTimeout(timer);
            resolve(events);
          }
        }
      }
    });

    response.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { collectSSEEvents };
```

---

### Task 2 — HTTP API contract tests

**File:** `tests/api.test.js`

Tests the external HTTP contract that every consumer (dashboard, wrapper scripts) depends on.

```
describe('GET /status')
  - returns 200
  - response has { agents, serverStarted }
  - all 4 agents present: planner, coder, reviewer, refactor
  - each agent has state, message, updated fields
  - each agent has recentActivity array

describe('POST /status — validation')
  - valid body returns 200 with { ok: true, agent, state }
  - missing agent returns 400
  - invalid agent name returns 400 with descriptive error
  - missing state returns 400
  - invalid state name returns 400 with descriptive error
  - missing message defaults to empty string

describe('POST /status — write-then-read')
  - POST {agent: "planner", state: "active"} → GET /status shows planner as active
  - POST updates the agent's "updated" timestamp
  - POST for one agent does not change another agent's state

describe('GET /feed')
  - returns array
  - default returns up to 20 items
  - ?limit=5 respects limit
  - limit is capped at 50 (MAX_FEED_ITEMS)
  - items have agent, type, message, time fields
  - item type is one of: lifecycle, prompt, response, info

describe('GET /learnings')
  - returns array when learningsDb is null (empty array, no crash)
  - returns data when learningsDb has entries
  - ?limit=3 respects limit
  - limit capped at LEARNINGS_MAX_FETCH

describe('GET /')
  - returns 200
  - Content-Type includes text/html
```

---

### Task 3 — State machine behavioral tests

**File:** `tests/state.test.js`

Tests that state transitions through the HTTP API produce correct cumulative behavior.

```
describe('default state')
  - all agents start as idle
  - all agents have empty message

describe('state transitions')
  - idle → active: state becomes active
  - active → done: state becomes done
  - active → attention: state becomes attention
  - active → error: state becomes error
  - done → active: can restart (wrapper script re-launch)
  - arbitrary transitions are allowed (server doesn't enforce ordering)

describe('substatus clearing')
  - POST state=done clears substatus to null
  - POST state=error clears substatus to null
  - POST state=idle clears substatus to null
  - POST state=attention clears substatus to null (most interesting case — substatus is likely 'awaiting-input' when entering attention)
  - POST state=active does NOT clear substatus

describe('feed accumulation')
  - each POST creates a feed item with type "lifecycle"
  - feed items appear in newest-first order
  - feed item has correct agent name and message
  - 60 POSTs → feed capped at 50 items

describe('agent isolation')
  - POST to planner does not affect coder state
  - POST to coder does not affect reviewer state
```

---

### Task 4 — Attention detection tests

**File:** `tests/attention.test.js`

Tests the regex patterns that drive the attention state. Uses in-memory SQLite with injected text to test `checkNeedsAttention()`.

```
describe('ATTENTION_PATTERNS — positive matches')
  - trailing question mark: "What do you think?"
  - "Should I proceed with this approach?"
  - "Would you like me to continue?"
  - "Do you want me to push this?"
  - "Please confirm the approach"
  - "Please clarify the requirements"
  - "Let me know if this looks right?"
  - "I need from you the API key"
  - "What do you think about this design?"
  - "What would you prefer here?"
  - "Can you confirm this is correct?"
  - "Waiting for your input"
  - "Waiting for your response"
  - "How would you like this organized?"
  - "Which option do you prefer?"
  - "Which approach should we take?"

describe('ATTENTION_PATTERNS — negative matches (must NOT trigger)')
  - "Here's the implementation."
  - "Done. All tests pass."
  - "I've fixed the bug and updated tests."
  - "### Summary\n- Changed X\n- Updated Y"
  - "Let me know" WITHOUT trailing ? (e.g. "Let me know when ready.")
  - "Should I" WITHOUT trailing ? (e.g. "I thought about whether I should refactor.")

describe('checkNeedsAttention — behavioral')
  - returns true when last assistant text ends with question
  - returns false when last assistant text is declarative
  - only scans last 1500 chars (question at char 0 of 3000-char text → false)
  - question in last 1500 chars of long text → true
  - returns false when no text parts exist
  - returns false when no messages exist for agent
```

For behavioral tests, create an in-memory SQLite DB with `message` and `part` tables. Insert a message with `role: 'assistant'` and `agent: 'planner'`, then insert a `part` with `type: 'text'` containing the test text. Call `checkNeedsAttention(db, 'planner')`.

---

### Task 5 — Content summarization tests

**File:** `tests/summarize.test.js`

Tests the `summarizeContent()` function's input parsing edge cases.

```
describe('summarizeContent')
  - JSON array with {type: "text", text: "hello"} → "hello"
  - JSON array with multiple blocks, picks first text block
  - JSON array with no text block → ""
  - JSON string '"hello"' → "hello"
  - JSON object {text: "hello"} → "hello"
  - non-JSON raw string → returned as-is
  - null → ""
  - undefined → ""
  - empty string → ""
  - content exactly 500 chars → no truncation
  - content 501 chars → truncated to 500 + "..."
  - content 1000 chars → truncated to 500 + "..."
```

---

### Task 6 — SSE contract smoke tests

**File:** `tests/sse.test.js`

Small number of fast tests that verify the SSE contract. Playwright covers the full SSE→DOM pipeline; these give fast diagnostic feedback when something breaks.

```
describe('GET /stream')
  - response has Content-Type text/event-stream
  - response has Cache-Control no-cache
  - first event is type "init"
  - init event has status, feed, learnings fields
  - init status matches GET /status response shape

describe('SSE events on state change')
  - POST /status triggers agent-update event
  - agent-update event has correct agent name and updated state
  - POST /status triggers feed event
  - feed event has correct agent, type, message

describe('SSE client management')
  - disconnected client does not crash subsequent broadcasts
  - two connected clients both receive the same agent-update event (fan-out)
```

---

### Task 7 — OpenCode DB integration tests

**File:** `tests/integration.test.js`

Tests the DB polling behavior with in-memory fixture databases. These verify that the SQL queries and JSON extraction paths actually work — the contract between agent-hub and the opencode DB schema.

```
describe('pollOpenCodeActivity — message processing')
  - new user message → agent state becomes active with "Working on: ..." message
  - new assistant message → agent state becomes active with "Responded"
  - messages before lastSeenTimestamp are ignored
  - assistant message extracts model and provider
  - activity buffer populated with type, content, timestamp
  - activity buffer capped at MAX_ACTIVITY_ITEMS (10)

describe('pollOpenCodeActivity — feed items')
  - user message creates feed item with type "prompt"
  - assistant message creates feed item with type "response"
  - feed item message is truncated to 100 chars

describe('pollAgentSubstatus — part table')
  - part type step-start → substatus "thinking"
  - part type reasoning → substatus "thinking"
  - part type tool with status running → substatus "tool", toolName set
  - part type tool with status completed → substatus "thinking" (done with tool, back to thinking)
  - part type text → substatus "responding"
  - part type step-finish with reason stop → substatus "awaiting-input"
  - part type step-finish with reason tool-calls → substatus "thinking"
  - substatus only set when agent state is active
  - substatus cleared when agent state is not active

describe('graceful degradation')
  - opencodeDb is null → polling is a no-op (no crash)
  - learningsDb is null → GET /learnings returns empty array
```

For each test, create a fresh in-memory SQLite DB, insert the relevant rows, pass it to `createApp({ opencodeDb: db })`, then trigger polling and verify state via `GET /status` or the returned `getState()`.

---

### Task 8 — Playwright frontend behavioral tests

**File:** `tests/e2e/dashboard.spec.js`  
**File:** `playwright.config.js`

**Playwright config:**

```js
// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3748', // test port, not production 3747
  },
  webServer: {
    command: 'node tests/e2e/test-server.js',
    port: 3748,
    reuseExistingServer: false,
  },
});
```

**Test server for Playwright** (`tests/e2e/test-server.js`):

A thin script that starts the app on port 3748 with no external DB dependencies:

```js
const { createApp } = require('../../status-server');

const { app } = createApp({
  opencodeDb: null,
  learningsDb: null,
  skipPolling: true,
  skipFlush: true,
});

app.listen(3748, () => console.log('Test server on 3748'));
```

**Tests:**

```
describe('dashboard — initial load')
  - page title is "Agent Hub"
  - 4 agent cards visible: Planner, Coder, Reviewer, Refactor
  - all cards show idle state on load
  - activity feed section exists
  - learnings panel exists (may be empty)

describe('dashboard — real-time updates via SSE')
  - POST /status {planner, active} → planner card updates to show "active"
  - POST /status {coder, active} → coder card updates to show "active"
  - POST /status {planner, done} → planner card updates to show "done"
  - POST /status {reviewer, attention} → reviewer card shows attention styling (pulsing)
  - state change creates entry in activity feed

describe('dashboard — attention UX')
  - attention state → card has pulsing animation class
  - attention state → tab title includes attention indicator
  - multiple agents in attention → tab title reflects count
  - clearing attention (POST active) → pulsing stops

describe('dashboard — offline handling')
  - kill test server → offline banner appears within a few seconds
  - restart test server → offline banner disappears, state resynchronizes

describe('dashboard — user interactions')
  - click agent card → clipboard contains launch command (verify via page.evaluate)
```

**Note on offline test:** The offline/reconnect test requires stopping and restarting the server mid-test. Playwright supports this via its `webServer` fixture, but this test is more complex to implement. It can be deferred to a follow-up if needed.

---

## Execution Order

```
Task 0 (createApp extraction)     ← GATE — must go first
  |
Task 1 (test infrastructure)      ← package.json, helpers, directories
  |
  ├── Task 5 (summarize tests)    ← pure function, easiest, validates setup works
  ├── Task 4 (attention tests)    ← pure function + fixture DB
  ├── Task 2 (API tests)          ← highest value, validates the extraction
  ├── Task 3 (state tests)        ← builds on Task 2 patterns
  ├── Task 6 (SSE tests)          ← needs SSE helper
  ├── Task 7 (integration tests)  ← needs fixture DB, most setup
  |
Task 8 (Playwright tests)         ← last — depends on everything else working
```

Tasks 2-7 have no dependencies on each other and can be done in any order after Task 1.

## Validation

```powershell
# Run server behavioral tests (fast, ~2s)
npm test

# Run individual test files
node --test tests/api.test.js
node --test tests/attention.test.js

# Run Playwright frontend tests (~10-20s)
npm run test:e2e

# Existing smoke test still works unchanged
.\smoke-test.ps1
```

## New Dependencies

| Package | Type | Why |
|---|---|---|
| `supertest` | devDependency | HTTP-level testing for Express apps — the standard, no network needed |
| `@playwright/test` | devDependency | Browser-level behavioral testing for the dashboard |

Test runner is `node:test` (built into Node 18+) — zero additional dependency.

## Risks / Open Questions

1. **Task 0 is the gate.** If `createApp()` extraction is messy, everything else is blocked. Based on reading the code, this should be straightforward — the module has clear initialization boundaries (DB opens, app creation, route definitions, listen).

2. **OpenCode DB schema changes.** The fixture DB factories in `db-fixtures.js` mirror opencode's `message` and `part` table schemas. If opencode changes its schema, fixture creators need updating. This is a feature, not a bug — these tests exist to catch exactly this kind of breakage.

3. **Playwright browser installation.** `npx playwright install chromium` downloads ~150MB. This is a one-time cost and can be cached in CI. Only Chromium is needed (not Firefox/WebKit) since we're testing our own dashboard, not cross-browser compatibility.

4. **Offline/reconnect Playwright test.** The "kill server → offline banner → restart → reconnect" test is the most complex e2e test. If it proves flaky, defer to a follow-up.

5. **SSE timing in tests.** Both supertest SSE tests and Playwright tests involve async event delivery. The SSE helper uses a timeout-based collector. If tests are flaky due to timing, increase the timeout or switch to event-count-based resolution (already supported in the helper).

6. **No learnings table schema guarantee.** The learnings DB fixture assumes an `entries` table with specific columns. If `learnings-mcp` changes its schema, `createLearningsDb()` needs updating. Low risk — you control both projects.

---

## Critique Log

Reviewed by reviewer agent on 2026-03-01. See `test-coverage.critique.md` for full findings.

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | `initState()` not called in `createApp()` — all tests crash | 🔴 | Added as step 7 in Task 0 |
| 2 | `pollOpenCodeActivity` not returned — Task 7 blocked | 🔴 | Added to return object in step 9 |
| 3 | `test-server.js` missing from Files to Create table | 🟡 | Added row |
| 4 | No SSE test teardown — `npm test` hangs | 🟡 | Added `cleanup()` function in step 8 |
| 5 | `state=attention` substatus clearing not tested | 🟡 | Added test case to Task 3 |
| 6 | Constants needlessly inside `createApp()` closure | 🟡 | Step 1 now keeps constants module-level |
| 7 | No feed item `type` validation test | 🟡 | Added test case to Task 2 |
| 8 | Temp directory cleanup | 🟢 | Added `cleanupTmpDir()` to create-app helper |
| 9 | No concurrent SSE client test | 🟢 | Added fan-out test to Task 6 |
| 10 | No `engines` field for Node version guard | 🟢 | Added to Task 1 package.json additions |
