const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 3747;

// --- Persistence and constants ---

const STATUS_FILE = path.join(__dirname, 'status.json');
const FEED_FILE = path.join(__dirname, 'feed.json');
const OPENCODE_DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const LEARNINGS_DB_PATH = process.env.LEARNINGS_DB_PATH
  || path.join(__dirname, '..', 'learnings-mcp', 'data', 'learnings.db');

const VALID_AGENTS = ['planner', 'coder', 'reviewer', 'refactor'];
const VALID_STATES = ['idle', 'active', 'attention', 'done', 'error'];
const OPENCODE_AGENTS = ['planner', 'reviewer', 'refactor'];
const MAX_FEED_ITEMS = 50;
const MAX_ACTIVITY_ITEMS = 10;
const STATUS_FLUSH_INTERVAL = 5000;
const ACTIVITY_POLL_INTERVAL = 2000;

const MODEL_CACHE_TTL = 30_000;
const LEARNINGS_CACHE_TTL = 30_000;
const LEARNINGS_MAX_FETCH = 50;

// Patterns that indicate the agent is asking a question or needs user input.
// Checked against the last ~1500 chars of the agent's response.
const ATTENTION_PATTERNS = [
  /\?\s*$/,
  /\bshould I\b.*\?\s*$/im,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bplease (confirm|clarify|let me know|provide|specify)\b/i,
  /\blet me know\b.*\?\s*$/im,
  /\bneed from you\b/i,
  /\bwhat do you think\b/i,
  /\bwhat would you prefer\b/i,
  /\bcan you (confirm|clarify|provide|specify)\b/i,
  /\bwaiting for\b.*\b(input|response|answer|decision|confirmation)\b/i,
  /\bhow would you like\b/i,
  /\bwhich (option|approach|one)\b.*\?\s*$/im
];

function createApp(config = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const hasOpenCodeDb = Object.prototype.hasOwnProperty.call(config, 'opencodeDb');
  const hasLearningsDb = Object.prototype.hasOwnProperty.call(config, 'learningsDb');

  const statusFile = config.statusFile || STATUS_FILE;
  const feedFile = config.feedFile || FEED_FILE;

  let opencodeDb = hasOpenCodeDb ? config.opencodeDb : null;
  if (!hasOpenCodeDb) {
    try {
      opencodeDb = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (e) {
      console.warn(`[model-query] Could not open opencode DB at ${OPENCODE_DB_PATH}: ${e.message}`);
    }
  }

  let learningsDb = hasLearningsDb ? config.learningsDb : null;
  if (!hasLearningsDb) {
    try {
      learningsDb = new Database(LEARNINGS_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (e) {
      console.warn(`[learnings] Could not open learnings DB at ${LEARNINGS_DB_PATH}: ${e.message}`);
    }
  }

  let modelCache = { data: {}, timestamp: 0 };
  let learningsCache = { data: [], timestamp: 0 };

  // --- In-memory state ---

  let agentState = null;
  let feedBuffer = [];
  const activityBuffers = Object.fromEntries(VALID_AGENTS.map((agent) => [agent, []]));
  let lastSeenTimestamps = {};
  const sseClients = new Set();
  const intervals = [];

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

  function initState() {
    agentState = readJSON(statusFile, getDefaultStatus());
    feedBuffer = readJSON(feedFile, []);
  }

  function getState() {
    return agentState;
  }

  function updateAgentState(agent, updates) {
    if (!agentState?.agents?.[agent]) return;
    Object.assign(agentState.agents[agent], updates);
    agentState.agents[agent].updated = new Date().toISOString();
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

  function checkNeedsAttention(db, agent) {
    try {
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

      const tail = lastText.text.slice(-1500);
      const matched = ATTENTION_PATTERNS.find((pattern) => pattern.test(tail));
      if (matched) {
        console.log(`[attention] ${agent}: matched ${matched} on: "${tail.slice(-80)}"`);
        return true;
      }

      return false;
    } catch {
      return false;
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

  function pollAgentSubstatus() {
    if (!opencodeDb) return;

    try {
      for (const agent of OPENCODE_AGENTS) {
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

        const currentState = agentState?.agents?.[agent]?.state;
        if (currentState !== 'active' && currentState !== 'attention') {
          if (agentState?.agents?.[agent]?.substatus || agentState?.agents?.[agent]?.toolName) {
            updateAgentState(agent, { substatus: null, toolName: null });
            broadcastSubstatusUpdate(agent);
          }
          continue;
        }
        if (currentState === 'attention') continue;

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
              newSubstatus = 'thinking';
            }
            break;
          case 'text':
            newSubstatus = 'responding';
            break;
          case 'step-finish':
            if (latestPart.reason === 'stop') {
              const prev = agentState?.agents?.[agent];
              if (prev?.substatus !== 'awaiting-input' && prev?.state !== 'attention') {
                if (checkNeedsAttention(opencodeDb, agent)) {
                  updateAgentState(agent, {
                    state: 'attention',
                    substatus: 'awaiting-input',
                    toolName: null,
                    message: 'Waiting for your response'
                  });
                  broadcastSubstatusUpdate(agent);
                  continue;
                }
              }
              newSubstatus = 'awaiting-input';
            } else if (latestPart.reason === 'tool-calls') {
              newSubstatus = 'thinking';
            }
            break;
          default:
            continue;
        }

        const previous = agentState?.agents?.[agent];
        if (previous && (previous.substatus !== newSubstatus || previous.toolName !== newToolName)) {
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

      // After processing new messages, update substatus from part table
      pollAgentSubstatus();
    } catch (e) {
      if (e.message && !e.message.includes('SQLITE_BUSY')) {
        console.warn('[activity-poll] Error:', e.message);
      }
    }
  }

  function initLastSeenTimestamps() {
    if (!opencodeDb) return;
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
  }

  function flushToDisk() {
    try {
      writeJSON(statusFile, agentState);
      writeJSON(feedFile, feedBuffer);
    } catch (e) {
      console.warn('[flush] Failed to write state files:', e.message);
    }
  }

  function cleanup() {
    for (const interval of intervals) {
      clearInterval(interval);
    }
    intervals.length = 0;

    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        // ignore client close errors
      }
    }
    sseClients.clear();
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

    res.write(`data: ${JSON.stringify({
      type: 'init',
      status: buildStatusSnapshot(),
      feed: feedBuffer.slice(0, MAX_FEED_ITEMS),
      learnings: getRecentLearnings(20)
    })}\n\n`);

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

    const updates = { state, message: message || '' };
    if (state !== 'active') {
      updates.substatus = null;
      updates.toolName = null;
    }
    updateAgentState(agent, updates);

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

  app.get('/learnings', (req, res) => {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Number.isNaN(parsedLimit) ? 20 : parsedLimit, LEARNINGS_MAX_FETCH);
    res.json(getRecentLearnings(limit));
  });

  app.get('/', (req, res) => {
    const htmlPath = path.join(__dirname, 'agent-hub.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.status(404).send('agent-hub.html not found. Place it in the project root.');
    }
  });

  initState();

  if (!config.skipFlush) {
    intervals.push(setInterval(flushToDisk, STATUS_FLUSH_INTERVAL));
  }

  if (opencodeDb) {
    initLastSeenTimestamps();
    if (!config.skipPolling) {
      intervals.push(setInterval(pollOpenCodeActivity, ACTIVITY_POLL_INTERVAL));
    }
  }

  return {
    app,
    getState,
    pollOpenCodeActivity,
    cleanup,
    checkNeedsAttention,
    summarizeContent
  };
}

if (require.main === module) {
  const { app, getState } = createApp();

  const writeJSON = (filePath, data) => {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  };

  app.listen(PORT, () => {
    if (!fs.existsSync(STATUS_FILE)) {
      writeJSON(STATUS_FILE, getState());
      console.log('  Created status.json with defaults');
    }
    if (!fs.existsSync(FEED_FILE)) {
      writeJSON(FEED_FILE, []);
      console.log('  Created feed.json');
    }

    console.log(`
  ╔═══════════════════════════════════════╗
  ║     AGENT HUB — Status Server        ║
  ║     http://localhost:${PORT}             ║
  ╚═══════════════════════════════════════╝

  Endpoints:
    GET  /          → Dashboard HTML
    GET  /status    → Agent status JSON
    GET  /stream    → SSE event stream (init includes learnings)
    POST /status    → Update agent status
    GET  /feed      → Activity feed JSON
    GET  /learnings → Recent learnings JSON

  POST /status body example:
    { "agent": "planner", "state": "active", "message": "Session started" }

  Valid agents: ${VALID_AGENTS.join(', ')}
  Valid states: ${VALID_STATES.join(', ')}
  Learnings DB: ${process.env.LEARNINGS_DB_PATH || LEARNINGS_DB_PATH}
  `);
  });
}

module.exports = { createApp, VALID_AGENTS, VALID_STATES, ATTENTION_PATTERNS };
