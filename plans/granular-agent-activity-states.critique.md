# Critique: Granular Agent Activity States

> Review of `granular-agent-activity-states.md` — performed 2026-03-01
> Reviewer: reviewer agent
> Verdict: **Needs fixes** (no redesign required)

## Summary

The plan is well-structured and thorough — clear goal, accurate line references, solid data flow diagram. However, it has **one bug in the switch logic**, **a significant query performance issue confirmed by EXPLAIN QUERY PLAN**, **a missing tool status (`pending`)**, **dead code**, and **a double-counting issue** in the header display. All are fixable without redesign.

---

## Findings

### 🔴 Critical: `default` case silently clears substatus instead of preserving it

- **Location:** Task 2, the `switch(latestPart.partType)` block
- **Issue:** `newSubstatus` is initialized to `null` (line 143 of the proposed code). The `default` case does `break` with a comment saying "leave substatus as-is." But after the switch, the comparison `prev.substatus !== newSubstatus` evaluates to `'tool' !== null` → `true`, so it **overwrites the current substatus with `null`**. This is the opposite of what the comment says.
- **Impact:** Any unrecognized part type (e.g., `compaction`, future part types) would flash the substatus to `null`, making the UI briefly lose its "thinking/tool/responding" indicator.
- **Fix:** Either (a) add `newSubstatus = prev?.substatus; newToolName = prev?.toolName;` in the `default` case, or (b) `continue` before the comparison block when `newSubstatus` is still `null` after the switch:
  ```js
  // After the switch, before the comparison:
  if (newSubstatus === null) continue;
  ```

---

### 🟡 Important: Full table scan on 41K+ parts — confirmed by EXPLAIN QUERY PLAN

- **Location:** Task 2, the SQL query
- **Issue:** `EXPLAIN QUERY PLAN` confirms `SCAN p` (full table scan of all parts), `USE TEMP B-TREE FOR ORDER BY` (no index for the sort). The `part` table has **41,270 rows** and growing. This runs **3 times every 2 seconds** (once per opencode agent). That's ~124K row scans + 3 temp sorts per cycle.
- **Impact:** Currently tolerable but will degrade as the DB grows. Risk #4 in the plan acknowledges this but says "opencode likely indexes this already" — **it does not**. The only indices are `part_message_idx (message_id)` and `part_session_idx (session_id)`.
- **Fix:** Restructure the query to leverage the existing `part_message_idx` index by first finding the latest assistant message, then getting its parts:
  ```sql
  SELECT json_extract(p.data, '$.type') as partType, ...
  FROM part p
  WHERE p.message_id = (
    SELECT m.id FROM message m
    WHERE json_extract(m.data, '$.agent') = ?
      AND json_extract(m.data, '$.role') = 'assistant'
    ORDER BY m.time_created DESC
    LIMIT 1
  )
  ORDER BY p.time_created DESC
  LIMIT 1
  ```
  This uses the `part_message_idx` for a fast lookup rather than scanning all 41K parts.

---

### 🟡 Important: Missing `pending` tool status

- **Location:** Task 2, the `tool` case in the switch
- **Issue:** Real data shows tool parts go through three statuses: `pending` → `running` → `completed`. The plan only handles `running` (shows "tool") and everything else (shows "thinking"). When a tool is `pending`, showing "thinking" is slightly misleading — the agent has already committed to running a tool.
- **Impact:** Brief UI inaccuracy. At 2s polling, you'd likely catch `running` most of the time, so this is low-severity in practice.
- **Fix:** Add `pending` to the `running` check:
  ```js
  if (status === 'running' || status === 'pending') {
    newSubstatus = 'tool';
    newToolName = latestPart.toolName || 'unknown';
  }
  ```

---

### 🟡 Important: `awaitingCount` and `activeCount` double-count, creating confusing header text

- **Location:** Task 7c, header count update
- **Issue:** An agent with `state: 'active'` AND `substatus: 'awaiting-input'` increments **both** `activeCount` (existing line 1202) and `awaitingCount` (plan's new code). The header would show "1 awaiting input, **2** active" when only 2 agents are doing things (1 waiting + 1 working). The user would think 3 agents are busy.
- **Impact:** Misleading dashboard header. Confusing at a glance.
- **Fix:** Either (a) subtract awaiting from active in the display: `${activeCount - awaitingCount} active`, or (b) don't increment `activeCount` for awaiting agents by restructuring the counting:
  ```js
  if (state === 'active' && substatus === 'awaiting-input') {
    awaitingCount++;
  } else if (state === 'active') {
    activeCount++;
  }
  ```

---

### 🟡 Important: Dead code — `lastSeenPartTimestamps` is never used

- **Location:** Task 1 (entire task)
- **Issue:** Task 1 adds `lastSeenPartTimestamps` and initializes it with a startup query. But `pollAgentSubstatus()` in Task 2 never reads or updates this variable. The query just gets `LIMIT 1` unconditionally — there's no incremental "since last seen" filtering to prevent.
- **Impact:** Dead code adds confusion. The initialization query runs at startup for no reason.
- **Fix:** Remove Task 1 entirely. It adds complexity with no consumer. If incremental filtering is needed later for performance, add it then.

---

### 🟢 Minor: Two `updateAgentState` calls in Task 5 could be merged

- **Location:** Task 5, POST /status handler
- **Issue:** The plan calls `updateAgentState` for state/message, then conditionally calls it again for substatus/toolName. Each call updates the `updated` timestamp, creating two writes where one suffices.
- **Fix:** Merge into a single call:
  ```js
  const updates = { state, message: message || '' };
  if (state !== 'active') {
    updates.substatus = null;
    updates.toolName = null;
  }
  updateAgentState(agent, updates);
  ```

---

### 🟢 Minor: Could extract `toolState.status` directly in SQL

- **Location:** Task 2, SQL query
- **Issue:** The query extracts `json_extract(p.data, '$.state')` as a JSON string, then parses it in JS to get `.status`. SQLite can do this directly: `json_extract(p.data, '$.state.status')`.
- **Fix:** Change the SQL column to `json_extract(p.data, '$.state.status') as toolStatus` and simplify the JS to just read `latestPart.toolStatus`. Eliminates the try/catch JSON parse block entirely.

---

### 🟢 Minor: Brief substatus gap between user prompt and first `step-start`

- **Location:** Plan architecture (not specific to a task)
- **Issue:** When a user sends a new prompt, `pollOpenCodeActivity` sets `state: 'active'` immediately. But the assistant's first `step-start` part hasn't been written yet. `pollAgentSubstatus` would see the previous turn's `step-finish reason:"stop"` and set substatus to `awaiting-input`. For up to 2 seconds, the UI shows "Awaiting input" even though the agent is processing.
- **Impact:** Very brief visual glitch. Mostly academic since the next poll corrects it.
- **Fix:** Not worth fixing now, but worth documenting in the risks section.

---

## What Looks Good

- **Line references are all accurate** — verified every cited line number against both source files (status-server.js at 484 lines, agent-hub.html at 1442 lines). This is rare and appreciated.
- **The substatus model design** (thinking/tool/responding/awaiting-input as an overlay on the existing state machine) is clean and backward-compatible.
- **CSS visual hierarchy** is well-thought-out: attention (fast pulse) > awaiting (slow pulse) > working (dot only) > idle (nothing). Clear UX rationale documented.
- **SSE broadcast architecture** reuses the existing `agent-update` event type, so the client doesn't need new event handlers.
- **Task 4 "no change needed"** is correct — the deep copy in `buildStatusSnapshot` automatically includes new fields. Good that the plan explicitly verified this rather than adding unnecessary code.
- **Risks section** is honest and comprehensive (especially risk #1 about coder agent, risk #3 about flicker, risk #5 about ephemeral state). The plan is self-aware about its limitations.

---

## Verdict

- [ ] Ready to implement
- [x] Needs fixes (address findings below before handing to the Coder)
- [ ] Needs redesign

### Required fixes (in priority order)

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 1 | Switch default bug — clears instead of preserving substatus | 🔴 Critical | One line |
| 2 | Query restructuring — 41K-row scan 3×/2s is wasteful | 🟡 Important | Rewrite one SQL query |
| 3 | Double-counting — activeCount includes awaiting agents | 🟡 Important | Move counting logic |
| 4 | Remove dead Task 1 — `lastSeenPartTimestamps` unused | 🟡 Important | Delete task |
| 5 | Add `pending` tool status handling | 🟡 Important | One condition |
| 6 | Merge updateAgentState calls, simplify SQL extraction | 🟢 Minor | Small cleanup |
