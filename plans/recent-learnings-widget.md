# Plan: Recent Learnings Widget on Agent Hub Dashboard

## Goal

Display the most recent learnings from the `learnings-mcp` SQLite database as a scrollable panel on the Agent Hub dashboard, positioned above the activity log, with 30-second dirty-read polling.

## Background

The learnings-mcp project stores entries (learnings, conversation summaries, mistakes, project context) in a SQLite database at `C:\Users\gjenks\Repos\learnings-mcp\data\learnings.db`. The `entries` table has all the data we need — no vector tables required.

The agent-hub server already dirty-reads the opencode SQLite DB via `better-sqlite3` in readonly mode for live model display (lines 26-31 of `status-server.js`). This is the exact same pattern we'll follow.

### Source table — `entries` (relevant columns)

```sql
SELECT id, type, title, content, project, tags, created_at
FROM entries
ORDER BY created_at DESC
LIMIT 20
```

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER | PK |
| `type` | TEXT | `learning`, `conversation`, `mistake`, `project_context` |
| `title` | TEXT | Short title (max 500 chars) |
| `content` | TEXT | Full content (can be 1000+ chars for conversation summaries) |
| `project` | TEXT | nullable — e.g., `agent-hub`, `learnings-mcp`, `survey-management-api` |
| `tags` | TEXT | comma-separated, nullable |
| `created_at` | TEXT | ISO 8601 |

You can verify the query works with: `sqlite3 ../learnings-mcp/data/learnings.db "SELECT id, type, title, substr(content,1,80), project, created_at FROM entries ORDER BY created_at DESC LIMIT 5;"`

## Files to Change

| File | What changes |
|---|---|
| `status-server.js` | Open learnings DB read-only, add `getRecentLearnings()` with 30s cache, add `GET /learnings` endpoint, include learnings in SSE `init` payload |
| `agent-hub.html` | Add learnings panel HTML above bottom-grid, add CSS for entry type badges and layout, add `updateLearnings()` JS, handle learnings from SSE `init` event |

**No changes needed to**: `package.json` (already has `better-sqlite3`), wrapper scripts, agent definitions, feed logic, or any other files.

## Tasks

### Task 1: Add learnings DB connection in `status-server.js`

At the top of the file, after the existing opencode DB setup (around line 31–36), add a second readonly DB connection:

```js
const LEARNINGS_DB_PATH = process.env.LEARNINGS_DB_PATH
  || path.join(__dirname, '..', 'learnings-mcp', 'data', 'learnings.db');

let learningsDb = null;
try {
  learningsDb = new Database(LEARNINGS_DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.warn(`[learnings] Could not open learnings DB at ${LEARNINGS_DB_PATH}: ${e.message}`);
}
```

Key design decisions:
- **Sibling repo path** as default — both repos live under `C:\Users\gjenks\Repos\`
- **`LEARNINGS_DB_PATH` env var** — override for flexibility (same pattern as learnings-mcp's own config)
- **Graceful degradation** — if the DB doesn't exist, `learningsDb` stays `null` and the endpoint returns empty results

---

### Task 2: Add `getRecentLearnings()` with 30s cache in `status-server.js`

```js
const LEARNINGS_CACHE_TTL = 30_000; // 30 seconds
const LEARNINGS_MAX_FETCH = 50;
let learningsCache = { data: [], timestamp: 0 };

function getRecentLearnings(limit = 20) {
  const now = Date.now();
  if (now - learningsCache.timestamp < LEARNINGS_CACHE_TTL) {
    return learningsCache.data.slice(0, limit);
  }

  if (!learningsDb) {
    return learningsCache.data.slice(0, limit);
  }

  try {
    const rows = learningsDb.prepare(`
      SELECT id, type, title, content, project, tags, created_at
      FROM entries
      ORDER BY created_at DESC
      LIMIT ?
    `).all(LEARNINGS_MAX_FETCH);

    learningsCache = { data: rows, timestamp: now };
    return rows.slice(0, limit);
  } catch (e) {
    console.warn('[learnings] Failed to read learnings DB:', e.message);
    return learningsCache.data.slice(0, limit);
  }
}
```

Design notes:
- **30 second TTL** — matches your spec. Even if the dashboard polls more frequently, the DB is only read every 30s.
- **No content truncation server-side** — send full content (20 entries x ~1KB = ~20KB per response, trivial). The dashboard stores full content in the DOM and uses CSS-only truncation for the collapsed view. Expanding reveals the full, untruncated content.
- **Same cache pattern** as `getLatestModels()` — return stale data on error, never crash.
- **No sqlite-vec needed** — we only query the plain `entries` table, not the `vec_entries` virtual table. `better-sqlite3` handles this fine without loading the extension.
- **Always fetch the max** — `getRecentLearnings()` always queries `LIMIT 50` (the max) and caches those rows. The endpoint slices the cached array to honor the `?limit=` query param. This avoids cache misses when different callers request different limits.

---

### Task 3: Add `GET /learnings` endpoint in `status-server.js`

Add after the existing `GET /feed` route:

```js
// GET /learnings — Recent learnings from learnings-mcp DB
app.get('/learnings', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const learnings = getRecentLearnings(limit);
  res.json(learnings);
});
```

**Also update the SSE `init` payload** in the `GET /stream` route (line 304) to include learnings:

```js
// BEFORE (line 304):
res.write(`data: ${JSON.stringify({ type: 'init', status: buildStatusSnapshot(), feed: feedBuffer.slice(0, MAX_FEED_ITEMS) })}\n\n`);

// AFTER:
res.write(`data: ${JSON.stringify({
  type: 'init',
  status: buildStatusSnapshot(),
  feed: feedBuffer.slice(0, MAX_FEED_ITEMS),
  learnings: getRecentLearnings(20)
})}\n\n`);
```

This ensures the learnings panel populates **immediately** on page load / reconnect via the SSE `init` event, instead of waiting for the first 30s poll.

Update the startup banner to include the new endpoint and the learnings DB status:

```
  Endpoints:
    GET  /          → Dashboard HTML
    GET  /status    → Agent status JSON
    GET  /stream    → SSE event stream (init includes learnings)
    POST /status    → Update agent status
    GET  /feed      → Activity feed JSON
    POST /feed      → Add feed entry
    GET  /learnings → Recent learnings JSON   ← NEW
```

---

### Task 4: Add learnings panel HTML in `agent-hub.html`

Insert a new full-width panel **between** the agent grid `</div>` (line 804) and the `bottom-grid` div (line 806). This places it above the activity log as requested.

```html
<!-- Recent Learnings -->
<div class="section-label">Recent Learnings</div>
<div class="panel learnings-panel">
  <div class="panel-head">
    <span>Learnings Feed</span>
    <span id="learningsCount">0 entries</span>
  </div>
  <div class="learnings-feed" id="learningsFeed">
    <div class="feed-empty">No learnings yet.</div>
  </div>
</div>
```

---

### Task 5: Add CSS for learnings panel in `agent-hub.html`

Add to the `<style>` block. Reuse existing panel patterns, add type-specific badge colors:

```css
/* Learnings panel */
.learnings-panel {
  margin-bottom: 32px;
}

.learnings-feed {
  padding: 14px 18px;
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.learnings-feed::-webkit-scrollbar { width: 4px; }
.learnings-feed::-webkit-scrollbar-track { background: transparent; }
.learnings-feed::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.learning-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 11px;
  animation: fadeSlide 0.4s ease;
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.2s;
}
.learning-item:hover {
  background: rgba(255,255,255,0.03);
  border-color: var(--border);
}

.learning-type {
  font-family: 'Share Tech Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.1em;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 1px;
}
.learning-type.learning    { background: rgba(0, 212, 255, 0.15); color: #00d4ff; }
.learning-type.conversation { background: rgba(124, 58, 237, 0.15); color: #a78bfa; }
.learning-type.mistake      { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.learning-type.project_context { background: rgba(16, 185, 129, 0.15); color: #34d399; }

.learning-body { flex: 1; min-width: 0; }

.learning-title {
  color: var(--text);
  font-weight: 500;
  line-height: 1.4;
  margin-bottom: 2px;
}

.learning-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 10px;
  color: var(--muted);
}

.learning-project {
  font-family: 'Share Tech Mono', monospace;
  color: var(--planner-primary);
  opacity: 0.7;
}

.learning-content {
  display: none;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Collapsed: hidden. Expanded: show full content with scroll */
.learning-item.expanded .learning-content {
  display: block;
  max-height: 300px;
  overflow-y: auto;
}
```

Type badge color mapping:
- `learning` → cyan (matches planner — knowledge)
- `conversation` → purple (matches coder — session summaries)
- `mistake` → red (danger/warning)
- `project_context` → green (matches reviewer — stable info)

---

### Task 6: Add learnings JS in `agent-hub.html`

Add to the `<script>` block:

```js
const LEARNINGS_POLL_INTERVAL = 30_000; // 30 seconds
const VALID_LEARNING_TYPES = ['learning', 'conversation', 'mistake', 'project_context'];

async function pollLearnings() {
  try {
    const res = await fetch(`${API_BASE}/learnings?limit=20`);
    if (!res.ok) return;
    const items = await res.json();
    updateLearnings(items);
  } catch (e) {
    // silent — status poll handles offline state
  }
}

function updateLearnings(items) {
  const feed = document.getElementById('learningsFeed');
  const countEl = document.getElementById('learningsCount');

  if (!items || items.length === 0) {
    feed.innerHTML = '<div class="feed-empty">No learnings yet.</div>';
    countEl.textContent = '0 entries';
    return;
  }

  feed.innerHTML = items.map(item => {
    // Reuse existing getTimeAgo() — defined at line 1207
    const ago = getTimeAgo(new Date(item.created_at));
    const project = item.project ? `<span class="learning-project">${escapeHtml(item.project)}</span>` : '';
    const tags = item.tags ? `<span>${escapeHtml(item.tags)}</span>` : '';
    const typeLabel = (item.type || '').replace('_', ' ');
    // Sanitize type before using as CSS class — only allow known values
    const typeClass = VALID_LEARNING_TYPES.includes(item.type) ? item.type : '';

    return `
      <div class="learning-item" onclick="this.classList.toggle('expanded')">
        <span class="learning-type ${typeClass}">${escapeHtml(typeLabel)}</span>
        <div class="learning-body">
          <div class="learning-title">${escapeHtml(item.title)}</div>
          <div class="learning-meta">
            ${project}
            ${tags}
            <span>${ago}</span>
          </div>
          <div class="learning-content">${escapeHtml(item.content || '')}</div>
        </div>
      </div>
    `;
  }).join('');

  countEl.textContent = `${items.length} entr${items.length !== 1 ? 'ies' : 'y'}`;
}
```

Key differences from the initial draft:
- **Full content in DOM** — `item.content` is rendered untruncated into `.learning-content`. The collapsed view is truncated purely via CSS (`-webkit-line-clamp` or `max-height`), so expanding reveals the full text without any re-fetch.
- **Reuses `getTimeAgo()`** — the dashboard already has this function (line 1207). No duplicate `relativeTime()` function.
- **Sanitizes `item.type`** — only allows known type values (`VALID_LEARNING_TYPES`) as CSS class names. Unknown types get an empty class string, preventing injection.

**Update the SSE `init` handler** in `connectSSE()` (around line 982) to populate learnings immediately on connect:

```js
// In the 'init' case of the SSE message handler:
case 'init':
  updateCards(data.status?.agents || {});
  lastAgentsData = data.status?.agents || {};
  updateFeed(data.feed || []);
  updateLearnings(data.learnings || []);  // ← ADD THIS LINE
  break;
```

Add to the init section at the bottom (alongside existing `pollStatus()`/`pollFeed()`/`connectSSE()` calls):

```js
// Init
pollLearnings();
setInterval(pollLearnings, LEARNINGS_POLL_INTERVAL);
```

**Data flow on page load**: SSE `init` event fires immediately and calls `updateLearnings()` with cached data. The 30s `pollLearnings()` interval then keeps it fresh. This means the panel populates instantly — no 30s wait on first load.

---

## Data Flow

```
┌──────────────────────────────────┐
│ learnings-mcp SQLite DB          │
│ data/learnings.db                │
│ entries table (no vec needed)    │
└──────────┬───────────────────────┘
           │ read-only query (30s cache, always LIMIT 50)
           ▼
┌─────────────────────┐         ┌───────────────────┐
│  status-server.js   │         │  Dashboard HTML    │
│  GET /learnings     │──json──►│  updateLearnings() │
│  SSE init payload   │──sse───►│  scrollable panel  │
│  30s TTL cache      │         │  click to expand   │
└─────────────────────┘         └───────────────────┘

Page load:
  1. connectSSE() → server sends init event with {status, feed, learnings}
  2. updateLearnings() renders panel immediately (no waiting)
  3. setInterval(pollLearnings, 30_000) keeps data fresh
```

## Verification

After implementation, verify with this sequence:

1. **Start the server**: `npm start` — should see the learnings DB path logged (or a warning if not found)
2. **Hit the API**: `curl http://localhost:3747/learnings` — should return JSON array of recent entries with id, type, title, content, project, tags, created_at
3. **Check SSE init**: `curl -N http://localhost:3747/stream` — the `init` event JSON should contain a `learnings` array alongside `status` and `feed`
4. **Open the dashboard**: `http://localhost:3747` — learnings panel should appear above the activity log with entries **immediately** (no 30s wait — SSE init provides data)
5. **Click an entry** — it should expand to show the **full, untruncated content** with scrollbar for long entries, click again to collapse
6. **Add a new learning** — via any agent's `learnings_add_learning` tool, the new entry should appear in the panel within 30 seconds
7. **Kill learnings-mcp** — dashboard should continue working, showing cached data. No errors in console.
8. **Missing DB** — stop server, rename/move `learnings.db`, restart server. Dashboard should show "No learnings yet." and no crash.

## Edge Cases

- **Learnings DB doesn't exist**: Server starts normally, endpoint returns `[]`, SSE init sends `learnings: []`, panel shows empty state. No crash.
- **Learnings DB is locked by MCP server writing**: WAL mode allows concurrent readers. `better-sqlite3` readonly open is safe. Worst case: slightly stale data (acceptable for a 30s poll).
- **Very long content**: Full content is sent from server and stored in the DOM. The collapsed view hides `.learning-content` entirely (`display: none`). On expand, the full content is shown with `max-height: 300px` and `overflow-y: auto` for scrollability.
- **sqlite-vec virtual table**: We never touch `vec_entries`. Plain `better-sqlite3` without the sqlite-vec extension handles the `entries` table fine.
- **No entries in DB**: Empty state renders cleanly.
- **Server restarts**: Cache is cold, first request queries the DB. Subsequent requests use 30s cache.
- **Unknown entry type**: `item.type` is sanitized before use as a CSS class — only values in `VALID_LEARNING_TYPES` are applied. Unknown types render with the base `.learning-type` style (no color).
- **Different limit values**: `getRecentLearnings()` always fetches `LIMIT 50` and caches the full set. The `?limit=` parameter only slices the cached array, so different callers get correct results without cache misses.

## Notes

- Zero new dependencies — `better-sqlite3` is already installed.
- ~150 lines of new code across 2 files.
- The expand-on-click interaction is pure CSS (`.expanded` class toggle) — no additional JS framework or state management needed.
- Full content is stored in the DOM but hidden by default. Expanding reveals the full text. This avoids re-fetching or storing truncated data.
- The `content` field can contain markdown-like formatting but we render it as plain preformatted text (`white-space: pre-wrap`). No markdown parser needed — this is a quick glance view, not a reader.
- The `LEARNINGS_DB_PATH` env var provides flexibility if the repos move or the DB path changes.
- Learnings populate immediately via the SSE `init` event — no 30-second wait on first page load.
- No duplicate utility functions — reuses the existing `getTimeAgo()` (line 1207) and `escapeHtml()` (line 1189).
