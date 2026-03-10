# Review: Agent Message Bus Implementation

**Reviewer:** reviewer agent
**Date:** 2026-03-06
**Verdict:** Needs fixes (2 must-fix, 1 should-fix, 3 minor)

## Summary

Well-implemented feature that correctly addresses 4 of 6 findings from the earlier plan critique. All 31 existing tests pass with no regressions. Server reads a `messages.db` (SQLite, read-only), exposes 4 API endpoints, broadcasts count changes via SSE, and renders a filterable message list panel with detail modals on the frontend. **Two bugs to fix** (test fragility and missing coverage), one security hardening item, plus minor polish.

---

## Findings

### 🟡 Important: `createTestApp` doesn't explicitly pass `messagesDb: null` — tests could hit real DB

**Location:** `tests/helpers/create-app.js`

**Issue:** The test helper passes `opencodeDb: null` and `learningsDb: null` but does NOT pass `messagesDb: null`. Since `createApp()` uses `hasOwnProperty` to detect explicit configuration, tests fall through to the real `MESSAGES_DB_PATH` file open attempt. Currently safe because `fileMustExist: true` throws when the file doesn't exist and the catch swallows it, but if someone creates a `~/.agent/messages.db` on their dev machine, tests will silently connect to production data.

**Fix:** Add `messagesDb: null` to the defaults in `createTestApp()`:

```js
const defaults = {
  opencodeDb: null,
  learningsDb: null,
  messagesDb: null,  // <-- add this
  statusFile: path.join(tmpDir, 'status.json'),
  feedFile: path.join(tmpDir, 'feed.json'),
  skipPolling: true,
  skipFlush: true
};
```

---

### 🟡 Important: No test coverage for 4 new API endpoints

**Location:** `tests/api.test.js`, `tests/sse.test.js`

**Issue:** The new endpoints (`/api/messages`, `/api/messages/counts`, `/api/messages/:id`, `/api/messages/thread/:threadId`) and the SSE `message-counts` event type have zero test coverage. The existing SSE init test (`sse.test.js:25-28`) doesn't check for the new `messageCounts` property.

**Impact:** Regressions to these endpoints won't be caught by CI.

**Fix:** Add tests covering:
1. `/api/messages/counts` returns expected shape with null DB
2. `/api/messages/counts` with a fixture messages DB returns correct counts
3. `/api/messages` with filters returns filtered results
4. `/api/messages/:id` returns 404 for missing message
5. SSE init event includes `messageCounts`

Add a `createMessagesDb()` fixture helper in `tests/helpers/db-fixtures.js` similar to the existing `createLearningsDb()`.

---

### 🟡 Important: `escapeHtml()` doesn't escape single quotes — XSS risk in onclick handlers

**Location:** `agent-hub.html` — `renderMessages()` function

**Issue:** `escapeHtml()` (line 2121) uses `div.textContent = text; return div.innerHTML` which escapes `<`, `>`, `&`, `"` but **not** single quotes (`'`). The `msg.id` is placed inside single-quoted string delimiters in an onclick attribute:

```html
onclick="openMessageModal('${escapeHtml(msg.id || '')}')"
```

If a message ID contains a `'`, it breaks out of the JS string, enabling script injection.

**Realistic risk:** Low — message IDs are likely UUIDs. But as a defense-in-depth concern for a pattern that might be copied elsewhere, it should be fixed.

**Fix:** Either:
- (a) Escape single quotes in the ID: `escapeHtml(msg.id || '').replace(/'/g, '&#39;')`
- (b) Use a `data-id` attribute + event delegation instead of inline onclick: `data-id="${escapeHtml(msg.id)}"` with a single click listener on `.messages-list`

---

### 🟢 Minor: `agentColors` object duplicated in two functions

**Location:** `agent-hub.html` — both `renderMessages()` and `renderMessageModal()`

**Issue:** Identical `agentColors` map defined in both functions. If a new agent is added or colors change, both need updating.

**Fix:** Extract to a shared constant alongside the existing `AGENTS` object.

---

### 🟢 Minor: First message poll delayed 10 seconds

**Location:** `agent-hub.html` line 2254

**Issue:** `setTimeout(pollMessages, MESSAGES_POLL_INTERVAL)` delays the first message list load by 10 seconds. The messages panel shows "No messages yet. Agents use `msg.js` to communicate." on page load even when messages exist. SSE init delivers badge counts immediately, but the list stays empty until the first poll fires.

**Contrast:** `pollLearnings()` (line 2251) is called immediately on init.

**Fix:** Call `pollMessages()` immediately like `pollLearnings()`:

```js
pollMessages();  // immediate first load
setInterval(pollMessages, MESSAGES_POLL_INTERVAL);
```

---

### 🟢 Minor: SSE init test should verify `messageCounts` property

**Location:** `tests/sse.test.js` lines 25-28

**Issue:** Test checks for `init.status`, `init.feed`, `init.learnings` but not `init.messageCounts`. Even with null DB, this property should exist with empty counts.

**Fix:** Add `assert.ok(init.messageCounts)` to the existing init event shape test.

---

## What Looks Good

- **All plan critique findings addressed in code:** `.message-modal` class add/remove lifecycle, route ordering (counts/thread before `:id`), `margin-left:auto` on wrapper div, `severity` filter parameter — all correctly implemented.
- **SQL parameterization** — All queries use `?` placeholders. No injection risk.
- **Read-only DB access** — `readonly: true, fileMustExist: true` is correct.
- **Graceful degradation** — All functions handle `messagesDb === null` cleanly (return `[]` or `{}`).
- **`escapeHtml()` on all rendered content** — Every user-controlled value in innerHTML is escaped (body, from, to, type, ref, id, etc.).
- **`encodeURIComponent()` on URL parameters** — Fetch calls properly encode message ID and thread ID.
- **Cache pattern** — `messagesCache` with TTL follows the existing `modelCache`/`learningsCache` pattern exactly.
- **SSE change detection** — JSON.stringify comparison for count broadcasting prevents redundant pushes.
- **Filter implementation** — Server-side filtering with query params is clean. The `currentMessageFilter` state with button toggling is intuitive.
- **CSS quality** — Animations, scrollbar styling, severity colors, status tags all consistent with existing dashboard aesthetic.
- **All 31 existing tests pass** — No regressions.

## Verdict

- [ ] Ready to merge
- [x] Needs fixes (see below)
- [ ] Needs redesign

**Must-fix before merging:**
1. Add `messagesDb: null` to `createTestApp` defaults
2. Add basic test coverage for the new endpoints

**Should-fix:**
3. Fix single-quote escaping in onclick handlers
4. Call `pollMessages()` immediately instead of after 10-second delay
