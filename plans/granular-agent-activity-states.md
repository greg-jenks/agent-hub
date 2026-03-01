# Plan: Granular Agent Activity States

## Goal

Show whether each opencode agent is **actively working**, **waiting for user input**, or **idle/between sessions** — derived from the opencode DB `part` table which records step-start, step-finish, tool execution, text output, and reasoning events in real time.

## Background

### Current Problem

Today, `pollOpenCodeActivity()` (status-server.js lines 239–317) only reads the `message` table. It sets every agent to `state: 'active'` on both user prompts AND assistant responses, making it impossible to distinguish:

- Agent is **thinking / running tools** (user sent prompt, agent is working)
- Agent is **done and waiting** for the user's next prompt
- Agent is **idle** — no session running

The dashboard shows "In Session" with a pulsing dot for all three cases once a session has started.

### What the opencode DB gives us

The `part` table (joined to `message` via `message_id`) records granular sub-message events:

| Part `type` | Meaning | Key fields |
|---|---|---|
| `step-start` | LLM generation begins | — |
| `step-finish` | LLM generation ends | `reason`: `"stop"` (turn done) or `"tool-calls"` (continuing) |
| `tool` | Tool invocation | `tool`: tool name, `state.status`: `"running"` / `"completed"` / `"error"` |
| `text` | Text output streaming | `text`: content string |
| `reasoning` | Extended thinking | `text`: reasoning content |

A typical turn looks like:

```
user message (message table)
  → step-start                        ← agent is thinking
  → reasoning (optional)              ← agent is thinking
  → text                              ← agent is responding
  → step-finish reason:"tool-calls"   ← agent needs to run tools
  → step-start                        ← tool results processed, thinking again
  → tool state.status:"running"       ← agent is using a tool
  → tool state.status:"completed"     ← tool finished
  → step-finish reason:"tool-calls"   ← more tools needed
  → step-start
  → text
  → step-finish reason:"stop"         ← DONE — agent is waiting for next prompt
```

### New substatus model

The existing `state` field (`idle`, `active`, `attention`, `done`, `error`) stays unchanged — it represents the session lifecycle. We add a new `substatus` field that represents what the agent is doing *right now* within an active session:

| `substatus` | Detection | Dashboard display |
|---|---|---|
| `null` | Agent is not `active`, or no part data yet | (not shown — state label used instead) |
| `thinking` | Latest part is `step-start` or `reasoning` with no subsequent `step-finish` | "Thinking..." with brain animation |
| `tool` | Latest `tool` part has `state.status === "running"` or `"pending"` | "Running: {toolName}" with gear animation |
| `responding` | Latest part is `text` (streaming output, no `step-finish` yet) | "Responding..." with typing dots |
| `awaiting-input` | `step-finish reason:"stop"` AND response does NOT contain question/blocker patterns | "Awaiting input" with soft glow |

Additionally, when `step-finish reason:"stop"` fires and the response **does** contain question/blocker patterns (e.g., ends with `?`, contains "Should I", "Need from you", etc.), the agent escalates to `state: 'attention'` with `substatus: 'awaiting-input'`. This triggers the existing `attention` UI treatment (fast pulse, ⚠ badge, tab title).

This means:
- **Working** = substatus is `thinking`, `tool`, or `responding`
- **Needs you** = state is `attention` (agent asked a question or needs permission — **urgent**)
- **Your turn** = substatus is `awaiting-input` without `attention` (agent delivered a result — **no rush**)
- **Idle** = state is `idle` or `done` (no active session)

## Files to Change

| File | What changes |
|---|---|
| `status-server.js` | Add `pollAgentSubstatus()` + `checkNeedsAttention()` functions that query the `part` table, derive substatus from part types, escalate to `attention` state when agent asks a question, add `substatus` + `toolName` to agent state, include in SSE broadcasts and status snapshot |
| `agent-hub.html` | Add CSS for new substatus visual states (thinking animation, tool gear, responding dots, awaiting glow), update `updateCards()` to render substatus when present, update `STATE_LABELS`/`BADGE_LABELS` |

**No changes to**: `package.json`, wrapper scripts, agent definitions, opencode config.

## Tasks

### ~~Task 1: REMOVED~~ (was `lastSeenPartTimestamps` — dead code, never consumed by Task 2)

### Task 2: Add `pollAgentSubstatus()` function in `status-server.js`

Add a new function after `pollOpenCodeActivity()` (after line 317). This function is called on every poll cycle but is lightweight — it only reads the **single most recent part** per agent to determine current substatus:

```js
function pollAgentSubstatus() {
  if (!opencodeDb) return;

  try {
    for (const agent of OPENCODE_AGENTS) {
      // Get the most recent part for this agent's latest assistant message.
      // Uses a subquery to find the message first (leverages part_message_idx),
      // avoiding a full table scan of all 41K+ parts.
      const latestPart = opencodeDb.prepare(`
        SELECT
          json_extract(p.data, '$.type') as partType,
          json_extract(p.data, '$.tool') as toolName,
          json_extract(p.data, '$.state.status') as toolStatus,
          json_extract(p.data, '$.reason') as reason,
          p.time_created
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
      `).get(agent);

      if (!latestPart) continue;

      // Only update if the agent is in an active session
      // (includes 'attention' — set by us when agent asks a question)
      const currentState = agentState?.agents?.[agent]?.state;
      if (currentState !== 'active' && currentState !== 'attention') {
        // Clear substatus when not in session
        if (agentState?.agents?.[agent]?.substatus) {
          updateAgentState(agent, { substatus: null, toolName: null });
          broadcastSubstatusUpdate(agent);
        }
        continue;
      }

      let newSubstatus = null;
      let newToolName = null;

      switch (latestPart.partType) {
        case 'step-start':
        case 'reasoning':
          newSubstatus = 'thinking';
          break;

        case 'tool':
          if (latestPart.toolStatus === 'running' || latestPart.toolStatus === 'pending') {
            newSubstatus = 'tool';
            newToolName = latestPart.toolName || 'unknown';
          } else {
            // Tool completed — agent is thinking about the result
            newSubstatus = 'thinking';
          }
          break;

        case 'text':
          newSubstatus = 'responding';
          break;

        case 'step-finish':
          if (latestPart.reason === 'stop') {
            // Agent finished its turn — check if it's asking a question
            // Only do the text check when transitioning TO this state (not every poll)
            if (prev?.substatus !== 'awaiting-input' && prev?.state !== 'attention') {
              const needsAttention = checkNeedsAttention(opencodeDb, agent);
              if (needsAttention) {
                // Escalate to attention STATE (not just substatus)
                updateAgentState(agent, { state: 'attention', substatus: 'awaiting-input', toolName: null });
                broadcastSubstatusUpdate(agent);
                continue;
              }
            }
            newSubstatus = 'awaiting-input';
          } else if (latestPart.reason === 'tool-calls') {
            // Between steps, tools about to execute
            newSubstatus = 'thinking';
          }
          break;

        default:
          // compaction or unknown — skip update, preserve current substatus
          continue;
      }

      // Only broadcast if substatus actually changed
      const prev = agentState?.agents?.[agent];
      if (prev && (prev.substatus !== newSubstatus || prev.toolName !== newToolName)) {
        updateAgentState(agent, { substatus: newSubstatus, toolName: newToolName });
        broadcastSubstatusUpdate(agent);
      }
    }
  } catch (e) {
    if (e.message && !e.message.includes('SQLITE_BUSY')) {
      console.warn('[substatus-poll] Error:', e.message);
    }
  }
}

function broadcastSubstatusUpdate(agent) {
  broadcastSSE({
    type: 'agent-update',
    agent,
    data: {
      ...agentState.agents[agent],
      recentActivity: activityBuffers[agent].slice(0, 3)
    }
  });
}
```

### Task 2b: Add `checkNeedsAttention()` — detect when agent is asking a question

This is the function that decides whether an agent's completed turn should escalate to `attention` (needs user NOW) vs `awaiting-input` (your turn, no rush). It checks the last text content from the agent's response for question/blocker patterns.

Add this function alongside `pollAgentSubstatus()`:

```js
// Patterns that indicate the agent is asking a question or needs user input.
// Checked against the last ~500 chars of the agent's response.
const ATTENTION_PATTERNS = [
  /\?\s*$/,                           // ends with a question mark
  /\bshould I\b/i,                    // "Should I proceed?"
  /\bwould you like\b/i,              // "Would you like me to..."
  /\bdo you want\b/i,                 // "Do you want me to..."
  /\bplease (confirm|clarify|let me know|provide|specify)\b/i,
  /\blet me know\b/i,                 // "Let me know if..."
  /\bneed from you\b/i,               // "Need from you:" (AGENTS.md convention)
  /\bwhat do you think\b/i,
  /\bwhat would you prefer\b/i,
  /\bcan you (confirm|clarify|provide|specify)\b/i,
  /\bwaiting for\b.*\b(input|response|answer|decision|confirmation)\b/i,
  /\bhow would you like\b/i,
  /\bwhich (option|approach|one)\b/i,
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
    const tail = lastText.text.slice(-500);
    return ATTENTION_PATTERNS.some(pattern => pattern.test(tail));
  } catch (e) {
    // On error, don't escalate — default to awaiting-input
    return false;
  }
}
```

**Design notes:**
- Only checks the last 500 characters — questions/blockers are almost always at the end of a response
- Only runs once per turn completion (guarded by `prev?.substatus !== 'awaiting-input'` in the caller)
- Fails safe — on any error, returns `false` (agent shows as `awaiting-input`, not `attention`)
- The pattern list can be tuned over time. Start conservative; it's easy to add patterns later.
- When `attention` is set, the existing frontend CSS/JS handles it fully (fast pulse, ⚠ badge, tab title)

**Resetting attention:** When the user sends a new prompt, `pollOpenCodeActivity()` sets `state: 'active'` (line 280), which clears the `attention` state automatically. No extra code needed.

### Task 3: Wire `pollAgentSubstatus()` into the poll interval

In the server startup block (around line 460, inside the `if (opencodeDb)` block), add `pollAgentSubstatus` to the existing `setInterval`:

**Option A — Same interval (preferred):** Call `pollAgentSubstatus()` at the end of `pollOpenCodeActivity()`, right before the closing `catch` (after line 311). This way both polls share the same 2s interval and the substatus always reflects the latest message state.

Add this line at line 311 (after the `for (const agent of OPENCODE_AGENTS)` loop closes, before the `catch`):

```js
    // After processing new messages, update substatus from part table
    pollAgentSubstatus();
```

### Task 4: Include `substatus` and `toolName` in status snapshot

In `buildStatusSnapshot()` (lines 163–181), the function already copies `recentActivity` onto each agent. The `substatus` and `toolName` fields are already part of `agentState.agents[agent]` (set by `updateAgentState`), so they'll be included automatically via the `JSON.parse(JSON.stringify(getState()))` deep copy on line 164.

**No code change needed for this task** — just verify during testing that `GET /status` includes `substatus` and `toolName` on active agents.

### Task 5: Clear substatus on lifecycle transitions

In the `POST /status` handler (lines 361–398), when a wrapper script posts `done` or `idle`, clear the substatus. Instead of a separate `updateAgentState` call, merge the substatus clearing into the existing state update. Replace the existing `updateAgentState(agent, { state, message: message || '' })` call with:

```js
  const updates = { state, message: message || '' };
  // Clear substatus on lifecycle transitions (only meaningful during active sessions)
  if (state !== 'active') {
    updates.substatus = null;
    updates.toolName = null;
  }
  updateAgentState(agent, updates);
```

### Task 6: Add CSS for substatus visual states in `agent-hub.html`

There are two layers of visual changes:

**6a. Dot-level animations** — After the existing `.status-dot` rules (lines 376–391), add substatus-specific dot styles:

```css
/* Substatus dot overrides (when agent is active with known substatus) */
.status-dot.thinking {
  animation: thinkingPulse 1s infinite;
}
.status-dot.tool {
  animation: toolSpin 1.5s linear infinite;
  border-radius: 2px;  /* square-ish while "running" */
}
.status-dot.responding {
  animation: pulse 0.8s infinite;
}
.status-dot.awaiting-input {
  animation: awaitDotPulse 2s ease-in-out infinite;
}

@keyframes thinkingPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.2); }
}
@keyframes toolSpin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
@keyframes awaitDotPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.4); }
}
```

**6b. Card-level "awaiting-input" treatment** — This is the key visual standout. After the existing `.agent-card.state-attention` rules (lines 226–233), add a new card-level class that makes the entire card visually distinct when the agent is waiting for the user. This mirrors the `state-attention` pattern but with a slower, gentler pulse to communicate "I'm ready for you" rather than "urgent":

```css
/* Awaiting input — card visually stands out so user knows this agent needs them */
.agent-card.substatus-awaiting-input {
  border-color: var(--agent-color);
  animation: awaitingPulse 2.5s ease-in-out infinite;
}
@keyframes awaitingPulse {
  0%, 100% {
    box-shadow: 0 0 0 1px var(--agent-dim), inset 0 0 30px var(--agent-glow);
  }
  50% {
    box-shadow: 0 0 10px 2px var(--agent-dim), inset 0 0 40px var(--agent-glow);
  }
}

/* Awaiting badge gets a highlighted background */
.agent-card.substatus-awaiting-input .agent-badge {
  background: var(--agent-dim);
  border-color: var(--agent-color);
}
```

Design rationale:
- `state-attention` pulses fast (1s) and glows big (15px) → **urgent/alarming**
- `substatus-awaiting-input` pulses slow (2.5s) and glows moderate (10px) → **"your turn, no rush"**
- The badge gets a more opaque background so it catches the eye in the card grid
- Working substatuses (`thinking`, `tool`, `responding`) keep the normal `state-active` card treatment (lit border + inner glow, no pulsing) — the dot animation is sufficient to show "agent is busy"

**6c. Substatus label style** — for the state text when substatus overrides it:

```css
.substatus-label {
  font-size: 10px;
  color: var(--agent-color);
  opacity: 0.8;
  font-family: 'Share Tech Mono', monospace;
  letter-spacing: 0.05em;
}
```

### Task 7: Add substatus labels and rendering logic in `agent-hub.html`

**7a. Add SUBSTATUS_LABELS constant** after the existing `BADGE_LABELS` (line 1041):

```js
const SUBSTATUS_LABELS = {
  'thinking': 'Thinking...',
  'tool': 'Running tool',        // will be overridden with tool name
  'responding': 'Responding...',
  'awaiting-input': 'Awaiting input'
};
const SUBSTATUS_BADGE = {
  'thinking': '🧠 Thinking',
  'tool': '⚙️ Tool',
  'responding': '💬 Responding',
  'awaiting-input': '⏳ Waiting'
};
```

**7b. Update `updateCards()` to render substatus and card-level visual treatment.** In the function body (starting at line 1134), after the badge update (line 1161: `badge.textContent = BADGE_LABELS[state] || state;`), add substatus rendering AND card class management:

```js
      // Substatus rendering (overrides generic "active" display when substatus is known)
      const substatus = info.substatus;

      // Remove any previous substatus card classes
      card.className = card.className.replace(/substatus-[\w-]+/g, '').trim();

      if (state === 'active' && substatus) {
        // Override dot class to use substatus animation
        dot.className = 'status-dot ' + substatus;

        // Override state label with substatus detail
        let label = SUBSTATUS_LABELS[substatus] || substatus;
        if (substatus === 'tool' && info.toolName) {
          label = `Running: ${info.toolName}`;
        }
        stateEl.textContent = label;
        stateEl.classList.add('substatus-label');

        // Override badge
        let badgeLabel = SUBSTATUS_BADGE[substatus] || substatus;
        if (substatus === 'tool' && info.toolName) {
          badgeLabel = `⚙️ ${info.toolName}`;
        }
        badge.textContent = badgeLabel;

        // Card-level visual: awaiting-input gets the pulsing card treatment
        if (substatus === 'awaiting-input') {
          card.classList.add('substatus-awaiting-input');
          awaitingCount++;
        }
      } else {
        stateEl.classList.remove('substatus-label');
      }
```

**7c. Add `awaitingCount` tracking and fix counting to avoid double-counting.** The `awaiting-input` state should surface in the header bar and browser tab so the user knows an agent needs them even when glancing at the tab.

**Important:** The existing code increments `activeCount` for all `state === 'active'` agents. An awaiting agent is technically `active` but should NOT count toward `activeCount` — otherwise the header shows "1 awaiting input, **2** active" when only 2 agents are involved. Fix this by making the counting mutually exclusive.

At the top of `updateCards()` (line 1136, next to the existing counters), add:

```js
    let awaitingCount = 0;
```

Then modify the existing `activeCount` increment (around line 1202) to exclude awaiting agents:

```js
    // Replace the existing: if (state === 'active') activeCount++;
    // With mutually exclusive counting:
    if (state === 'active' && substatus === 'awaiting-input') {
      awaitingCount++;
    } else if (state === 'active') {
      activeCount++;
    }
```

Note: `substatus` must be available at this point — it's read from `info.substatus` earlier in the same loop iteration (Task 7b).

Then update the header count section (lines 1206–1211) to include awaiting:

```js
    // Update header count
    const parts = [];
    if (attentionCount > 0) parts.push(`${attentionCount} need attention`);
    if (awaitingCount > 0) parts.push(`${awaitingCount} awaiting input`);
    if (activeCount > 0) parts.push(`${activeCount} active`);
    document.getElementById('agentCount').textContent =
      parts.length > 0 ? parts.join(', ') : '4 agents configured';
```

And update the tab title section (lines 1213–1220) to show awaiting in the tab:

```js
    // Update tab title
    if (attentionCount > 0) {
      document.title = `(⚠ ${attentionCount}) Agent Hub`;
    } else if (awaitingCount > 0) {
      document.title = `(⏳ ${awaitingCount}) Agent Hub`;
    } else if (activeCount > 0) {
      document.title = `(${activeCount}) Agent Hub`;
    } else {
      document.title = 'Agent Hub';
    }
```

This means at a glance the user can see:
- Tab shows `(⏳ 2) Agent Hub` → two agents are waiting for you
- Header shows "2 awaiting input, 1 active" → two done, one still working
- The awaiting cards pulse gently with their agent color

### Task 8: Test and verify

1. Start the server: `npm start` (in agent-hub directory)
2. Open `http://localhost:3747` in a browser
3. Start a planner session: `planner` (from PS profile)
4. Send a prompt to the planner and observe the dashboard:
   - **Within ~2s of sending prompt**: dot shows "Thinking..." animation, card has normal active glow
   - **When running a tool**: dot shows "Running: bash" (or whatever tool), card has normal active glow
   - **When text is streaming**: dot shows "Responding...", card has normal active glow
   - **After response completes**: **card starts pulsing** with agent color, badge says "⏳ Waiting", dot glows, tab title shows `(⏳ 1) Agent Hub`
5. Send another prompt → card stops pulsing, goes back to "Thinking..."
6. End the session (Ctrl+C) → card goes back to "Done" (no substatus, no pulse)
7. Verify `GET /status` response includes `substatus` and `toolName` fields for active agents
8. Check with two agents running — header should show e.g., "1 awaiting input, 1 active"

## Visual hierarchy (for reference)

The card-level treatments form a clear hierarchy from most to least urgent:

| Priority | State | Card treatment | Tab badge |
|---|---|---|---|
| 1 (urgent) | `attention` | Fast pulse (1s), big glow (15px) | `(⚠ N)` |
| 2 (your turn) | `awaiting-input` | Slow pulse (2.5s), moderate glow (10px) | `(⏳ N)` |
| 3 (busy) | `active` (thinking/tool/responding) | Static glow, no pulse (dot animates instead) | `(N)` |
| 4 (nothing) | `idle` / `done` | No glow, dim | — |

## Data flow summary

```
Every 2 seconds:
  pollOpenCodeActivity()
    → reads message table for new user/assistant messages
    → updates state, feed, activity buffers
    → if new user prompt → sets state: 'active' (clears any prior 'attention')
    → broadcasts SSE agent-update events

    pollAgentSubstatus()  (called at end of pollOpenCodeActivity)
      → reads latest part per active/attention agent
      → derives substatus from part type
      → on step-finish reason:"stop":
          → checkNeedsAttention() reads last text part
          → if question/blocker patterns found → state: 'attention'
          → else → substatus: 'awaiting-input'
      → if substatus changed, broadcasts SSE agent-update

Dashboard (agent-hub.html):
  SSE agent-update event received
    → updateCards() called
    → if state=attention:
        existing attention treatment (fast pulse, ⚠ badge)
    → if state=active AND substatus present:
        override dot animation + label + badge with substatus-specific display
    → else:
        use existing state display (idle/done/error)
```

## Risks / Open Questions

1. **Coder agent (gh copilot) has no part data** — it doesn't use opencode, so it will never get substatus. This is expected and fine; it continues to use the simple lifecycle states from its wrapper script.

2. **SQLite contention** — We're adding one more query per poll cycle per agent. The query uses a subquery to find the latest message first, then looks up parts by `message_id` (leveraging the `part_message_idx` index). This avoids scanning all 41K+ parts. The DB is opened `readonly`, so contention should be negligible.

3. **Rapid state flicker** — Between `step-finish reason:tool-calls` and the next `step-start`, there's a brief moment. At 2s polling, we might miss intermediate states or briefly show "thinking" between tool calls. This is acceptable — the user sees the agent is actively working.

4. ~~**Part table index**~~ — Resolved. The query was restructured to use the existing `part_message_idx` index via a subquery, so no full table scan occurs.

5. **No substatus persistence** — Substatus is ephemeral (in-memory only, not written to status.json). On server restart, substatus starts as `null` and gets populated within 2s from the DB. This is intentional — substatus is a "live" indicator, not historical state.

6. **Brief substatus gap on new prompt** — When a user sends a new prompt, `pollOpenCodeActivity` sets `state: 'active'` immediately. But the assistant's first `step-start` part may not be written yet. For up to 2 seconds, substatus could briefly show "Awaiting input" from the previous turn's `step-finish reason:"stop"`. The next poll cycle corrects this. Acceptable — not worth adding complexity to fix.

---

## Revision History

### Rev 2 (2026-03-01) — Post-critique fixes

Addressed all findings from `granular-agent-activity-states.critique.md`:

| # | Fix | What changed |
|---|-----|-------------|
| 1 | 🔴 Switch default bug | Added `continue` in `default` case so unknown part types preserve current substatus instead of clearing it |
| 2 | 🟡 Query performance | Restructured SQL to use subquery (find latest message → get its parts) leveraging `part_message_idx` index. Eliminates 41K-row full table scan. |
| 3 | 🟡 Double-counting | Made `awaitingCount` and `activeCount` mutually exclusive in Task 7c |
| 4 | 🟡 Dead code | Removed Task 1 (`lastSeenPartTimestamps` was never consumed) |
| 5 | 🟡 Missing `pending` status | Added `pending` alongside `running` in the tool status check |
| 6 | 🟢 Merge updateAgentState | Task 5 now merges substatus clearing into the existing state update call |
| 7 | 🟢 SQL simplification | Changed `json_extract(p.data, '$.state')` + JS parse to `json_extract(p.data, '$.state.status')` directly |
| 8 | 🟢 Substatus gap | Documented as Risk #6 (accepted, not worth fixing) |
