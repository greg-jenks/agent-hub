# Plan: QMD Documentation Search on Agent Hub Dashboard

## Goal

Add a searchable documentation panel to the Agent Hub dashboard, allowing the user to search 910+ NRC survey platform docs via FTS5 keyword search directly from the browser — without relying on an AI agent or MCP SDK.

## Background

The QMD tool indexes the `survey-management-documentation` repo into a SQLite database at `C:\Users\gjenks\.cache\qmd\index.sqlite`. This DB has an FTS5 full-text search index (`documents_fts`) that supports BM25-ranked keyword search with snippet extraction.

The agent-hub server already dirty-reads two SQLite databases via `better-sqlite3` in readonly mode:
1. **opencode DB** (`~/.local/share/opencode/opencode.db`) — for live model display
2. **learnings DB** (`../learnings-mcp/data/learnings.db`) — for the learnings feed

This plan adds a third readonly DB connection following the exact same pattern.

### Architecture Decision: Direct SQLite FTS5

- **Direct FTS5** (this plan): Zero new dependencies, BM25 keyword search with snippets, follows existing codebase patterns exactly
- **MCP SDK** (future enhancement): Would add semantic/vector search but requires `@modelcontextprotocol/sdk` dependency and child process management
- **Vector search**: Requires the `sqlite-vec` extension which `better-sqlite3` doesn't load by default — not viable for MVP

Direct FTS5 is the right choice for MVP: instant, zero-dependency, and covers the primary use case (searching docs by keyword).

### QMD SQLite Schema (relevant tables)

```sql
-- Main document metadata
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  collection TEXT,
  path TEXT,          -- e.g., "bugs/api-timeout-investigation.md"
  title TEXT,         -- extracted from markdown frontmatter/heading
  hash TEXT,          -- FK to content table
  created_at TEXT,
  modified_at TEXT,
  active INTEGER      -- 1 = not deleted
);

-- Full document content (joined via hash)
CREATE TABLE content (
  hash TEXT PRIMARY KEY,
  doc TEXT,           -- full markdown content
  created_at TEXT
);

-- FTS5 full-text search index (porter stemming + unicode tokenizer)
CREATE VIRTUAL TABLE documents_fts USING fts5(
  filepath,           -- document path
  title,              -- document title
  body,               -- full text content
  tokenize='porter unicode61'
);
```

### Verified FTS5 Query

Tested and working with `better-sqlite3`:

```sql
SELECT
  d.id,
  d.path,
  d.title,
  snippet(documents_fts, 2, '**', '**', '...', 30) as snippet,
  rank
FROM documents_fts f
JOIN documents d ON d.id = f.rowid
WHERE documents_fts MATCH ?
  AND d.active = 1
ORDER BY rank
LIMIT ?
```

- `snippet()` returns context around matches with `**` markers for highlighting
- `rank` is BM25 score (negative — lower is more relevant, standard FTS5 behavior)
- Joining on `d.active = 1` excludes deleted docs
- The `porter unicode61` tokenizer means stemming is applied — e.g., "errors" matches "error", "handling" matches "handled"
- The QMD indexer sets FTS5 rowids to match `documents.id`, so `JOIN documents d ON d.id = f.rowid` is valid
- Query runs in <10ms on 910 docs

## Files to Change

| File | What changes |
|---|---|
| `status-server.js` | Open QMD DB read-only, add `searchQmdDocs()` function, add `GET /qmd/search` endpoint, add `GET /qmd/doc/:id` endpoint (Tasks 1–4) |
| `agent-hub.html` | Add QMD search panel HTML below learnings feed, add CSS for search UI and results, add search JS with debounced input (Tasks 5–7) |

**No changes needed to**: `package.json` (already has `better-sqlite3`), wrapper scripts, agent definitions, feed logic, SSE events, or any other files.

## Tasks

### Task 1: Add QMD DB connection in `status-server.js`

At the top of the file, after the existing `LEARNINGS_DB_PATH` constant (line 17), add the QMD DB path constant. Also add the QMD search limits alongside the other module-level constants (after `LEARNINGS_MAX_FETCH` at line 31):

```js
// After line 17 (LEARNINGS_DB_PATH):
const QMD_DB_PATH = process.env.QMD_DB_PATH
  || path.join(os.homedir(), '.cache', 'qmd', 'index.sqlite');

// After line 31 (LEARNINGS_MAX_FETCH):
const QMD_DEFAULT_LIMIT = 20;
const QMD_MAX_LIMIT = 50;
```

Inside `createApp()`, after the learnings DB connection block (line 75–82), add a third readonly DB connection:

```js
const hasQmdDb = Object.prototype.hasOwnProperty.call(config, 'qmdDb');
let qmdDb = hasQmdDb ? config.qmdDb : null;
if (!hasQmdDb) {
  try {
    qmdDb = new Database(QMD_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.warn(`[qmd] Could not open QMD DB at ${QMD_DB_PATH}: ${e.message}`);
  }
}
```

Key design decisions:
- **Standard QMD cache path** (`~/.cache/qmd/index.sqlite`) as default — this is where the `qmd` CLI stores its index
- **`QMD_DB_PATH` env var** — override for flexibility (same pattern as learnings DB)
- **`config.qmdDb`** — injectable for tests (same pattern as `config.learningsDb` and `config.opencodeDb`)
- **Graceful degradation** — if the DB doesn't exist, `qmdDb` stays `null` and the search endpoint returns empty results

---

### Task 2: Add `searchQmdDocs()` function in `status-server.js`

After the `getRecentLearnings()` function, add the search function:

```js
function searchQmdDocs(query, limit = QMD_DEFAULT_LIMIT) {
  if (!qmdDb || !query || !query.trim()) {
    return [];
  }

  const safeLimit = Math.min(
    Number.isNaN(limit) ? QMD_DEFAULT_LIMIT : limit,
    QMD_MAX_LIMIT
  );

  try {
    // Sanitize query for FTS5: wrap each token in double quotes to
    // prevent FTS5 syntax errors from user input containing special chars
    // (e.g., colons, hyphens, parentheses). Tokens are ANDed implicitly.
    const sanitized = query
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => `"${t.replace(/"/g, '""')}"`)
      .join(' ');

    if (!sanitized) return [];

    const rows = qmdDb.prepare(`
      SELECT
        d.id,
        d.path,
        d.title,
        snippet(documents_fts, 2, '<mark>', '</mark>', '...', 30) as snippet,
        rank
      FROM documents_fts f
      JOIN documents d ON d.id = f.rowid
      WHERE documents_fts MATCH ?
        AND d.active = 1
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, safeLimit);

    return rows;
  } catch (e) {
    console.warn('[qmd] Search failed:', e.message);
    return [];
  }
}
```

Design notes:
- **No caching** — unlike learnings (which polls on a timer), search is on-demand with user-provided queries. Caching search results would require a query→results map with eviction, which adds complexity for minimal benefit on a <10ms query.
- **Constants at module level** — `QMD_DEFAULT_LIMIT` and `QMD_MAX_LIMIT` are declared at module level (Task 1) alongside `LEARNINGS_MAX_FETCH`, following the existing codebase pattern. They are not inside `createApp()`.
- **FTS5 query sanitization** — user input is split into tokens, each wrapped in double quotes to escape FTS5 special characters. This prevents syntax errors from queries like `api:timeout` or `error (500)`. Double quotes within tokens are escaped per FTS5 rules (`""` escapes a literal `"`).
- **`<mark>` tags in snippets** — the `snippet()` function wraps matched terms. Using `<mark>` tags lets the frontend style them with CSS (the browser renders `<mark>` with yellow highlight by default, which we'll restyle).
- **`AND` semantics** — FTS5 implicitly ANDs quoted tokens, so `"error" "handling"` finds docs containing both words (in any order), which is the expected behavior for a search box.
- **`rank` ordering** — FTS5 BM25 rank is negative (lower = more relevant). `ORDER BY rank` puts the best matches first.

---

### Task 3: Add `GET /qmd/search` endpoint in `status-server.js`

Add after the existing `GET /learnings` route (line 1087):

```js
// GET /qmd/search — Search QMD documentation via FTS5
app.get('/qmd/search', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) {
    return res.json([]);
  }
  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(parsedLimit) ? QMD_DEFAULT_LIMIT : parsedLimit;
  res.json(searchQmdDocs(query, limit));
});
```

API design:
- **`GET /qmd/search?q=error+handling&limit=20`** — query string parameters
- **Empty query returns `[]`** — no error, just empty results
- **No SSE integration** — search is request/response, not streamed. Unlike learnings (which appear in the SSE `init` payload), search results are only fetched when the user types a query.

**Append** the new endpoint to the existing startup banner (around line 1163, after the `GET /learnings` line). Do not replace the entire banner:

```diff
     GET  /learnings → Recent learnings JSON
+    GET  /qmd/search → Search QMD docs (FTS5)
+    GET  /qmd/doc/:id → Get full document content
```

Also add the QMD DB path to the status output (after the `Learnings DB:` line):

```diff
   Learnings DB: ${process.env.LEARNINGS_DB_PATH || LEARNINGS_DB_PATH}
+  QMD DB: ${process.env.QMD_DB_PATH || QMD_DB_PATH}
```

---

### Task 4: Add `GET /qmd/doc/:id` endpoint in `status-server.js`

This endpoint serves the full document content for the expand-on-click feature (Task 7):

```js
// GET /qmd/doc/:id — Get full document content by ID
app.get('/qmd/doc/:id', (req, res) => {
  if (!qmdDb) {
    return res.json({ content: '' });
  }

  const docId = parseInt(req.params.id, 10);
  if (Number.isNaN(docId)) {
    return res.status(400).json({ error: 'Invalid document ID' });
  }

  try {
    const row = qmdDb.prepare(`
      SELECT d.path, d.title, c.doc as content
      FROM documents d
      JOIN content c ON d.hash = c.hash
      WHERE d.id = ? AND d.active = 1
    `).get(docId);

    if (!row) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({
      id: docId,
      path: row.path,
      title: row.title,
      content: row.content
    });
  } catch (e) {
    console.warn('[qmd] Failed to fetch document:', e.message);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});
```

Design notes:
- **Separate from search** — search returns snippets (lightweight), this returns full content (can be large). Separating them keeps search responses fast.
- **Joins `content` table via `hash`** — the QMD schema stores document content separately, joined by hash. This query follows that schema.
- **Only active docs** — `d.active = 1` ensures deleted docs aren't served.

---

### Task 5: Add QMD search panel HTML in `agent-hub.html`

Insert a new full-width panel **between** the learnings panel `</div>` (line 974) and the `bottom-grid` div (line 976). This places it below the learnings feed as requested.

```html
<!-- QMD Documentation Search -->
<div class="section-label">Documentation Search</div>
<div class="panel qmd-panel">
  <div class="panel-head">
    <span>QMD Docs</span>
    <span id="qmdResultCount"></span>
  </div>
  <div class="qmd-search-container">
    <input type="text" id="qmdSearchInput" class="qmd-search-input"
           placeholder="Search 910+ NRC survey platform docs..."
           autocomplete="off" spellcheck="false" />
  </div>
  <div class="qmd-results" id="qmdResults">
    <div class="feed-empty">Type to search documentation.</div>
  </div>
</div>
```

---

### Task 6: Add CSS for QMD search panel in `agent-hub.html`

Add to the `<style>` block, after the existing learnings panel CSS:

```css
/* QMD search panel */
.qmd-panel {
  margin-bottom: 32px;
}

.qmd-search-container {
  padding: 12px 18px 0;
}

.qmd-search-input {
  width: 100%;
  padding: 10px 14px;
  font-family: 'Share Tech Mono', monospace;
  font-size: 12px;
  color: var(--text);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.2s, background 0.2s;
  box-sizing: border-box;
}
.qmd-search-input:focus {
  border-color: var(--accent, #00d4ff);
  background: rgba(255, 255, 255, 0.06);
}
.qmd-search-input::placeholder {
  color: var(--muted);
  opacity: 0.6;
}

.qmd-results {
  padding: 14px 18px;
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.qmd-results::-webkit-scrollbar { width: 4px; }
.qmd-results::-webkit-scrollbar-track { background: transparent; }
.qmd-results::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

.qmd-result-item {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.2s;
  animation: fadeSlide 0.3s ease;
}
.qmd-result-item:hover {
  background: rgba(255, 255, 255, 0.03);
  border-color: var(--border);
}

.qmd-result-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  line-height: 1.4;
  margin-bottom: 4px;
}

.qmd-result-path {
  font-family: 'Share Tech Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  opacity: 0.7;
  margin-bottom: 6px;
}

.qmd-result-snippet {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  /* Show snippet in collapsed view */
}
.qmd-result-snippet mark {
  background: rgba(0, 212, 255, 0.2);
  color: #00d4ff;
  border-radius: 2px;
  padding: 0 2px;
}

.qmd-result-content {
  display: none;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
}

.qmd-result-item.expanded .qmd-result-content {
  display: block;
}

.qmd-loading {
  text-align: center;
  color: var(--muted);
  font-size: 11px;
  padding: 20px;
}
```

Design notes:
- **`<mark>` styling** — FTS5 snippets use `<mark>` tags. We restyle them to match the dashboard's cyan accent color instead of the browser's default yellow.
- **`max-height: 400px`** — taller than the learnings panel (300px) because search results are the primary purpose of this panel and the user may want to scan more results.
- **Expand-on-click** — same pattern as learnings items. Clicking a result shows the full document content (fetched on demand — see Task 7).

---

### Task 7: Add QMD search JS in `agent-hub.html`

Add to the `<script>` block:

```js
// ─── QMD Documentation Search ─────────────────────────────────

const QMD_DEBOUNCE_MS = 300;
let qmdDebounceTimer = null;

// Sanitize FTS5 snippets: escape all HTML, then restore server-generated <mark> tags
function sanitizeSnippet(raw) {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

document.getElementById('qmdSearchInput').addEventListener('input', (e) => {
  clearTimeout(qmdDebounceTimer);
  const query = e.target.value.trim();

  if (!query) {
    document.getElementById('qmdResults').innerHTML =
      '<div class="feed-empty">Type to search documentation.</div>';
    document.getElementById('qmdResultCount').textContent = '';
    return;
  }

  // Show loading state for non-empty queries
  document.getElementById('qmdResults').innerHTML =
    '<div class="qmd-loading">Searching...</div>';

  qmdDebounceTimer = setTimeout(() => searchQmd(query), QMD_DEBOUNCE_MS);
});

async function searchQmd(query) {
  try {
    const res = await fetch(
      `${API_BASE}/qmd/search?q=${encodeURIComponent(query)}&limit=20`
    );
    if (!res.ok) {
      document.getElementById('qmdResults').innerHTML =
        '<div class="feed-empty">Search unavailable.</div>';
      return;
    }
    const results = await res.json();
    renderQmdResults(results);
  } catch (e) {
    document.getElementById('qmdResults').innerHTML =
      '<div class="feed-empty">Search unavailable.</div>';
  }
}

function renderQmdResults(results) {
  const container = document.getElementById('qmdResults');
  const countEl = document.getElementById('qmdResultCount');

  if (!results || results.length === 0) {
    container.innerHTML = '<div class="feed-empty">No results found.</div>';
    countEl.textContent = '0 results';
    return;
  }

  container.innerHTML = results.map(r => {
    const title = escapeHtml(r.title || r.path);
    const pathDisplay = escapeHtml(r.path || '');
    // Snippet contains <mark> tags from FTS5 but may also contain raw HTML
    // from document content. Escape everything, then restore the safe <mark> tags.
    const snippet = sanitizeSnippet(r.snippet || '');

    return `
      <div class="qmd-result-item" onclick="toggleQmdResult(this, ${r.id})">
        <div class="qmd-result-title">${title}</div>
        <div class="qmd-result-path">${pathDisplay}</div>
        <div class="qmd-result-snippet">${snippet}</div>
        <div class="qmd-result-content" data-doc-id="${r.id}"></div>
      </div>
    `;
  }).join('');

  countEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;
}

async function toggleQmdResult(el, docId) {
  el.classList.toggle('expanded');

  // Lazy-load full content on first expand
  const contentEl = el.querySelector('.qmd-result-content');
  if (el.classList.contains('expanded') && !contentEl.dataset.loaded) {
    contentEl.textContent = 'Loading...';
    try {
      const res = await fetch(`${API_BASE}/qmd/doc/${docId}`);
      if (res.ok) {
        const data = await res.json();
        contentEl.textContent = data.content || 'No content available.';
      } else {
        contentEl.textContent = 'Failed to load document.';
      }
    } catch {
      contentEl.textContent = 'Failed to load document.';
    }
    contentEl.dataset.loaded = 'true';
  }
}
```

Design notes:
- **300ms debounce** — waits for the user to stop typing before issuing the HTTP request. Prevents hammering the server on every keystroke.
- **Loading state** — shows "Searching..." immediately when the user types, replaced by results or "No results found" when the fetch completes.
- **Snippet sanitization** — the `snippet` field contains `<mark>` tags generated by FTS5, but may also contain raw HTML from document content (e.g., markdown docs with embedded HTML). `sanitizeSnippet()` escapes everything via `escapeHtml()`, then restores only the `<mark>` and `</mark>` tags. This prevents XSS while preserving search highlighting. All other fields (`title`, `path`) use `escapeHtml()` directly.
- **Lazy-load full content** — clicking a result expands it and fetches the full document content on first click. This avoids sending full content for all 20 results on every search. Subsequent toggles use the cached DOM content (`data-loaded` flag).

---

## Data Flow

```
┌──────────────────────────────────┐
│ QMD SQLite DB                    │
│ ~/.cache/qmd/index.sqlite        │
│ documents + documents_fts tables │
└──────────┬───────────────────────┘
           │ readonly FTS5 query (on-demand, <10ms)
           ▼
┌──────────────────────────┐         ┌────────────────────────────┐
│  status-server.js        │         │  Dashboard HTML             │
│  GET /qmd/search?q=...   │──json──►│  renderQmdResults()         │
│  GET /qmd/doc/:id        │──json──►│  toggleQmdResult() expand   │
│  no cache (on-demand)    │         │  300ms debounced input      │
└──────────────────────────┘         └────────────────────────────┘

User types in search box:
  1. Input event fires → 300ms debounce starts
  2. After 300ms idle → fetch /qmd/search?q=...
  3. Server runs FTS5 MATCH query → returns [{id, path, title, snippet, rank}]
  4. renderQmdResults() displays results with snippets
  5. User clicks result → fetch /qmd/doc/:id → show full content
```

## Verification

After implementation, verify with this sequence:

1. **Start the server**: `npm start` — should see QMD DB path logged (or a warning if not found)
2. **Search API**: `curl "http://localhost:3747/qmd/search?q=error+handling"` — should return JSON array of results with `id`, `path`, `title`, `snippet` (with `<mark>` tags), and `rank`
3. **Empty query**: `curl "http://localhost:3747/qmd/search?q="` — should return `[]`
4. **Doc content API**: `curl "http://localhost:3747/qmd/doc/1"` — should return JSON with `id`, `path`, `title`, `content` (full markdown)
5. **Open the dashboard**: `http://localhost:3747` — QMD search panel should appear between learnings feed and activity log
6. **Type a query** — results should appear after ~300ms debounce with highlighted snippets
7. **Click a result** — should expand to show full document content, click again to collapse
8. **Special characters** — search for `api:timeout` or `error (500)` — should return results without errors (FTS5 sanitization working)
9. **Missing DB** — stop server, rename `index.sqlite`, restart. Search should show "Search unavailable." gracefully.

## Edge Cases

- **QMD DB doesn't exist**: Server starts normally, endpoint returns `[]`, panel shows "Search unavailable." No crash.
- **QMD DB is locked by `qmd` CLI indexing**: WAL mode allows concurrent readers. `better-sqlite3` readonly open is safe. Worst case: slightly stale index (acceptable).
- **FTS5 special characters in query**: Sanitized by wrapping each token in double quotes. Handles colons, hyphens, parentheses, wildcards, etc.
- **Empty search results**: Panel shows "No results found." — not an error state.
- **Very long documents**: Full content is lazy-loaded only on click, rendered in a scrollable container (`max-height: 400px`, `overflow-y: auto`).
- **Rapid typing**: 300ms debounce prevents excessive requests. Only the last query fires.
- **No FTS5 index**: If the QMD DB exists but `documents_fts` table is missing (e.g., old schema), the query will fail and the `catch` block returns `[]`. Logged as a warning.
- **Document deleted between search and click**: `GET /qmd/doc/:id` checks `d.active = 1` and returns 404. Frontend shows "Failed to load document."

## Notes

- Zero new dependencies — `better-sqlite3` is already installed.
- ~120 lines backend, ~150 lines frontend (CSS + JS + HTML).
- FTS5 queries run in <10ms on 910 docs — no need for caching or pagination for this scale.
- The `QMD_DB_PATH` env var provides flexibility if the cache location changes.
- Snippet `<mark>` tags are generated server-side by SQLite's `snippet()` function. The frontend `sanitizeSnippet()` helper escapes all HTML then restores only the `<mark>` tags, preventing XSS from document content.
- This plan does NOT add QMD data to the SSE `init` payload (unlike learnings). Search is purely on-demand.
- Future enhancement: add a `GET /qmd/stats` endpoint to show doc count in the panel header, or integrate MCP SDK for semantic search.
