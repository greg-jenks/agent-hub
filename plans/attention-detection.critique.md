# Critique: Attention Detection

> Review of `attention-detection.md` — performed 2026-03-01
> Reviewer: reviewer agent
> Verdict: **Needs fixes** (no redesign required)

## Summary

Clean, well-scoped plan — single file change, accurate line references, solid guard logic. The "no frontend changes needed" claim is verified correct. However, the pattern list has **false-positive issues** that will cause alert fatigue, the **scan window is too small** for agents that follow AGENTS.md output conventions, and there are minor polish items.

---

## Findings

### 🟡 Important: `let me know` pattern will false-positive on polite sign-offs

- **Location:** Task 1, `ATTENTION_PATTERNS[5]` — `/\blet me know\b/i`
- **Issue:** Matches the extremely common non-blocking sign-off: *"Let me know if you have any questions"*, *"Let me know if you'd like any changes."* These are polite closings after a **completed deliverable** — the user doesn't need to respond.
- **Impact:** The fast-pulsing card + ⚠ badge + tab title change is a strong interrupt signal. Firing on every completed deliverable with "let me know" will train users to ignore it (alert fatigue).
- **Fix:** Either remove the pattern, or narrow it to require a trailing question mark:
  ```js
  /\blet me know\b.*\?\s*$/i,   // "Let me know which one?" ✓ — "Let me know if it works." ✗
  ```

---

### 🟡 Important: Several patterns match narrative context, not just direct questions

- **Location:** Task 1, `ATTENTION_PATTERNS` — `/\bshould I\b/i`, `/\bwhich (option|approach|one)\b/i`, etc.
- **Issue:** These patterns scan **anywhere** in the last 500 characters. Agent responses can contain narrative references: *"I considered which option was best and chose A"*, *"Here's what I should implement next."* These match even though the agent isn't asking anything.
- **Impact:** Moderate false positive rate, especially in Risks/Notes sections.
- **Fix:** Anchor the strongest patterns to require a `?` at end of line or text:
  ```js
  /\bshould I\b.*\?\s*$/im,
  /\bwhich (option|approach|one)\b.*\?\s*$/im,
  ```

---

### 🟡 Important: 500-char window may miss real questions above Summary/Validation/Risks

- **Location:** Task 1, `checkNeedsAttention()` — `lastText.text.slice(-500)`
- **Issue:** Both AGENTS.md files instruct agents to end every response with `### Summary`, `### Validation`, `### Risks / Notes`. A typical structured response:
  ```
  Should I proceed with option A or B?     ← real question (>500 chars from end)

  ### Summary
  - Analyzed both options
  ### Validation
  Run `npm test`
  ### Risks / Notes
  None.
  ```
  If the trailing sections total >500 characters, the actual question falls outside the scan window.
- **Impact:** False negatives on well-structured agent responses — the exact responses that matter most.
- **Fix:** Increase the window to 1500 characters. Summary/Validation/Risks sections are typically 200–500 chars total, so 1500 provides comfortable headroom without scanning irrelevant content.

---

### 🟢 Minor: Redundant SQL query every poll while in attention state

- **Location:** Task 2, the state guard expansion
- **Issue:** After Task 2, agents in `attention` state still run through `pollAgentSubstatus()` every 2 seconds — executing the SQL query, entering step-finish, hitting the guard, setting the same substatus, comparing (no-op). All for zero benefit.
- **Fix:** Short-circuit after the guard:
  ```js
  if (currentState !== 'active' && currentState !== 'attention') {
    // ... clear substatus ...
    continue;
  }
  if (currentState === 'attention') continue;  // persists until user sends prompt
  ```

---

### 🟢 Minor: No development logging for pattern tuning

- **Location:** Task 1, `checkNeedsAttention()`; Risk #3
- **Issue:** Risk #3 correctly suggests logging matches during development, but the implementation doesn't include it. Without logging, tuning the pattern list is manual guesswork.
- **Fix:** Return the matched pattern and log it:
  ```js
  const matched = ATTENTION_PATTERNS.find(pattern => pattern.test(tail));
  if (matched) {
    console.log(`[attention] ${agent}: matched ${matched} on: "${tail.slice(-80)}"`);
    return true;
  }
  return false;
  ```

---

### 🟢 Minor: `message` field not updated on attention transition

- **Location:** Task 3, the `updateAgentState` call
- **Issue:** Sets `{ state: 'attention', substatus: 'awaiting-input', toolName: null }` but leaves `message` unchanged. The card shows "Needs Attention" in the state label but "Responded" underneath (carried over from `pollOpenCodeActivity`).
- **Fix:** Set a descriptive message:
  ```js
  updateAgentState(agent, {
    state: 'attention', substatus: 'awaiting-input',
    toolName: null, message: 'Waiting for your response'
  });
  ```

---

## What Looks Good

- **Line references are all accurate** — verified against `status-server.js` (578 lines). Lines 331, 360, 387-393 all match.
- **Transition guard logic is correct** — traced through: fresh turn, attention already set, user sends new prompt, server restart. All paths hold. The `continue` correctly short-circuits the for-loop iteration.
- **Frontend claim verified** — `updateCards()` renders attention state correctly (fast pulse, ⚠ badge, tab title). Substatus rendering is gated on `state === 'active'`, so no conflict. Count logic (lines 1294-1299) correctly separates attention/awaiting/active.
- **Reset path is correct** — user prompt sets `state: 'active'` (line 279-283), clearing attention with no extra code.
- **Fail-safe design** — errors return `false`, defaulting to `awaiting-input` instead of false alerting.

---

## Required Fixes

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 1 | `let me know` pattern too broad — false positives on sign-offs | 🟡 Important | Narrow regex or remove |
| 2 | Patterns match narrative context, not just direct questions | 🟡 Important | Anchor patterns to line/text end with `?` |
| 3 | 500-char window too small for AGENTS.md conventions | 🟡 Important | Change `500` → `1500` |
| 4 | Skip SQL query when already in attention state | 🟢 Minor | Add one `continue` |
| 5 | Add console logging for pattern tuning | 🟢 Minor | 2 lines |
| 6 | Set `message` field on attention transition | 🟢 Minor | Add one field |
