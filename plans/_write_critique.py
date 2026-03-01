import os

content = r"""# Critique: Behavioral Test Coverage

> Review of `test-coverage.md` — performed 2026-03-01
> Reviewer: reviewer agent
> Verdict: **Needs fixes** (no redesign required)

## Summary

Strong plan with two critical gaps and a handful of important oversights. The testing philosophy is excellent (behavioral tests at the edges, not unit tests of internals), the dependency choices are minimal and well-justified, and the execution ordering is correct. However, the `createApp()` extraction spec omits initializing state — meaning every test would crash with a `TypeError` — and the integration tests (Task 7) have no way to trigger the polling they need to verify.

---

## Findings

### 🔴 Critical: `initState()` never called inside `createApp()`

- **Location:** Task 0 steps 1-8; `tests/helpers/create-app.js`
- **Issue:** The plan wraps lines 8-576 inside `createApp(config)` and guards `app.listen()` with `require.main === module`. But `initState()` is currently called on line 581 — *inside* `app.listen()`. The plan's `createApp()` function never calls `initState()`, so `agentState` remains `null`.
- **Impact:** Every route crashes. `GET /status` → `buildStatusSnapshot()` → `getState()` returns `null` → `JSON.parse(JSON.stringify(null))` → `null.agents` → **`TypeError: Cannot read properties of null`**. Zero tests in the entire plan would pass.
- **Fix:** Add an explicit step to Task 0: "Call `initState()` at the end of `createApp()` setup, after `STATUS_FILE` / `FEED_FILE` are configured from `config`." The test helper already points `statusFile` at a temp dir, so `readJSON()` would hit the `catch` and return `getDefaultStatus()` — exactly what tests want.

---

### 🔴 Critical: `pollOpenCodeActivity` not returned from `createApp()` — Task 7 blocked

- **Location:** Task 0 step 6; Task 7
- **Issue:** The `createApp` return value is `{ app, getState, broadcastSSE, checkNeedsAttention, summarizeContent, ATTENTION_PATTERNS, VALID_AGENTS, VALID_STATES }`. Task 7 says "trigger polling and verify state via `GET /status` or the returned `getState()`" but `pollOpenCodeActivity` and `pollAgentSubstatus` are not in the return list. The tests set `skipPolling: true` (correct — no `setInterval`), but then have no way to manually invoke a poll cycle.
- **Impact:** Every test in Task 7 (`tests/integration.test.js`) is unimplementable as specified. The substatus tests in particular (`pollAgentSubstatus — part table`) have no entry point at all.
- **Fix:** Add `pollOpenCodeActivity` to the return object in Task 0 step 6:
  ```js
  return { app, getState, broadcastSSE, checkNeedsAttention, summarizeContent,
           pollOpenCodeActivity, ATTENTION_PATTERNS, VALID_AGENTS, VALID_STATES };
  ```
  `pollAgentSubstatus` is called internally by `pollOpenCodeActivity`, so exposing only the outer function is sufficient.

---

### 🟡 Important: `tests/e2e/test-server.js` missing from "Files to Create" table

- **Location:** "Files to Create" table (plan line 43-58); Task 8
- **Issue:** Task 8 specifies `tests/e2e/test-server.js` with full source code, and the Playwright config references it (`command: 'node tests/e2e/test-server.js'`). But the "Files to Create" table lists only 10 files and omits `test-server.js`. A coder following the table as a checklist would miss it.
- **Fix:** Add row: `tests/e2e/test-server.js | Test server for Playwright (no external DBs, port 3748)`. Also note that this file is affected by the `initState()` gap — it would crash the same way.

---

### 🟡 Important: No teardown/cleanup for SSE tests — potential test hangs

- **Location:** Tasks 6 and 8; `tests/helpers/sse-helper.js`
- **Issue:** When a test connects to `GET /stream`, the server creates a heartbeat `setInterval` (line 506-508 in current code). The `collectSSEEvents` helper resolves after receiving events or a timeout, but nothing destroys the heartbeat interval or closes the response. `node:test` will hang waiting for the event loop to drain.
- **Impact:** `npm test` hangs after SSE tests complete, requiring manual kill or `--force-exit`.
- **Fix:** One of:
  - **(a) Best:** Return a `cleanup()` function from `createApp()` that clears all intervals and destroys all SSE connections.
  - **(b) Acceptable:** Add `afterEach` hooks in SSE tests that explicitly abort the request (triggering `req.on('close')` → `clearInterval(heartbeat)`).
  - **(c) Quick workaround:** Change the npm script to `node --test --test-force-exit tests/*.test.js`.
  Option (a) is cleanest and benefits Playwright tests too.

---

### 🟡 Important: POST `state=attention` substatus clearing not tested

- **Location:** Task 3, "substatus clearing" section
- **Issue:** The plan tests substatus clearing for `done`, `error`, and `idle` — but not `attention`. The actual code (line 532: `if (state !== 'active')`) clears substatus for ALL non-active states, including `attention`. This is the most interesting case because `attention` is the state where `substatus: 'awaiting-input'` is most likely already set.
- **Fix:** Add test case: "POST `state=attention` clears substatus to null."

---

### 🟡 Important: Constants should stay module-level, not inside `createApp()` closure

- **Location:** Task 0 step 6
- **Issue:** The return value includes `ATTENTION_PATTERNS`, `VALID_AGENTS`, and `VALID_STATES`. The plan says to wrap "everything from line 8 through line 576" inside `createApp()`. These constants (defined at lines 20-24, 335-349) would be recreated on every `createApp()` call — new arrays, new regex objects — for no benefit.
- **Fix:** Clarify in the plan: constants (`VALID_AGENTS`, `VALID_STATES`, `ATTENTION_PATTERNS`, `MAX_FEED_ITEMS`, `LEARNINGS_MAX_FETCH`) should remain module-level and be exported separately:
  ```js
  module.exports = { createApp, VALID_AGENTS, VALID_STATES, ATTENTION_PATTERNS };
  ```
  This avoids per-call allocation and matches the semantic intent (these are constants, not per-instance config).

---

### 🟡 Important: No test that feed items have valid `type` values

- **Location:** Task 2, `GET /feed` section
- **Issue:** The plan tests that items "have agent, type, message, time fields" — good. But it doesn't verify that `type` is one of the known values. The server produces `lifecycle` (from POST /status), `prompt`, `response`, and `info` (from polling). If a consumer depends on this contract, unknown types could break rendering.
- **Fix:** Add test: "feed items have `type` matching one of: `lifecycle`, `prompt`, `response`, `info`."

---

### 🟢 Minor: Temp directory cleanup

- **Location:** `tests/helpers/create-app.js`
- **Issue:** `fs.mkdtempSync()` creates a temp dir per test that is never cleaned up. On CI or after many test runs, these accumulate.
- **Suggestion:** Return a `cleanup()` function from `createTestApp` that calls `fs.rmSync(tmpDir, { recursive: true })`, or use `node:test`'s `afterEach` hook.

---

### 🟢 Minor: No test for multiple concurrent SSE clients

- **Location:** Task 6
- **Suggestion:** The code iterates `sseClients` Set and broadcasts to all. A test verifying that two connected clients both receive the same event would catch iterator/broadcast bugs. Low priority since the code is straightforward.

---

### 🟢 Minor: No `engines` field in `package.json`

- **Location:** Task 1
- **Suggestion:** Since the plan relies on `node:test` (Node 18+), adding `"engines": { "node": ">=18" }` to `package.json` would prevent confusing failures on older Node versions.

---

## What Looks Good

- **Testing philosophy is spot-on.** Behavioral tests at the edges, mocking data sources not modules, using real SQL against in-memory SQLite. This is the right approach for a codebase this size.
- **Minimal dependencies.** `node:test` built-in, only `supertest` and `@playwright/test` as devDependencies. No jest/mocha bloat.
- **Execution ordering is correct.** Task 0 as a gate, then infrastructure, then parallelizable test tasks, then Playwright last. The dependency graph is clean.
- **DB fixture design is accurate.** The in-memory S
