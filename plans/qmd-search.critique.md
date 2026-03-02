# Critique: QMD Documentation Search Plan

> Review of `qmd-search.md` — performed 2026-03-02
> Reviewer: reviewer agent
> Verdict: **Needs fixes** (no redesign required — 3 must-fix, 3 should-address)

## Summary

Well-structured plan that follows established codebase patterns closely. The FTS5 query works correctly (verified against the live DB), the architecture decisions are sound (direct FTS5 over MCP SDK), and the approach is appropriately scoped. However, it has **stale line references**, an **XSS gap in snippet rendering**, and a **schema documentation error** that need correction before the Coder agent can implement reliably.

---

## Findings

### 🟡 Important: Stale line references throughout the plan

- **Location:** Tasks 1, 3, 4 — multiple line number references
- **Issue:** The plan references line numbers from an older version of the codebase. Current `status-server.js` is 1175 lines and `agent-hub.html` is 1572 lines. Specific errors:

  | Plan says | Actual | What |
  |---|---|---|
  | `LEARNINGS_DB_PATH` at line 17 | Lines 16–17 | ✓ Correct |
  | Learnings DB connection at lines 75–82 | Lines 75–82 | ✓ Correct |
  | `GET /learnings` at line 1049 | **Line 1087** | ✗ Wrong |
  | Learnings panel `</div>` at line 962 | **Line 974** | ✗ Wrong |
  | `bottom-grid` div at line 964 | **Line 976** | ✗ Wrong |

- **Impact:** The Coder agent may insert code at the wrong location, especially for the HTML panel placement (Task 4) and the route registration (Task 3).
- **Fix:** Update all line references to match the current codebase:
  - Task 3: "Add after the existing `GET /learnings` route (line **1087**)"
  - Task 4: "between the learnings panel `</div>` (line **974**) and the `bottom-grid` div (line **976**)"

---

### 🟡 Important: FTS5 schema documentation has incorrect options

- **Location:** Plan lines 46–55, the "QMD SQLite Schema" section
- **Issue:** The plan documents the FTS5 table as:
  ```sql
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    filepath, title, body,
    content='',
    content_rowid='rowid'
  );
  ```
  The actual schema (verified against the live DB) is:
  ```sql
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    filepath, title, body,
    tokenize='porter unicode61'
  );
  ```
  The `content=''` and `content_rowid='rowid'` options don't exist — FTS5 maintains its own internal content store. Additionally, the actual table uses `tokenize='porter unicode61'` (porter stemming), which the plan doesn't mention.
- **Impact:** The query itself still works correctly (verified: `JOIN documents d ON d.id = f.rowid` produces correct results because the QMD indexer explicitly sets rowids to match document IDs). But the documentation is misleading — a developer reading it might draw incorrect conclusions about how the FTS5 table relates to the documents table.
- **Fix:** Update the schema block to match reality. Note the porter stemming tokenizer, as it affects search behavior (e.g., "errors" matches "error").

---

### 🟡 Important: Snippet innerHTML injection without sanitization

- **Location:** Task 6, `renderQmdResults()` — plan line 432
- **Issue:** The snippet field is injected as innerHTML:
  ```js
  const snippet = r.snippet || '';
  // ...
  return `<div class="qmd-result-snippet">${snippet}</div>`;
  ```
  The plan states this is "safe: generated server-side" but FTS5's `snippet()` function returns **raw text from document content** with `<mark>` markers inserted. If any indexed document contains HTML (e.g., `<script>`, `<img onerror=...>`, or even just `<div>` tags that break layout), those pass through verbatim.
- **Impact:** Low probability (these are internal markdown docs, not user-generated content), but it's a bad pattern to establish. If the QMD index ever indexes docs with embedded HTML, this becomes an XSS vector.
- **Fix:** Escape the snippet text first, then restore the `<mark>` tags:
  ```js
  function sanitizeSnippet(raw) {
    // Escape everything, then restore server-generated <mark> tags
    const escaped = escapeHtml(raw);
    return escaped
      .replace(/&lt;mark&gt;/g, '<mark>')
      .replace(/&lt;\/mark&gt;/g, '</mark>');
  }
  // In renderQmdResults():
  const snippet = sanitizeSnippet(r.snippet || '');
  ```
  This preserves the highlighting while neutralizing any stray HTML from document content.

---

### 🟢 Minor: Constants should be at module level, not inside `createApp()`

- **Location:** Task 2, plan line 128–129
- **Issue:** `QMD_DEFAULT_LIMIT` and `QMD_MAX_LIMIT` are defined inside the `searchQmdDocs()` function scope (which is itself inside `createApp()`). All other constants in the codebase — `MODEL_CACHE_TTL`, `LEARNINGS_CACHE_TTL`, `LEARNINGS_MAX_FETCH`, `MAX_FEED_ITEMS`, etc. — are declared at module level (lines 29–31).
- **Fix:** Move `QMD_DEFAULT_LIMIT` and `QMD_MAX_LIMIT` to the module-level constants section (after `LEARNINGS_MAX_FETCH` at line 31).

---

### 🟢 Minor: Startup banner task could clobber existing endpoint listing

- **Location:** Task 3, plan lines 210–220
- **Issue:** The plan shows a full replacement banner but omits `POST /agents/:agent/resync` which exists in the current code (line 1040). If the Coder agent replaces the whole banner block with the plan's version, the resync endpoint documentation disappears.
- **Fix:** Clarify that only the new `GET /qmd/search` line should be **appended** to the existing banner. Show the diff rather than the full replacement:
  ```
  +    GET  /qmd/search   → Search QMD docs (FTS5)
  ```

---

### 🟢 Minor: Task ordering — frontend references endpoint not yet defined

- **Location:** Tasks 6 and 7
- **Issue:** Task 6 (frontend JS) calls `fetch(\`${API_BASE}/qmd/doc/${docId}\`)`, but the `GET /qmd/doc/:id` endpoint is defined in Task 7. While the plan is read as a whole before implementation, the task numbering suggests sequential execution order. A Coder agent implementing task-by-task would have a frontend referencing a nonexistent endpoint.
- **Fix:** Either swap Tasks 6 and 7, or add a note in Task 6 that `GET /qmd/doc/:id` is defined in the next task.

---

## What Looks Good

- **FTS5 query verified working** — Tested against the live DB at `~/.cache/qmd/index.sqlite` (910 active docs). The `JOIN documents d ON d.id = f.rowid` correctly maps FTS5 entries to document metadata. BM25 ranking returns relevant results.
- **FTS5 sanitization approach is correct** — Wrapping tokens in double quotes (`"token"`) with escaped internal quotes is the right way to prevent FTS5 syntax injection. Tested with colons, hyphens, and parentheses.
- **Follows existing patterns exactly** — The DB connection code (`hasQmdDb`, `config.qmdDb`, readonly open, graceful degradation) mirrors the `learningsDb` pattern line-for-line. The endpoint style matches `GET /learnings`.
- **Lazy-load full content is the right call** — Returning 20 full documents per search would be expensive and wasteful. Snippets for search + on-demand full content is well designed.
- **300ms debounce + loading state** — Appropriate UX choices that prevent request flooding without feeling sluggish.
- **Zero new dependencies** — Clean plan that uses only `better-sqlite3` which is already installed.
- **Edge cases are well-covered** — Missing DB, FTS5 special chars, rapid typing, deleted documents between search and click — all handled.

---

## Required Fixes

| # | Finding | Severity | Effort |
|---|---------|----------|--------|
| 1 | Stale line references (Tasks 3, 4) | 🟡 Important | Update 3 line numbers |
| 2 | FTS5 schema docs have wrong options | 🟡 Important | Fix schema block |
| 3 | Snippet innerHTML without sanitization | 🟡 Important | Add `sanitizeSnippet()` helper |
| 4 | Constants at module level, not inside createApp | 🟢 Minor | Move 2 lines |
| 5 | Startup banner shows full replacement, missing resync | 🟢 Minor | Show diff instead |
| 6 | Task ordering: frontend before its endpoint | 🟢 Minor | Swap or add note |
