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
const COPILOT_SESSION_STATE_DIR = path.join(os.homedir(), '.copilot', 'session-state');
const LEARNINGS_DB_PATH = process.env.LEARNINGS_DB_PATH
  || path.join(__dirname, '..', 'learnings-mcp', 'data', 'learnings.db');
const QMD_DB_PATH = process.env.QMD_DB_PATH
  || path.join(os.homedir(), '.cache', 'qmd', 'index.sqlite');

const VALID_AGENTS = ['planner', 'coder', 'reviewer', 'refactor'];
const VALID_STATES = ['idle', 'active', 'attention', 'done', 'error'];
const OPENCODE_AGENTS = ['planner', 'reviewer', 'refactor']; // Agents using opencode DB
// Note: 'coder' uses pollCopilotActivity() instead of pollOpenCodeActivity().
const MAX_FEED_ITEMS = 50;
const MAX_ACTIVITY_ITEMS = 10;
const STATUS_FLUSH_INTERVAL = 5000;
const ACTIVITY_POLL_INTERVAL = 2000;
const COPILOT_TOOL_APPROVAL_WAIT_MS = 2500;

const MODEL_CACHE_TTL = 30_000;
const LEARNINGS_CACHE_TTL = 30_000;
const LEARNINGS_MAX_FETCH = 50;
const QMD_DEFAULT_LIMIT = 20;
const QMD_MAX_LIMIT = 50;

// Patterns that indicate the agent is asking a question or needs user input.
// Checked against the last ~1500 chars of the agent's response.
const ATTENTION_PATTERNS = [
  /\?\s*$/,
  /\bshould I\b.*\?\s*$/im,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\b(permission|approval)\s+(required|needed)\b/i,
  /\bneeds?\s+permission\b/i,
  /\bplease\s+approve\b/i,
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
  const hasQmdDb = Object.prototype.hasOwnProperty.call(config, 'qmdDb');

  const statusFile = config.statusFile || STATUS_FILE;
  const feedFile = config.feedFile || FEED_FILE;
  const copilotSessionStateDir = config.copilotSessionStateDir || COPILOT_SESSION_STATE_DIR;

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

  let qmdDb = hasQmdDb ? config.qmdDb : null;
  if (!hasQmdDb) {
    try {
      qmdDb = new Database(QMD_DB_PATH, { readonly: true, fileMustExist: true });
    } catch (e) {
      console.warn(`[qmd] Could not open QMD DB at ${QMD_DB_PATH}: ${e.message}`);
    }
  }

  let modelCache = { data: {}, timestamp: 0 };
  let learningsCache = { data: [], timestamp: 0 };

  // --- In-memory state ---

  let agentState = null;
  let feedBuffer = [];
  const activityBuffers = Object.fromEntries(VALID_AGENTS.map((agent) => [agent, []]));
  let lastSeenTimestamps = {};
  let copilotLastEventIndex = 0;
  let copilotSessionId = null;
  let copilotTurnContext = {
    hasToolCalls: false,
    lastReasoningText: '',
    lastIntentMessage: '',
    requestedUserInput: false,
    turnToolCount: 0
  };
  const copilotPendingAskUserToolCallIds = new Set();
  const copilotPendingToolExecutions = new Map();
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

  function searchQmdDocs(query, limit = QMD_DEFAULT_LIMIT) {
    if (!qmdDb || !query || !query.trim()) {
      return [];
    }

    const parsedLimit = parseInt(limit, 10);
    const safeLimit = Math.min(
      Number.isNaN(parsedLimit) ? QMD_DEFAULT_LIMIT : parsedLimit,
      QMD_MAX_LIMIT
    );

    try {
      const sanitized = query
        .trim()
        .split(/\s+/)
        .filter(t => t.length > 0)
        .map(t => `"${t.replace(/"/g, '""')}"`)
        .join(' ');

      if (!sanitized) {
        return [];
      }

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

  function resetCopilotTurnContext() {
    copilotTurnContext = {
      hasToolCalls: false,
      lastReasoningText: '',
      lastIntentMessage: '',
      requestedUserInput: false,
      turnToolCount: 0
    };
    copilotPendingAskUserToolCallIds.clear();
    copilotPendingToolExecutions.clear();
  }

  function evaluateCopilotPendingToolApproval(nowMs = Date.now()) {
    if (copilotTurnContext.requestedUserInput || copilotPendingToolExecutions.size === 0) {
      return;
    }

    let oldest = null;
    for (const pending of copilotPendingToolExecutions.values()) {
      if (!oldest || pending.startedAtMs < oldest.startedAtMs) {
        oldest = pending;
      }
    }
    if (!oldest || nowMs - oldest.startedAtMs < COPILOT_TOOL_APPROVAL_WAIT_MS) {
      return;
    }

    const message = oldest.toolName
      ? `Waiting for approval: ${oldest.toolName}`
      : 'Waiting for command approval';
    const current = agentState?.agents?.coder;
    if (current?.state === 'attention' && current?.substatus === 'awaiting-input' && current?.message === message) {
      return;
    }

    updateAgentState('coder', {
      state: 'attention',
      substatus: 'awaiting-input',
      toolName: null,
      message
    });
    addFeedItem({
      agent: 'coder',
      type: 'info',
      message,
      time: new Date(nowMs).toISOString()
    });
    broadcastSubstatusUpdate('coder');
  }

  function checkCopilotNeedsAttention() {
    if (copilotTurnContext.requestedUserInput) {
      return true;
    }

    if (copilotTurnContext.lastReasoningText) {
      const matched = ATTENTION_PATTERNS.find((pattern) => pattern.test(copilotTurnContext.lastReasoningText));
      if (matched) return true;
    }

    if (copilotTurnContext.lastIntentMessage) {
      const intent = copilotTurnContext.lastIntentMessage.toLowerCase();
      if (intent.includes('question') || intent.includes('clarif') || intent.includes('confirm')) {
        return true;
      }
    }

    return false;
  }

  function findActiveCopilotSession() {
    try {
      if (!fs.existsSync(copilotSessionStateDir)) return null;
      const dirs = fs.readdirSync(copilotSessionStateDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());

      let bestSession = null;
      let bestTime = null;

      for (const dir of dirs) {
        const workspacePath = path.join(copilotSessionStateDir, dir.name, 'workspace.yaml');
        if (!fs.existsSync(workspacePath)) continue;

        const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
        const match = workspaceContent.match(/updated_at:\s*(.+)/);
        if (!match) continue;

        const updatedAt = new Date(match[1].trim());
        if (Number.isNaN(updatedAt.getTime())) continue;
        if (!bestTime || updatedAt > bestTime) {
          bestTime = updatedAt;
          bestSession = dir.name;
        }
      }

      return bestSession;
    } catch {
      return null;
    }
  }

  function initCopilotEventIndex(eventsPath) {
    try {
      const content = fs.readFileSync(eventsPath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());
      copilotLastEventIndex = lines.length;

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const event = JSON.parse(lines[i]);
          if (event.type === 'session.start' && event.data?.selectedModel) {
            updateAgentState('coder', { model: event.data.selectedModel, provider: 'github-copilot' });
            broadcastSubstatusUpdate('coder');
            break;
          }
        } catch {
          // ignore parse errors while backtracking
        }
      }
    } catch {
      copilotLastEventIndex = 0;
    }
  }

  function processCopilotEvent(event) {
    const { type, data = {}, timestamp = new Date().toISOString() } = event;

    switch (type) {
      case 'session.start': {
        if (data.selectedModel) {
          updateAgentState('coder', { model: data.selectedModel, provider: 'github-copilot' });
          broadcastSubstatusUpdate('coder');
        }
        break;
      }
      case 'user.message': {
        const content = data.content || '';
        const truncated = content.substring(0, 60);
        activityBuffers.coder.unshift({
          type: 'prompt',
          content: content.substring(0, 500),
          timestamp
        });
        if (activityBuffers.coder.length > MAX_ACTIVITY_ITEMS) {
          activityBuffers.coder.length = MAX_ACTIVITY_ITEMS;
        }

        updateAgentState('coder', {
          state: 'active',
          substatus: 'thinking',
          message: `Working on: ${truncated}${content.length > 60 ? '...' : ''}`,
          lastActivity: timestamp
        });

        addFeedItem({
          agent: 'coder',
          type: 'prompt',
          message: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
          time: timestamp
        });
        broadcastSubstatusUpdate('coder');
        break;
      }
      case 'assistant.turn_start': {
        resetCopilotTurnContext();
        updateAgentState('coder', { substatus: 'thinking', toolName: null });
        broadcastSubstatusUpdate('coder');
        break;
      }
      case 'assistant.message': {
        const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        const askUserCall = toolRequests.find((tool) => tool.name === 'ask_user');
        const intentCall = toolRequests.find((tool) => tool.name === 'report_intent');
        if (intentCall?.arguments) {
          try {
            const parsed = typeof intentCall.arguments === 'string'
              ? JSON.parse(intentCall.arguments)
              : intentCall.arguments;
            if (parsed?.intent) {
              copilotTurnContext.lastIntentMessage = parsed.intent;
              updateAgentState('coder', { message: parsed.intent, substatus: 'thinking' });
              addFeedItem({
                agent: 'coder',
                type: 'info',
                message: parsed.intent,
                time: timestamp
              });
            }
          } catch {
            // ignore malformed report_intent args
          }
        }

        if (askUserCall && !copilotTurnContext.requestedUserInput) {
          copilotTurnContext.requestedUserInput = true;
          if (askUserCall.toolCallId) {
            copilotPendingAskUserToolCallIds.add(askUserCall.toolCallId);
          }
          updateAgentState('coder', {
            state: 'attention',
            substatus: 'awaiting-input',
            toolName: null,
            message: 'Waiting for your response'
          });
          addFeedItem({
            agent: 'coder',
            type: 'info',
            message: 'Awaiting your input',
            time: timestamp
          });
        }

        const realTools = toolRequests.filter(
          (tool) => tool.name !== 'report_intent' && tool.name !== 'ask_user'
        );
        if (realTools.length > 0) {
          copilotTurnContext.hasToolCalls = true;
          updateAgentState('coder', {
            substatus: 'tool',
            toolName: realTools[0].name || 'unknown'
          });
        }

        if (data.reasoningText) {
          const reasoning = String(data.reasoningText).replace(/^\*\*|\*\*$/g, '').trim();
          copilotTurnContext.lastReasoningText = reasoning;
          if (reasoning) {
            addFeedItem({
              agent: 'coder',
              type: 'info',
              message: `Thinking: ${reasoning.substring(0, 80)}`,
              time: timestamp
            });
          }
        }

        broadcastSubstatusUpdate('coder');
        break;
      }
      case 'tool.execution_start': {
        const toolName = data.toolName || 'unknown';
        if (toolName === 'ask_user') {
          if (!copilotTurnContext.requestedUserInput) {
            copilotTurnContext.requestedUserInput = true;
            if (data.toolCallId) {
              copilotPendingAskUserToolCallIds.add(data.toolCallId);
            }
            updateAgentState('coder', {
              state: 'attention',
              substatus: 'awaiting-input',
              toolName: null,
              message: 'Waiting for your response'
            });
            addFeedItem({
              agent: 'coder',
              type: 'info',
              message: 'Awaiting your input',
              time: timestamp
            });
          }
          broadcastSubstatusUpdate('coder');
          break;
        }
        if (toolName !== 'report_intent') {
          const startedAtMs = Number.isNaN(Date.parse(timestamp)) ? Date.now() : Date.parse(timestamp);
          const pendingKey = data.toolCallId || `name:${toolName}`;
          copilotPendingToolExecutions.set(pendingKey, { toolName, startedAtMs });
        }
        copilotTurnContext.turnToolCount += 1;
        updateAgentState('coder', { substatus: 'tool', toolName });
        if (toolName !== 'report_intent') {
          addFeedItem({
            agent: 'coder',
            type: 'tool',
            message: `Running: ${toolName}`,
            time: timestamp
          });
        }
        broadcastSubstatusUpdate('coder');
        break;
      }
      case 'tool.execution_complete': {
        const completedToolCallId = data.toolCallId || null;
        if (completedToolCallId && copilotPendingAskUserToolCallIds.has(completedToolCallId)) {
          copilotPendingAskUserToolCallIds.delete(completedToolCallId);
          copilotTurnContext.requestedUserInput = false;
          updateAgentState('coder', {
            state: 'active',
            substatus: 'thinking',
            toolName: null,
            message: 'Continuing...'
          });
          addFeedItem({
            agent: 'coder',
            type: 'info',
            message: 'Input received; continuing',
            time: timestamp
          });
          broadcastSubstatusUpdate('coder');
          break;
        }
        if (completedToolCallId) {
          copilotPendingToolExecutions.delete(completedToolCallId);
        } else if (data.toolName) {
          for (const [key, pending] of copilotPendingToolExecutions.entries()) {
            if (pending.toolName === data.toolName) {
              copilotPendingToolExecutions.delete(key);
              break;
            }
          }
        }
        if (copilotTurnContext.requestedUserInput && agentState?.agents?.coder?.state === 'attention') {
          break;
        }
        if (agentState?.agents?.coder?.state === 'attention' && copilotPendingToolExecutions.size === 0) {
          updateAgentState('coder', { state: 'active', message: 'Continuing...' });
        }
        if (data.model) {
          updateAgentState('coder', { model: data.model, provider: 'github-copilot' });
        }
        updateAgentState('coder', { substatus: 'thinking', toolName: null });
        broadcastSubstatusUpdate('coder');
        break;
      }
      case 'assistant.turn_end': {
        copilotPendingToolExecutions.clear();
        if (checkCopilotNeedsAttention()) {
          updateAgentState('coder', {
            state: 'attention',
            substatus: 'awaiting-input',
            toolName: null,
            message: 'Waiting for your response'
          });
        } else {
          updateAgentState('coder', {
            substatus: 'awaiting-input',
            toolName: null
          });
        }

        activityBuffers.coder.unshift({
          type: 'response',
          content: 'Turn completed',
          model: agentState?.agents?.coder?.model,
          timestamp
        });
        if (activityBuffers.coder.length > MAX_ACTIVITY_ITEMS) {
          activityBuffers.coder.length = MAX_ACTIVITY_ITEMS;
        }

        broadcastSubstatusUpdate('coder');
        break;
      }
      default:
        break;
    }
  }

  function pollCopilotActivity() {
    const reportedSessionId = agentState?.agents?.coder?.sessionId || null;
    let sessionId = reportedSessionId || copilotSessionId;
    if (!sessionId) {
      sessionId = findActiveCopilotSession();
      if (!sessionId) return;
    }

    const eventsPath = path.join(copilotSessionStateDir, sessionId, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) {
      if (sessionId === copilotSessionId) {
        copilotSessionId = null;
        copilotLastEventIndex = 0;
      }
      return;
    }

    if (sessionId !== copilotSessionId) {
      copilotSessionId = sessionId;
      resetCopilotTurnContext();
      initCopilotEventIndex(eventsPath);
      return;
    }

    let lines;
    try {
      const content = fs.readFileSync(eventsPath, 'utf8');
      lines = content.split('\n').filter((line) => line.trim());
    } catch {
      return;
    }

    if (lines.length <= copilotLastEventIndex) {
      evaluateCopilotPendingToolApproval();
      return;
    }
    const newLines = lines.slice(copilotLastEventIndex);

    for (let i = 0; i < newLines.length; i += 1) {
      try {
        const event = JSON.parse(newLines[i]);
        processCopilotEvent(event);
        copilotLastEventIndex += 1;
      } catch {
        break;
      }
    }
    evaluateCopilotPendingToolApproval();
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
    const { agent, state, message, sessionId } = req.body;

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
    if (sessionId) {
      updates.sessionId = sessionId;
    }
    updateAgentState(agent, updates);

    if (agent === 'coder' && state !== 'active') {
      copilotSessionId = null;
      copilotLastEventIndex = 0;
      resetCopilotTurnContext();
    }

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

  app.post('/agents/:agent/resync', (req, res) => {
    const { agent } = req.params;

    if (!agent || !VALID_AGENTS.includes(agent)) {
      return res.status(400).json({
        error: `Invalid agent. Must be one of: ${VALID_AGENTS.join(', ')}`
      });
    }

    if (agent === 'coder') {
      copilotSessionId = null;
      copilotLastEventIndex = 0;
      resetCopilotTurnContext();
      pollCopilotActivity();
    } else if (opencodeDb) {
      delete lastSeenTimestamps[agent];
      pollOpenCodeActivity();
    }

    addFeedItem({
      agent,
      type: 'info',
      message: 'Manual resync requested',
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

    res.json({
      ok: true,
      agent,
      status: buildStatusSnapshot()
    });
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

  app.get('/qmd/search', (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) {
      return res.json([]);
    }
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isNaN(parsedLimit) ? QMD_DEFAULT_LIMIT : parsedLimit;
    return res.json(searchQmdDocs(query, limit));
  });

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

      return res.json({
        id: docId,
        path: row.path,
        title: row.title,
        content: row.content
      });
    } catch (e) {
      console.warn('[qmd] Failed to fetch document:', e.message);
      return res.status(500).json({ error: 'Failed to fetch document' });
    }
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
  if (!config.skipPolling) {
    intervals.push(setInterval(() => {
      const coderState = agentState?.agents?.coder?.state;
      if (coderState === 'active' || coderState === 'attention') {
        pollCopilotActivity();
      }
    }, ACTIVITY_POLL_INTERVAL));
  }

  return {
    app,
    getState,
    pollOpenCodeActivity,
    pollCopilotActivity,
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
    GET  /qmd/search → Search QMD docs (FTS5)
    GET  /qmd/doc/:id → Get full document content

  POST /status body example:
    { "agent": "planner", "state": "active", "message": "Session started" }

  Valid agents: ${VALID_AGENTS.join(', ')}
  Valid states: ${VALID_STATES.join(', ')}
  Learnings DB: ${process.env.LEARNINGS_DB_PATH || LEARNINGS_DB_PATH}
  QMD DB: ${process.env.QMD_DB_PATH || QMD_DB_PATH}
  `);
  });
}

module.exports = { createApp, VALID_AGENTS, VALID_STATES, ATTENTION_PATTERNS };
