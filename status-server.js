const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3747;

app.use(cors());
app.use(express.json());

// --- File-based persistence ---

const STATUS_FILE = path.join(__dirname, 'status.json');
const FEED_FILE = path.join(__dirname, 'feed.json');
const OPENCODE_DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

const VALID_AGENTS = ['planner', 'coder', 'reviewer', 'refactor'];
const VALID_STATES = ['idle', 'active', 'attention', 'done', 'error'];

const MODEL_CACHE_TTL = 10_000;
let modelCache = { data: {}, timestamp: 0 };

let opencodeDb = null;
try {
  opencodeDb = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.warn(`[model-query] Could not open opencode DB at ${OPENCODE_DB_PATH}: ${e.message}`);
}

function getLatestModels() {
  const now = Date.now();
  if (now - modelCache.timestamp < MODEL_CACHE_TTL) {
    return modelCache.data;
  }

  if (!opencodeDb) {
    return modelCache.data;
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
    return modelCache.data;
  }
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Initialize status if missing
function getDefaultStatus() {
  const now = new Date().toISOString();
  const agents = {};
  for (const name of VALID_AGENTS) {
    agents[name] = {
      state: 'idle',
      message: '',
      updated: now
    };
  }
  return { agents, serverStarted: now };
}

function loadStatus() {
  return readJSON(STATUS_FILE, getDefaultStatus());
}

function loadFeed() {
  return readJSON(FEED_FILE, []);
}

// --- Routes ---

// GET /status — Dashboard polls this every 5s
app.get('/status', (req, res) => {
  const status = loadStatus();
  const models = getLatestModels();

  for (const [agent, modelInfo] of Object.entries(models)) {
    if (status.agents[agent]) {
      status.agents[agent].model = modelInfo.model;
      status.agents[agent].provider = modelInfo.provider;
    }
  }

  res.json(status);
});

// POST /status — Wrapper scripts call this on agent start/stop
// Body: { agent: "planner", state: "active", message: "Session started" }
app.post('/status', (req, res) => {
  const { agent, state, message } = req.body;

  // Validate
  if (!agent || !VALID_AGENTS.includes(agent)) {
    return res.status(400).json({
      error: `Invalid agent. Must be one of: ${VALID_AGENTS.join(', ')}`
    });
  }
  if (!state || !VALID_STATES.includes(state)) {
    return res.status(400).json({
      error: `Invalid state. Must be one of: ${VALID_STATES.join(', ')}`
    });
  }

  const now = new Date().toISOString();
  const status = loadStatus();
  status.agents[agent] = {
    state,
    message: message || '',
    updated: now
  };
  writeJSON(STATUS_FILE, status);

  // Also add to feed
  const feed = loadFeed();
  feed.unshift({
    agent,
    state,
    message: message || `State changed to ${state}`,
    time: now
  });
  // Keep last 50 feed items
  if (feed.length > 50) feed.length = 50;
  writeJSON(FEED_FILE, feed);

  console.log(`[${now}] ${agent} → ${state}: ${message || '(no message)'}`);
  res.json({ ok: true, agent, state });
});

// GET /feed — Activity log
app.get('/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const feed = loadFeed();
  res.json(feed.slice(0, limit));
});

// POST /feed — Direct feed entry (e.g., manual notes)
app.post('/feed', (req, res) => {
  const { agent, message } = req.body;
  if (!agent || !message) {
    return res.status(400).json({ error: 'agent and message required' });
  }
  if (!VALID_AGENTS.includes(agent)) {
    return res.status(400).json({
      error: `Invalid agent. Must be one of: ${VALID_AGENTS.join(', ')}`
    });
  }

  const feed = loadFeed();
  feed.unshift({
    agent,
    state: 'info',
    message,
    time: new Date().toISOString()
  });
  if (feed.length > 50) feed.length = 50;
  writeJSON(FEED_FILE, feed);

  res.json({ ok: true });
});

// Serve dashboard HTML
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'agent-hub.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.status(404).send('agent-hub.html not found. Place it in the project root.');
  }
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     AGENT HUB — Status Server        ║
  ║     http://localhost:${PORT}             ║
  ╚═══════════════════════════════════════╝

  Endpoints:
    GET  /          → Dashboard HTML
    GET  /status    → Agent status JSON
    POST /status    → Update agent status
    GET  /feed      → Activity feed JSON
    POST /feed      → Add feed entry

  POST /status body example:
    { "agent": "planner", "state": "active", "message": "Session started" }

  Valid agents: ${VALID_AGENTS.join(', ')}
  Valid states: ${VALID_STATES.join(', ')}
  `);

  // Ensure status file exists with defaults
  if (!fs.existsSync(STATUS_FILE)) {
    writeJSON(STATUS_FILE, getDefaultStatus());
    console.log('  Created status.json with defaults\n');
  }
  if (!fs.existsSync(FEED_FILE)) {
    writeJSON(FEED_FILE, []);
    console.log('  Created feed.json\n');
  }
});
