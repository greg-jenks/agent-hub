# Plan: Live Model Display in Agent Hub

## Goal

Show the **actual model** each opencode agent is currently using on the dashboard, updated live from the opencode SQLite database — not a static hardcoded label.

## Background

opencode's SQLite DB (`C:\Users\gjenks\.local\share\opencode\opencode.db`) records `modelID` and `providerID` on **every assistant message** in the `message.data` JSON column. When the user switches models mid-session, the next message reflects the new model. This is the source of truth.

The coder agent (gh copilot) does **not** use opencode — it keeps its hardcoded model display for now. No changes needed for coder.

### Proof — DB query that gets the latest model per agent

```sql
SELECT json_extract(data, '$.agent') as agent,
       json_extract(data, '$.modelID') as model,
       json_extract(data, '$.providerID') as provider
FROM message
WHERE json_extract(data, '$.role') = 'assistant'
  AND json_extract(data, '$.agent') IN ('planner','reviewer','refactor')
GROUP BY json_extract(data, '$.agent')
HAVING time_created = MAX(time_created)
```

Example output:

```json
[
  { "agent": "planner",  "model": "claude-opus-4.6",   "provider": "github-copilot" },
  { "agent": "reviewer", "model": "claude-opus-4.6",   "provider": "github-copilot" }
]
```

You can verify this yourself with: `opencode db "<query above>" --format json`

## Files to Change

| File | What changes |
|---|---|
| `package.json` | Add `better-sqlite3` dependency |
| `status-server.js` | Import better-sqlite3, add `getLatestModels()` with 10s cache, enrich `GET /status` response |
| `agent-hub.html` | Add `id` to model tags, dynamic update in `updateCards()`, live model in `openModal()`, `defaultModel` fallback in AGENTS config |

**No changes needed to**: wrapper scripts (`scripts/*.ps1`), agent definitions, feed logic, or any other files.

## Tasks

### Task 1: Install `better-sqlite3`

Run `npm install better-sqlite3` in the `agent-hub` directory.

This is a fast synchronous SQLite reader with prebuilt Windows x64 binaries.

---

### Task 2: Add opencode DB reader to `status-server.js`

At the top of the file, after the existing requires:

1. Import `better-sqlite3`
2. Resolve the DB path: `path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')` (also import `os`)
3. Open the DB **read-only**: `new Database(dbPath, { readonly: true, fileMustExist: true })`
4. Wrap the DB open in try/catch — if the file doesn't exist or can't be opened, set the db reference to `null` and log a warning. The server should still work without it.

Create a `getLatestModels()` function:

```js
const MODEL_CACHE_TTL = 10_000; // 10 seconds
let modelCache = { data: {}, timestamp: 0 };

function getLatestModels() {
  const now = Date.now();
  if (now - modelCache.timestamp < MODEL_CACHE_TTL) {
    return modelCache.data;
  }

  if (!opencodeDb) {
    return modelCache.data; // return stale or empty
  }

  try {
    const rows = opencodeDb.prepare(`
      SELECT json_extract(data, '$.agent') as agent,
             json_extract(data, '$.modelID') as model,
             json_extract(data, '$.providerID') as provider
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant'
        AND json_extract(data, '$.agent') IN ('planner','reviewer','refactor')
      GROUP BY json_extract(data, '$.agent')
      HAVING time_created = MAX(time_created)
    `).all();

    const result = {};
    for (const row of rows) {
      result[row.agent] = { model: row.model, provider: row.provider };
    }
    modelCache = { data: result, timestamp: now };
    return result;
  } catch (e) {
    console.warn('[model-query] Failed to read opencode DB:', e.message);
    return modelCache.data; // return stale on error
  }
}
```

Key design decisions:
- **10 second cache** — dashboard polls every 5s, so we don't query the DB on every request
- **Read-only** — we never write to the opencode DB
- **Graceful degradation** — if the DB is locked, missing, or errored, return cached/empty data. The server never crashes.
- **Prepared statement** — `better-sqlite3` caches prepared statements, so this is fast

---

### Task 3: Merge model data into `GET /status`

In the existing `GET /status` route handler, after loading status from `status.json`, merge in the model data:

```js
app.get('/status', (req, res) => {
  const status = loadStatus();
  const models = getLatestModels();

  // Enrich each agent with live model data from opencode DB
  for (const [agent, modelInfo] of Object.entries(models)) {
    if (status.agents[agent]) {
      status.agents[agent].model = modelInfo.model;
      status.agents[agent].provider = modelInfo.provider;
    }
  }

  res.json(status);
});
```

The coder agent won't have model data from the DB — that's expected. The dashboard handles this with a fallback.

---

### Task 4: Update dashboard — dynamic model tags in cards

In `agent-hub.html`, make these changes:

**4a. Add `id` attributes to model tag spans**

Each agent card has a hardcoded model tag like:
```html
<span class="tag">Claude Opus 4.6</span>
```

Add an `id` so JS can target it:
```html
<span class="tag" id="model-planner">Claude Opus 4.6</span>
```

Do this for all four agents: `model-planner`, `model-coder`, `model-reviewer`, `model-refactor`.

Keep the hardcoded text as the initial/fallback value.

**4b. Add `defaultModel` to the AGENTS config**

In the JavaScript `AGENTS` object, add a `defaultModel` property to each agent:

```js
planner: {
  // ... existing properties ...
  defaultModel: 'Claude Opus 4.6',
},
coder: {
  // ... existing properties ...
  defaultModel: 'GPT-5.3 Codex',
},
reviewer: {
  // ... existing properties ...
  defaultModel: 'Claude Opus 4.6',
},
refactor: {
  // ... existing properties ...
  defaultModel: 'Claude Sonnet 4.6',
},
```

**4c. Update `updateCards()` to set the model tag dynamically**

Inside the `for` loop in `updateCards()`, after updating the status dot/label/badge/message, add:

```js
// Update model tag
const modelEl = document.getElementById(`model-${name}`);
if (modelEl) {
  if (info.model) {
    // Format: "claude-opus-4.6" → "Claude Opus 4.6" (or use raw if preferred)
    modelEl.textContent = formatModelName(info.model);
  } else {
    modelEl.textContent = AGENTS[name]?.defaultModel || '';
  }
}
```

**4d. Add a `formatModelName()` helper**

The DB stores model IDs like `claude-opus-4.6` or `claude-sonnet-4.6`. Convert to display names:

```js
function formatModelName(modelID) {
  if (!modelID) return '';
  // "claude-opus-4.6" → "Claude Opus 4.6"
  // "gpt-5.3-codex"   → "GPT 5.3 Codex"
  return modelID
    .split('-')
    .map(part => {
      if (/^\d/.test(part)) return part; // keep version numbers as-is
      if (part.toLowerCase() === 'gpt') return 'GPT';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}
```

**4e. Store polled agents data for modal use**

Add a module-level variable to store the last polled data:

```js
let lastAgentsData = {};
```

In `pollStatus()`, after calling `updateCards(data.agents)`, store it:

```js
lastAgentsData = data.agents;
```

---

### Task 5: Update dashboard — live model in modal

In the `openModal()` function, replace the static subtitle with live data:

```js
// Use live model data if available, fall back to default
const liveData = lastAgentsData[type];
const liveModel = liveData?.model ? formatModelName(liveData.model) : a.defaultModel;
const subtitle = a.subtitle.split('·')[0].trim() + ' · ' + liveModel;

document.getElementById('modalSubtitle').textContent = subtitle;
```

This keeps the platform prefix (e.g., "opencode") from the existing `subtitle` and replaces only the model portion with live data.

**Alternative simpler approach**: Change each AGENTS entry's `subtitle` to just the platform name (e.g., `'opencode'`), and construct the full subtitle in `openModal()`:

```js
const liveModel = lastAgentsData[type]?.model
  ? formatModelName(lastAgentsData[type].model)
  : a.defaultModel;
document.getElementById('modalSubtitle').textContent = `${a.subtitle} · ${liveModel}`;
```

Then update the AGENTS config subtitles:
- planner: `'opencode'`
- coder: `'gh copilot CLI'`
- reviewer: `'opencode'`
- refactor: `'opencode'`

Use whichever approach feels cleaner.

---

## Data Flow

```
┌──────────────────────────────────┐
│ opencode SQLite DB               │
│ (per-message model tracking)     │
│ modelID + providerID per msg     │
└──────────┬───────────────────────┘
           │ read-only query (10s cache)
           ▼
┌─────────────────────┐         ┌──────────────────┐
│  status-server.js   │◄─poll──│  Dashboard HTML   │
│  GET /status merges │         │  updateCards()    │
│  status.json + DB   │──json──►│  renders model    │
└─────────────────────┘         │  tag dynamically  │
                                └──────────────────┘
```

## Verification

After implementation, verify with this sequence:

1. **Start the server**: `npm start` — should see no errors about the opencode DB (or a warning if it's not found, which is fine)
2. **Open the dashboard**: `http://localhost:3747` — model tags should show fallback defaults initially
3. **Start an opencode agent** (e.g., planner) — after a prompt/response, within 10 seconds the dashboard card should show the model from the DB
4. **Switch models mid-session**: In the opencode agent, switch to a different model and send a prompt. Within 10 seconds, the dashboard model tag should update to reflect the new model.
5. **Coder card**: Should continue showing its hardcoded "GPT-5.3 Codex" — no DB data for coder is expected.
6. **Modal**: Click an agent card — the modal subtitle should show the live model, not the hardcoded one.

## Edge Cases

- **opencode DB doesn't exist**: Server starts normally, model tags show defaults. No crash.
- **opencode DB is locked**: Query fails silently, returns cached data. No crash.
- **Agent never used**: No DB rows for that agent — model tag shows `defaultModel` from AGENTS config.
- **Server restarts**: Cache is cold, first request queries the DB. Subsequent requests use cache.

## Notes

- The coder agent (gh copilot) is intentionally excluded from DB queries. It will be migrated to opencode in the future, at which point it will automatically get live model tracking with no additional changes.
- Only one new npm dependency: `better-sqlite3`. No changes to wrapper scripts or agent definitions.
