# Critique: Copilot Coder Agent Parity Plan

**Reviewer:** reviewer agent
**Date:** 2026-03-02
**Verdict:** Needs fixes before implementation (4 must-fix, 1 should-address)

## Summary

Well-structured plan with solid research, but has 2 important bugs in the proposed polling logic and a few design gaps worth addressing before implementation. The research into events.jsonl format is thorough and will save significant debugging time.

---

## Findings

### 🔴 Critical: Partial line read causes permanently skipped events (Task 5)

**Location:** Plan lines 256–282 (`pollCopilotActivity`)

**Issue:** If `readFileSync` catches the file mid-write of a line, the partial JSON will land in `lines` after `split('\n').filter(l => l.trim())`. `JSON.parse` fails and the event is skipped via `continue`, but `copilotLastEventIndex` has already been advanced to `lines.length` before the loop starts. On the next poll, the now-complete line won't be re-processed because the index is already beyond it.

**Trace:**
1. File has 10 complete lines + 1 partial → `lines.length = 11`
2. `copilotLastEventIndex` set to `11`
3. Partial line fails `JSON.parse` → skipped
4. Next poll: file now has 11 complete lines → `lines.length = 11 <= copilotLastEventIndex (11)` → returns early
5. **Event permanently lost**

**Impact:** Missed tool calls, missed model detection, missed attention triggers.

**Fix:** Only advance `copilotLastEventIndex` per successfully parsed line, and `break` on failure (a partial line can only occur at the end):

```js
for (let i = 0; i < newLines.length; i++) {
  try {
    const event = JSON.parse(newLines[i]);
    processCopilotEvent(event);
    copilotLastEventIndex++;  // only advance on success
  } catch {
    break;  // partial line at end — stop here, retry next poll
  }
}
```

---

### 🟡 Important: No "skip to current" on initial session discovery — feed flood (Task 5)

**Location:** Plan lines 239–240

**Issue:** `copilotLastEventIndex` starts at `0` and resets to `0` on session change. When the server starts (or discovers a new session), it will process ALL historical events from `events.jsonl` — potentially hundreds of events from a previous interaction. This floods `activityBuffers.coder`, `feedBuffer`, and fires many SSE broadcasts of stale data.

**Contrast:** For OpenCode agents, `initLastSeenTimestamps()` (status-server.js line 487) initializes to `MAX(time_created)` specifically to avoid replaying history.

**Fix:** Add an `initCopilotEventIndex()` function that reads the current line count and sets `copilotLastEventIndex` to skip history, only backtracking for `session.start` (model detection):

```js
function initCopilotEventIndex(eventsPath) {
  try {
    const content = fs.readFileSync(eventsPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    copilotLastEventIndex = lines.length;  // skip to end

    // Backtrack to grab model from session.start
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev.type === 'session.start' && ev.data?.selectedModel) {
          updateAgentState('coder', { model: ev.data.selectedModel, provider: 'github-copilot' });
          break;
        }
      } catch { continue; }
    }
  } catch { /* file doesn't exist yet, start at 0 */ }
}
```

Call this when the session is first discovered (inside the `if (sessionId !== copilotSessionId)` block).

---

### 🟡 Important: `copilotTurnContext` not reset on session change (Task 5 + Task 9)

**Location:** Plan lines 247–255 and 551–565

**Issue:** When `sessionId !== copilotSessionId`, the plan resets `copilotLastEventIndex` but does NOT reset `copilotTurnContext`. Stale turn context from the old session could trigger a false `checkCopilotNeedsAttention()` result on the first `assistant.turn_end` of the new session.

**Fix:** Call `resetCopilotTurnContext()` alongside the index reset:

```js
if (sessionId !== copilotSessionId) {
  copilotSessionId = sessionId;
  copilotLastEventIndex = 0;  // (or use initCopilotEventIndex)
  resetCopilotTurnContext();   // <-- add this
}
```

---

### 🟡 Important: `toolRequests[].arguments` may be a JSON string, not an object (Task 7)

**Location:** Plan lines 395–399

**Issue:** The plan accesses `intentCall?.arguments?.intent` directly. In many LLM event formats, `arguments` is a JSON-encoded **string**, not a parsed object. If so, `intentCall.arguments.intent` would be `undefined` and the intent message would silently never appear.

**Impact:** `report_intent` signals — the best plaintext signal for what the coder is doing — would be completely ignored, degrading activity feed usefulness.

**Fix:** Add a defensive parse:

```js
const rawArgs = intentCall.arguments;
const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
if (args?.intent) { ... }
```

The plan should verify the actual shape of `toolRequests` entries in `events.jsonl` during Task 1's verification session and document it.

---

### 🟡 Important: Background job vs. server-side session discovery complexity (Task 3)

**Location:** Plan lines 135–197

**Issue:** The plan acknowledges (Risk #3) that copilot may reuse sessions, in which case the "diff session dirs" approach finds nothing. The fallback (`findActiveCopilotSession`) is server-side and handles both cases. But the primary approach (PowerShell background job) adds significant complexity:

- PowerShell `Start-Job` is slow to start on Windows (~1-2s overhead)
- The background job runs in a separate process with its own environment
- If copilot reuses a session, the job times out silently and the fallback kicks in anyway
- The wrapper needs cleanup logic (`Remove-Job`)

The plan says "evaluate both approaches and pick the simpler one that works" — good instinct. **Recommendation:** Make server-side discovery the primary approach and drop the background job from the initial implementation. `coder.ps1` stays simple (no session discovery changes). Add the background job only if server-side discovery proves unreliable in testing.

This simplifies Phase 2 to just Task 4 (accept sessionId in POST /status) and Task 6 (findActiveCopilotSession). Task 3 becomes optional/deferred.

---

### 🟢 Minor: `findActiveCopilotSession()` scans all session dirs every 2 seconds (Task 6)

**Location:** Plan lines 295–331

**Issue:** With 12 sessions now, this reads 12 `workspace.yaml` files every poll cycle. Session count will grow over time with no cleanup mechanism.

**Suggestion:** Cache the discovered session ID. Only re-scan when coder transitions to `active` without a `sessionId` already set. Once a session is found, stop scanning until the coder goes `done` and back to `active`.

---

### 🟢 Minor: Multiple `broadcastSubstatusUpdate()` calls per poll cycle (Task 7)

**Location:** Plan lines 340–501

**Issue:** Processing a batch of events (e.g., `turn_start` → `message` → `tool_start` → `tool_complete` → `message` → `turn_end`) fires 6 separate SSE broadcasts in rapid succession. The dashboard re-renders 6 times in one frame.

**Suggestion:** Consider batching: process all new events, then broadcast a single update at the end of the poll cycle. Or note this as a later optimization — it won't break anything, just wastes re-renders.

---

### 🟢 Minor: `SHORTCUT_API_TOKEN` env var interpolation uncertainty (Task 1)

**Location:** Plan line 115

**Issue:** The plan flags this as unknown and offers a fallback (parent shell env inheritance). Good. But if `${SHORTCUT_API_TOKEN}` syntax isn't supported, having it in the config file is harmless but misleading.

**Suggestion:** Test during Phase 1 and document the outcome. If copilot passes parent env through (likely — most process spawners do), just omit the `env` block for shortcut entirely.

---

## What Looks Good

- **Thorough research**: The events.jsonl format is well-documented with actual field names, encryption constraints, and real session data. This avoids the "discover the format while implementing" trap.
- **Conservative attention detection**: Preferring false n
