# Plan: Automatic Attention Detection

## Goal

Automatically detect when an agent is **asking a question or needs user input** and escalate from `awaiting-input` to the existing `attention` state — so the dashboard's fast-pulsing card, ⚠ badge, and tab title alert the user that an agent needs them.

## Background

### Current Problem

The granular substatus system (implemented in `granular-agent-activity-states.md`) correctly distinguishes thinking/tool/responding/awaiting-input. But when an agent finishes its turn, it always shows `substatus: 'awaiting-input'` regardless of whether:

- The agent **delivered a result** → user's turn, no rush
- The agent **asked a question** → user needs to respond before agent can continue
- The agent **needs permission** → blocked until user confirms

The `attention` state already exists in the state machine and is fully wired in the frontend (fast pulse, ⚠ badge, tab title). But **nothing ever sets it** — it's defined but unreachable from the backend.

### What this plan adds

When `step-finish reason:"stop"` fires (agent completed its turn), check the **last text content** of the response for question/blocker patterns. If found, escalate to `state: 'attention'` instead of just `substatus: 'awaiting-input'`.

| Agent response ends with... | Example | State set |
|---|---|---|
| A deliverable / summary | "Here's the plan. Summary: ..." | `substatus: 'awaiting-input'` (gentle pulse) |
| A question | "Should I proceed with option A or B?" | `state: 'attention'` (fast pulse, ⚠ badge) |
| A permission request | "Want me to push this to remote?" | `state: 'attention'` (fast pulse, ⚠ badge) |
| A "Need from you" block | "Need from you:\n- Which DB to use" | `state: 'attention'` (fast pulse, ⚠ badge) |

### Resetting attention

When the user sends a new prompt, `pollOpenCodeActivity()` already sets `state: 'active'` (status-server.js line 279-283), which clears any prior `attention` state. No extra code needed for the reset path.

## Files to Change

| File | What changes |
|---|---|
| `status-server.js` | Add `checkNeedsAttention()` function, modify `pollAgentSubstatus()` to call it on `step-finish reason:"stop"`, expand state guard to include `attention` |

**No changes to**: `agent-hub.html` (attention UI is already fully implemented), `package.json`, wrapper scripts.

## Tasks

### Task 1: Add `ATTENTION_PATTERNS` constant and `checkNeedsAttention()` function

Add these after the `broadcastSubstatusUpdate()` function (after line 331 in status-server.js):

```js
// Patterns that indicate the agent is asking a question or needs user input.
// Checked against the last ~1500 chars of the agent's response.
const ATTENTION_PATTERNS = [
  /\?\s*$/,                           // ends with a question mark
  /\bshould I\b.*\?\s*$/im,           // "Should I proceed?" ✓ — "what I should do next" ✗
  /\bwould you like\b/i,              // "Would you like me to..."
  /\bdo you want\b/i,                 // "Do you want me to..."
  /\bplease (confirm|clarify|let me know|provide|specify)\b/i,
  /\blet me know\b.*\?\s*$/im,        // "Let me know which one?" ✓ — "Let me know if it works." ✗
  /\bneed from you\b/i,               // "Need from you:" (AGENTS.md convention)
  /\bwhat do you think\b/i,
  /\bwhat would you prefer\b/i,
  /\bcan you (confirm|clarify|provide|specify)\b/i,
  /\bwaiting for\b.*\b(input|response|answer|decision|confirmation)\b/i,
  /\bhow would you like\b/i,
  /\bwhich (option|approach|one)\b.*\?\s*$/im,
];

function checkNeedsAttention(db, agent) {
  try {
    // Get the last text part from the agent's most recent assistant message
    const lastText = db.prepare(`
      SELECT json_extract(p.data, '$.text') as text
      FROM part p
      WHERE p.message_id = (
        SELECT m.id FROM message m
        WHERE json_extract(m.data, '$.agent') = ?
          AND json_extract(m.data, '$.role') = 'assistant'
        ORDER BY m.time_created DESC
        LIMIT 1
      )
      AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created DESC
      LIMIT 1
    `).get(agent);

    if (!lastText?.text) return false;

    // Check the tail of the response (questions are usually at the end)
    // 1500 chars provides headroom for AGENTS.md Summary/Validation/Risks trailing sections
    const tail = lastText.text.slice(-1500);
    const matched = ATTENTION_PATTERNS.find(pattern => pattern.test(tail));
    if (matched) {
      console.log(`[attention] ${agent}: matched ${matched} on: "${tail.slice(-80)}"`);
      return true;
    }
    return false;
  } catch (e) {
    // On error, don't escalate — default to awaiting-input
    return false;
  }
}
```

**Design notes:**
- Checks the last 1500 characters — questions/blockers are usually at the end, but AGENTS.md conventions add Summary/Validation/Risks sections (200–500 chars) after the real question, so 1500 provides comfortable headroom
- Reuses the same subquery pattern as `pollAgentSubstatus()` (leverages `part_message_idx`)
- Fails safe — on any error, returns `false` (agent shows `awaiting-input`, not `attention`)
- Pattern list is conservative and can be tuned over time
- Logs matched pattern + tail snippet to console for tuning visibility

### Task 2: Expand state guard in `pollAgentSubstatus()` to include `attention`

Currently (line 359-366), the function only processes agents with `state === 'active'`. If we set `state: 'attention'`, the next poll cycle would see `state !== 'active'` and clear the substatus. Fix:

Change line 360 from:
```js
      if (currentState !== 'active') {
```

To:
```js
      if (currentState !== 'active' && currentState !== 'attention') {
```

And add after line 366 (after the closing brace of the state guard block):
```js
      if (currentState === 'attention') continue;  // persists until user sends prompt
```

This ensures that once we set `attention`, the poller doesn't immediately undo it on the next cycle, and also avoids running the SQL query + pattern check every 2 seconds while attention is already set.

### Task 3: Modify `step-finish` case to call `checkNeedsAttention()`

In `pollAgentSubstatus()`, change the `step-finish` case (lines 387-393) from:

```js
        case 'step-finish':
          if (latestPart.reason === 'stop') {
            newSubstatus = 'awaiting-input';
          } else if (latestPart.reason === 'tool-calls') {
            newSubstatus = 'thinking';
          }
          break;
```

To:

```js
        case 'step-finish':
          if (latestPart.reason === 'stop') {
            // Only check for attention on transition (not every poll cycle)
            const prev = agentState?.agents?.[agent];
            if (prev?.substatus !== 'awaiting-input' && prev?.state !== 'attention') {
              if (checkNeedsAttention(opencodeDb, agent)) {
                updateAgentState(agent, { state: 'attention', substatus: 'awaiting-input', toolName: null, message: 'Waiting for your response' });
                broadcastSubstatusUpdate(agent);
                continue;
              }
            }
            newSubstatus = 'awaiting-input';
          } else if (latestPart.reason === 'tool-calls') {
            newSubstatus = 'thinking';
          }
          break;
```

**Key detail:** The `prev?.substatus !== 'awaiting-input' && prev?.state !== 'attention'` guard ensures `checkNeedsAttention()` only runs **once** per turn completion — not every 2 seconds while waiting. This avoids the extra text query on steady-state polls.

### Task 4: Test and verify

1. Start the server: `npm start`
2. Open the dashboard at `http://localhost:3747`
3. Start a planner session and send a prompt that will result in a question (e.g., "What should we build next?" — the agent will likely ask for clarification)
4. Verify:
   - While agent is working: card shows "Thinking..." / "Running: ..." / "Responding..." (normal active glow)
   - **When agent finishes with a question**: card switches to **fast pulse** (1s), badge shows "⚠ Attention", tab title shows `(⚠ 1) Agent Hub`
5. Send a follow-up prompt → card goes back to "Thinking..." (attention clears)
6. Send a prompt that results in a deliverable (no question) → card shows **slow pulse** (2.5s, awaiting-input), badge shows "⏳ Waiting"
7. Verify `GET /status` shows `state: 'attention'` for the questioning agent
8. Check header: should show "1 need attention" vs "1 awaiting input" correctly

## Risks / Open Questions

1. **False positives** — Some agent responses end with rhetorical questions or "How to validate:" sections that contain `?`. The pattern `/\?\s*$/` only matches a `?` at the very end of the text, which reduces false positives. Patterns like `should I` and `which option` are anchored to require a trailing `?` at end-of-line (`/im` flag), and `let me know` requires a trailing `?` — so polite sign-offs like "Let me know if it works." won't trigger. We can tune the pattern list after observing real behavior using the console logs.

2. **False negatives** — Novel question phrasing not covered by the patterns won't trigger attention. This is acceptable — the agent still shows as `awaiting-input` (slow pulse), which is visible. We can add patterns over time.

3. **Pattern tuning** — The `ATTENTION_PATTERNS` array should be treated as a living list. Matched patterns are logged to the console with the tail snippet (via `console.log`), making tuning easy — watch the output during real usage and adjust patterns as needed.

4. **Coder agent** — The coder (gh copilot) doesn't use opencode, so it will never get attention detection. Its wrapper script could be enhanced separately to post `attention` state, but that's out of scope for this plan.
