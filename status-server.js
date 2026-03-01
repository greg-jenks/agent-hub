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

// --- Persistence and constants ---

const STATUS_FILE = path.join(__dirname, 'status.json');
const FEED_FILE = path.join(__dirname, 'feed.json');
const OPENCODE_DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

const VALID_AGENTS = ['planner', 'coder', 'reviewer', 'refactor'];
const VALID_STATES = ['idle', 'active', 'attention', 'done', 'error'];
const OPENCODE_AGENTS = ['planner', 'reviewer', 'refactor'];
const MAX_FEED_ITEMS = 50;
const MAX_ACTIVITY_ITEMS = 10;
const STATUS_FLUSH_INTERVAL = 5000;
const ACTIVITY_POLL_INTERVAL = 2000;

const MODEL_CACHE_TTL = 30_000;
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
      SELECT
        json_extract(m.data, '$.agent') as agent,
        json_extract(m.data, '$.modelID') as model,
        json_extract(m.data, '$.providerID') as provider
      FROM message m
      WHERE json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(m.data, '$.agent') IN ('planner','reviewer','refactor')
        AND m.time_created = (
          SELECT MAX(time_created)
          FROM message m2
          WHERE json_extract(m2.data, '$.role') = 'assistant'
            AND json_extract(m2.data, '$.agent') = json_extract(m.data, '$.agent')
        )
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

// --- In-memory state ---

let agentState = null;
let feedBuffer = [];
const activityBuffers = Object.fromEntries(VALID_AGENTS.map((agent) => [agent, []]));
let lastSeenTimestamps = {};
const sseClients = new Set();

function initState() {
  agentState = readJSON(STATUS_FILE, getDefaultStatus());
  feedBuffer = readJSON(FEED_FILE, []);
}

function getState() {
  return agentState;
}

function updateAgentState(agent, updates) {
  if (!agentState?.agents?.[agent]) return;
  Object.assign(agentState.agents[agent], updates);
  agentState.agents[agent].updated = new Date().toISOString();
}

function buildStatusSnapshot() {
  const status = JSON.parse(JSON.stringify(getState()));
  const models = getLatestModels();

  for (const [agent, modelInfo] of Object.entries(models)) {
    if (status.agents[agent] && !status.agents[agent].model) {
      status.agents[agent].model = modelInfo.model;
      status.agents[agent].provider = modelInfo.provider;
    }
  }

  for (const agent of VALID_AGENTS) {
    if (status.agents[agent]) {
      status.agents[agent].recentActivity = activityBuffers[agent].slice(0, 3);
    }
  }

  return status;
}

function broadcastSSE(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const deadClients = [];
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      deadClients.push(client);
    }
  }
  for (const client of deadClients) {
    sseClients.delete(client);
  }
}

function addFeedItem(item) {
  const feedItem = {
    agent: item.agent,
    type: item.type || 'info',
    message: item.message || '',
    time: item.time || new Date().toISOString()
  };

  feedBuffer.unshift(feedItem);
  if (feedBuffer.length > MAX_FEED_ITEMS) {
    feedBuffer.length = MAX_FEED_ITEMS;
  }

  broadcastSSE({ type: 'feed', item: feedItem });
}

function summarizeContent(rawContent) {
  if (!rawContent) return '';

  let contentSummary = '';
  try {
    const parsed = JSON.parse(rawContent);
    if (Array.isArray(parsed)) {
      const textBlock = parsed.find((block) => block?.type === 'text');
      contentSummary = textBlock?.text || '';
    } else if (typeof parsed === 'string') {
      contentSummary = parsed;
    } else if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
      contentSummary = parsed.text;
    }
  } catch {
    contentSummary = String(rawContent);
  }

  if (contentSummary.length > 500) {
    contentSummary = `${contentSummary.substring(0, 500)}...`;
  }

  return contentSummary;
}

function pollOpenCodeActivity() {
  if (!opencodeDb) return;

  try {
    for (const agent of OPENCODE_AGENTS) {
      const lastSeen = lastSeenTimestamps[agent] || '1970-01-01T00:00:00Z';
      const rows = opencodeDb.prepare(`
        SELECT
          json_extract(data, '$.role') as role,
          json_extract(data, '$.modelID') as model,
          json_extract(data, '$.providerID') as provider,
          json_extract(data, '$.content') as content,
          time_created
        FROM message
        WHERE json_extract(data, '$.agent') = ?
          AND json_extract(data, '$.role') IN ('user', 'assistant')
          AND time_created > ?
        ORDER BY time_created ASC
      `).all(agent, lastSeen);

      for (const row of rows) {
        lastSeenTimestamps[agent] = row.time_created;
        const activityType = row.role === 'user' ? 'prompt' : (row.role === 'assistant' ? 'response' : 'info');
        const contentSummary = summarizeContent(row.content);
        const shortSummary = contentSummary.substring(0, 100) + (contentSummary.length > 100 ? '...' : '');

        const activity = {
          type: activityType,
          content: contentSummary,
          model: row.model || undefined,
          timestamp: row.time_created
        };

        activityBuffers[agent].unshift(activity);
        if (activityBuffers[agent].length > MAX_ACTIVITY_ITEMS) {
          activityBuffers[agent].length = MAX_ACTIVITY_ITEMS;
        }

        if (activityType === 'prompt') {
          const truncated = contentSummary.substring(0, 60);
          updateAgentState(agent, {
            state: 'active',
            message: `Working on: ${truncated}${contentSummary.length > 60 ? '...' : ''}`,
            lastActivity: row.time_created
          });
        } else if (activityType === 'response') {
          updateAgentState(agent, {
            state: 'active',
            message: 'Responded',
            lastActivity: row.time_created
          });
          if (row.model) {
            updateAgentState(agent, { model: row.model, provider: row.provider });
          }
        }

        addFeedItem({
          agent,
          type: activityType,
          message: shortSummary,
          time: row.time_created
        });

        broadcastSSE({
          type: 'agent-update',
          agent,
          data: {
            ...agentState.agents[agent],
            recentActivity: activityBuffers[agent].slice(0, 3)
          }
        });
      }
    }
  } catch (e) {
    if (e.message && !e.message.includes('SQLITE_BUSY')) {
      console.warn('[activity-poll] Error:', e.message);
    }
  }
}

function flushToDisk() {
  try {
    writeJSON(STATUS_FILE, agentState);
    writeJSON(FEED_FILE, feedBuffer);
  } catch (e) {
    console.warn('[flush] Failed to write state files:', e.message);
  }
}

// --- Routes ---

app.get('/status', (req, res) => {
  res.json(buildStatusSnapshot());
});

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[sse] Client connected (${sseClients.size} active)`);

  res.write(`data: ${JSON.stringify({ type: 'init', status: buildStatusSnapshot(), feed: feedBuffer.slice(0, MAX_FEED_ITEMS) })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[sse] Client disconnected (${sseClients.size} active)`);
  });
});

app.post('/status', (req, res) => {
  const { agent, state, message } = req.body;

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

  updateAgentState(agent, {
    state,
    message: message || ''
  });

  addFeedItem({
    agent,
    type: 'lifecycle',
    message: message || `State changed to ${state}`,
    time: new Date().toISOString()
  });

  broadcastSSE({
    type: 'agent-update',
    agent,
    data: {
      ...agentState.agents[agent],
      recentActivity: activityBuffers[agent].slice(0, 3)
    }
  });

  console.log(`[status] ${agent} → ${state}: ${message || '(no message)'}`);
  res.json({ ok: true, agent, state });
});

app.get('/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, MAX_FEED_ITEMS);
  res.json(feedBuffer.slice(0, limit));
});

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
  initState();

  setInterval(flushToDisk, STATUS_FLUSH_INTERVAL);
  process.on('SIGINT', () => {
    flushToDisk();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    flushToDisk();
    process.exit(0);
  });

  if (!fs.existsSync(STATUS_FILE)) {
    writeJSON(STATUS_FILE, agentState);
    console.log('  Created status.json with defaults');
  }
  if (!fs.existsSync(FEED_FILE)) {
    writeJSON(FEED_FILE, feedBuffer);
    console.log('  Created feed.json');
  }

  if (opencodeDb) {
    try {
      const latest = opencodeDb.prepare(`
        SELECT json_extract(data, '$.agent') as agent, MAX(time_created) as latest
        FROM message
        WHERE json_extract(data, '$.agent') IN ('planner', 'reviewer', 'refactor')
        GROUP BY json_extract(data, '$.agent')
      `).all();

      for (const row of latest) {
        lastSeenTimestamps[row.agent] = row.latest;
      }
      console.log('[activity-poll] Initialized timestamps, polling every 2s');
    } catch (e) {
      console.warn('[activity-poll] Could not initialize timestamps:', e.message);
    }
    setInterval(pollOpenCodeActivity, ACTIVITY_POLL_INTERVAL);
  }

  console.log(`
  ╔═══════════════════════════════════════╗
  ║     AGENT HUB — Status Server        ║
  ║     http://localhost:${PORT}             ║
  ╚═══════════════════════════════════════╝

  Endpoints:
    GET  /          → Dashboard HTML
    GET  /status    → Agent status JSON
    GET  /stream    → SSE event stream
    POST /status    → Update agent status
    GET  /feed      → Activity feed JSON

  POST /status body example:
    { "agent": "planner", "state": "active", "message": "Session started" }

  Valid agents: ${VALID_AGENTS.join(', ')}
  Valid states: ${VALID_STATES.join(', ')}
  `);
});
