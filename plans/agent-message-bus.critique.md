# Critique: Agent Message Bus Plan

**Reviewer:** reviewer agent
**Date:** 2026-03-06
**Verdict:** Needs fixes before implementation (0 critical, 6 must-fix, 2 minor)

## Summary

Solid architecture — WAL mode, CLI-write/dashboard-read separation, and SQL parameterization are all correct. The plan accurately references current codebase line numbers and follows established patterns. However, there are 6 implementation-level issues that will cause bugs or confusion if the plan is followed as-written: dead CSS, a route-ordering code block that contradicts its own instructions, a flex layout break, an undocumented lifecycle shortcut, a missing server-side filter, and a reply routing limitation.

---

## Findings

### 🟡 Important: `.message-modal` CSS class is dead code (Task 8 / Task 10)

**Location:** Task 8 (CSS additions) and Task 10 (`renderMessageModal()`)

**Issue:** Task 8 defines `.message-modal { width: 600px; max-width: 95vw; max-height: 80vh; overflow-y: auto; }` but `renderMessageModal()` in Task 10 sets `innerHTML` on the existing `#modal` element without ever applying the `message-modal` class. The modal renders at whatever size the existing agent modal uses.

**Impact:** The modal won't have the intended sizing/scrolling behavior. The CSS is unused dead code.

**Fix:** In `renderMessageModal()`, add `modal.classList.add('message-modal')` before setting `innerHTML`, or apply the class to the inner wrapper div. Also ensure the class is removed when rendering non-message modals (e.g., in the existing agent detail modal flow).

---

### 🟡 Important: Route ordering code block contradicts the ordering note (Task 5)

**Location:** Task 5 (API routes)

**Issue:** The code block shows routes defined in this order: `/api/messages`, `/api/messages/counts`, `/api/messages/:id`, `/api/messages/thread/:threadId`. But the text note *after* the code block correctly warns that `counts` and `thread/:threadId` must come *before* `:id` to avoid Express matching `counts` and `thread` as an `:id` parameter. An implementer copying the code block verbatim will hit the Express route matching bug where `GET /api/messages/counts` matches `/api/messages/:id` with `id = "counts"`.

**Impact:** The `/api/messages/counts` and `/api/messages/thread/:threadId` endpoints will never be reached.

**Fix:** Reorder the code block itself to show the correct ordering:
1. `/api/messages/counts`
2. `/api/messages/thread/:threadId`
3. `/api/messages/:id`
4. `/api/messages`

The trailing note can remain as reinforcement but should not be the only place the correct order is stated.

---

### 🟡 Important: Agent card HTML wrapper changes flex layout (Task 7)

**Location:** Task 7 (agent card badge area modification)

**Issue:** The plan wraps the existing badge and a new envelope icon in a `<div style="display:flex;gap:6px;align-items:center;">` container. Currently, `.agent-badge` is a direct child of `.agent-header`, which uses `display: flex; justify-content: space-between;`. Adding a wrapper div changes the flex children from `[icon, badge]` to `[icon, wrapper-div]`. While this might still work, the `space-between` distribution changes because the wrapper div's intrinsic width differs from the badge alone.

**Impact:** Subtle visual misalignment of the agent card header — the badge+envelope group may not align the same way the badge alone did.

**Fix:** Test the visual result, or explicitly set the wrapper div to `margin-left: auto;` to replicate the `space-between` push-right behavior that the badge currently gets for free.

---

### 🟡 Important: Lifecycle diagram says `unread -> read -> addressed` but `address` allows skipping `read` (Task 1)

**Location:** Task 1 (data model / lifecycle documentation)

**Issue:** The lifecycle diagram shows a linear progression: `unread -> read -> addressed`. But the SQL in the `address` command uses `WHERE id = ? AND status IN ('unread', 'read')`, which permits the transition `unread -> addressed` directly, skipping `read`. This is actually convenient behavior (an agent can address a message without explicitly marking it read first), but it contradicts the documented lifecycle.

**Impact:** Confusion for implementers/maintainers who trust the diagram over the SQL. Could also affect client-side filtering logic if it assumes messages always pass through `read` state.

**Fix:** Update the lifecycle diagram to show both paths:
```
unread -> read -> addressed
unread -> addressed (direct)
```
Add a note explaining that `address` implicitly handles unread messages.

---

### 🟡 Important: No `severity` filter parameter in `getMessages()` API (Task 4 / Task 10)

**Location:** Task 4 (API) and Task 10 (dashboard JS — "Blocking" filter button)

**Issue:** The "Blocking" filter button in the dashboard fetches all unread messages from the server via `getMessages()` and then filters client-side for `severity === 'blocking'`. There is no `severity` query parameter in the API endpoint.

**Impact:** Unnecessary data transfer — all messages are fetched just to display blocking ones. This is fine for small volumes but won't scale if message volume grows.

**Fix:** Add an optional `severity` query parameter to `GET /api/messages` and apply it in the SQL `WHERE` clause. The client-side filter can remain as a fallback but should use the server-side filter when available.

---

### 🟡 Important: Reply routing limits multi-party threads (Task 1)

**Location:** Task 1 (`msg reply` CLI command)

**Issue:** `msg reply` auto-routes the reply to `parent.from_agent`. There is no `--to` flag on the reply command, so a third agent cannot be addressed in an existing thread. Example: if reviewer replies to coder's message in a planner->coder thread, the reply goes to coder (the `from_agent` of the parent), not to planner (the thread originator).

**Impact:** Multi-agent conversations are limited to back-and-forth between two agents. A reviewer wanting to escalate to planner within the same thread cannot do so.

**Fix:** Either add an optional `--to <agent>` flag on `msg reply` that overrides the auto-routing, or document this as a known limitation with the workaround of starting a new thread to the desired agent.

---

### 🟢 Minor: Double-fetch of counts on page load (Task 6 / Task 11)

**Location:** Task 6 (SSE init delivers `messageCounts`) and Task 11 (`pollMessages()` runs immediately in init section)

**Issue:** SSE initialization delivers a `messageCounts` event, and `pollMessages()` also runs immediately during init, which fetches `GET /api/messages/counts`. This results in two identical requests on page load.

**Fix:** Either skip the SSE `messageCounts` on initial connection, or delay the first `pollMessages()` call to the next interval tick.

---

### 🟢 Minor: `SKILL.md` uses `{AGENT_NAME}` placeholder ambiguously (Task 12)

**Location:** Task 12 (SKILL.md for message bus skill)

**Issue:** The skill file says "Replace `{AGENT_NAME}` with your role" but if loaded from a shared `~/.claude/skills/` location, the same file serves all agents. Each agent would need to infer their name from their system prompt context, which works in practice but could confuse a new agent setup.

**Fix:** Add a note explaining that agents should derive their name from their role in the system prompt (e.g., "reviewer", "planner"), or make the skill dynamically detect the agent name.

---

## What Looks Good

- **SQL parameterization** — All queries use `?` placeholders; no injection risk.
- **WAL mode + read/write separation** — CLI writes, dashboard reads. WAL mode handles concurrent access correctly. This follows the existing `opencodeDb`/`learningsDb`/`qmdDb` pattern.
- **Line references are accurate** — All references to `status-server.js` line numbers were verified against the current 1,281-line file.
- **`escapeHtml()` usage** — Correctly applied in `onclick` handlers, following existing codebase patterns.
- **`VALID_AGENTS` at module scope** — Defined at line 21, accessible inside the `createApp()` closure. Correct.
- **Thread model** — Simple `thread_id` foreign key with `GROUP BY` for thread views is clean and sufficient.
- **SSE broadcast pattern** — Follows the existing `broadcast()` function pattern for real-time updates.

## Verdict

- [ ] Ready to merge
- [x] Needs fixes (6 important findings must be addressed in the plan before implementation)
- [ ] Needs redesign

**Must-fix before implementation:**
1. Apply `.message-modal` CSS class in `renderMessageModal()`
2. Reorder route code block to match the ordering note
3. Test or fix agent card flex layout with wrapper div
4. Update lifecycle diagram to show direct `unread -> addressed` path
5. Add `severity` query parameter to the API
6. Add `--to` flag on `msg reply` or document the limitation
