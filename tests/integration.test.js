const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createTestApp } = require('./helpers/create-app');
const { createOpenCodeDb, createLearningsDb, insertMessage, insertPart } = require('./helpers/db-fixtures');

function setupAppWithDb(db, overrides = {}) {
  return createTestApp({ opencodeDb: db, ...overrides });
}

test('pollOpenCodeActivity processes user and assistant messages with buffers', async () => {
  const db = createOpenCodeDb();
  const appCtx = setupAppWithDb(db);

  insertMessage(db, {
    id: 'm1',
    agent: 'planner',
    role: 'user',
    content: JSON.stringify([{ type: 'text', text: 'Please build this feature quickly' }]),
    time: '2026-03-01T00:00:01.000Z'
  });
  insertMessage(db, {
    id: 'm2',
    agent: 'planner',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Done.' }]),
    model: 'gpt-x',
    provider: 'openai',
    time: '2026-03-01T00:00:02.000Z'
  });

  appCtx.pollOpenCodeActivity();

  const status = await request(appCtx.app).get('/status').expect(200);
  assert.equal(status.body.agents.planner.state, 'active');
  assert.equal(status.body.agents.planner.message, 'Responded');
  assert.equal(status.body.agents.planner.model, 'gpt-x');
  assert.equal(status.body.agents.planner.provider, 'openai');
  assert.ok(status.body.agents.planner.recentActivity.length >= 2);

  const feed = await request(appCtx.app).get('/feed?limit=10').expect(200);
  assert.equal(feed.body[0].type, 'response');
  assert.equal(feed.body[1].type, 'prompt');
  assert.ok(feed.body[0].message.length <= 103);

  for (let i = 0; i < 15; i += 1) {
    insertMessage(db, {
      id: `mx-${i}`,
      agent: 'planner',
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: `r-${i}` }]),
      time: `2026-03-01T00:00:${String(i + 10).padStart(2, '0')}.000Z`
    });
  }
  appCtx.pollOpenCodeActivity();
  const status2 = await request(appCtx.app).get('/status').expect(200);
  assert.ok(status2.body.agents.planner.recentActivity.length <= 3);

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  db.close();
});

test('pollAgentSubstatus updates substatus from part table and attention logic', async () => {
  const db = createOpenCodeDb();
  const appCtx = setupAppWithDb(db);

  insertMessage(db, {
    id: 'm1',
    agent: 'planner',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Should I proceed?' }]),
    time: '2026-03-01T00:00:01.000Z'
  });

  await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: 'running' }).expect(200);

  const parts = [
    { id: 'p1', type: 'step-start', time: '2026-03-01T00:00:02.000Z', expect: 'thinking' },
    { id: 'p2', type: 'tool', toolStatus: 'running', tool: 'bash', time: '2026-03-01T00:00:03.000Z', expect: 'tool' },
    { id: 'p3', type: 'tool', toolStatus: 'completed', tool: 'bash', time: '2026-03-01T00:00:04.000Z', expect: 'thinking' },
    { id: 'p4', type: 'text', text: 'answer', time: '2026-03-01T00:00:05.000Z', expect: 'responding' },
    { id: 'p5', type: 'step-finish', reason: 'tool-calls', time: '2026-03-01T00:00:06.000Z', expect: 'thinking' },
    { id: 'p6', type: 'step-finish', reason: 'stop', time: '2026-03-01T00:00:07.000Z', expect: 'awaiting-input' }
  ];

  for (const part of parts) {
    insertPart(db, {
      id: part.id,
      messageId: 'm1',
      type: part.type,
      text: part.text,
      tool: part.tool,
      toolStatus: part.toolStatus,
      reason: part.reason,
      time: part.time
    });
    appCtx.pollOpenCodeActivity();
    const current = appCtx.getState().agents.planner;
    assert.equal(current.substatus, part.expect);
  }

  await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'done', message: 'done' }).expect(200);
  appCtx.pollOpenCodeActivity();
  assert.equal(appCtx.getState().agents.planner.substatus, null);

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  db.close();
});

test('pollAgentSubstatus marks attention for permission-required response text', async () => {
  const db = createOpenCodeDb();
  const appCtx = setupAppWithDb(db);

  insertMessage(db, {
    id: 'm-perm-1',
    agent: 'reviewer',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Permission required to run git push.' }]),
    time: '2026-03-01T00:01:01.000Z'
  });
  insertPart(db, {
    id: 'p-perm-text',
    messageId: 'm-perm-1',
    type: 'text',
    text: 'Permission required to run git push.',
    time: '2026-03-01T00:01:01.500Z'
  });
  insertPart(db, {
    id: 'p-perm-1',
    messageId: 'm-perm-1',
    type: 'step-finish',
    reason: 'stop',
    time: '2026-03-01T00:01:02.000Z'
  });

  await request(appCtx.app).post('/status').send({ agent: 'reviewer', state: 'active', message: 'running' }).expect(200);
  appCtx.pollOpenCodeActivity();

  const reviewer = appCtx.getState().agents.reviewer;
  assert.equal(reviewer.state, 'attention');
  assert.equal(reviewer.substatus, 'awaiting-input');
  assert.equal(reviewer.message, 'Waiting for your response');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  db.close();
});

test('graceful degradation for null db and learnings fixture', async () => {
  const nullCtx = createTestApp({ opencodeDb: null, learningsDb: null });
  nullCtx.pollOpenCodeActivity();
  const emptyLearn = await request(nullCtx.app).get('/learnings').expect(200);
  assert.deepEqual(emptyLearn.body, []);
  nullCtx.cleanup();
  nullCtx.cleanupTmpDir();

  const db = createOpenCodeDb();
  const learnDb = createLearningsDb([{ type: 'tip', title: 'L', content: 'line', created_at: '2026-02-01T00:00:00.000Z' }]);
  const appCtx = createTestApp({ opencodeDb: db, learningsDb: learnDb });
  const learn = await request(appCtx.app).get('/learnings?limit=3').expect(200);
  assert.equal(learn.body.length, 1);

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  learnDb.close();
  db.close();
});

test('pollCopilotActivity tails events.jsonl for coder updates', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000001';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `updated_at: ${new Date().toISOString()}\n`, 'utf8');

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:00:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  appCtx.pollCopilotActivity();
  assert.equal(appCtx.getState().agents.coder.model, 'gpt-5.3-codex');

  const newEvents = [
    {
      type: 'user.message',
      data: { content: 'Please continue' },
      timestamp: '2026-03-01T00:00:01.000Z'
    },
    {
      type: 'assistant.turn_start',
      data: { turnId: 'turn-1' },
      timestamp: '2026-03-01T00:00:02.000Z'
    },
    {
      type: 'assistant.message',
      data: {
        toolRequests: [{ name: 'report_intent', arguments: JSON.stringify({ intent: 'Need clarification' }) }],
        reasoningText: 'Need your confirmation before proceeding'
      },
      timestamp: '2026-03-01T00:00:03.000Z'
    },
    {
      type: 'assistant.turn_end',
      data: { turnId: 'turn-1' },
      timestamp: '2026-03-01T00:00:04.000Z'
    }
  ].map((event) => JSON.stringify(event)).join('\n');
  fs.appendFileSync(eventsPath, `${newEvents}\n`, 'utf8');

  appCtx.pollCopilotActivity();
  const coder = appCtx.getState().agents.coder;
  assert.equal(coder.state, 'attention');
  assert.equal(coder.substatus, 'awaiting-input');
  assert.equal(coder.message, 'Waiting for your response');

  const feed = await request(appCtx.app).get('/feed?limit=10').expect(200);
  assert.ok(feed.body.some((item) => item.agent === 'coder' && item.message.includes('Need clarification')));

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});

test('pollCopilotActivity finds latest session even with stale workspace timestamp', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000003';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), 'updated_at: 2026-01-01T00:00:00.000Z\n', 'utf8');

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:00:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  appCtx.pollCopilotActivity();
  assert.equal(appCtx.getState().agents.coder.model, 'gpt-5.3-codex');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});

test('pollCopilotActivity marks coder attention on ask_user request', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000002';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `updated_at: ${new Date().toISOString()}\n`, 'utf8');

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:00:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  appCtx.pollCopilotActivity();

  const newEvents = [
    {
      type: 'assistant.turn_start',
      data: { turnId: 'turn-2' },
      timestamp: '2026-03-01T00:00:01.000Z'
    },
    {
      type: 'assistant.message',
      data: {
        toolRequests: [{ name: 'ask_user', arguments: { question: 'Proceed with npm install?' } }]
      },
      timestamp: '2026-03-01T00:00:02.000Z'
    }
  ].map((event) => JSON.stringify(event)).join('\n');
  fs.appendFileSync(eventsPath, `${newEvents}\n`, 'utf8');

  appCtx.pollCopilotActivity();
  const coder = appCtx.getState().agents.coder;
  assert.equal(coder.state, 'attention');
  assert.equal(coder.substatus, 'awaiting-input');
  assert.equal(coder.message, 'Waiting for your response');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});

test('pollCopilotActivity clears coder attention after ask_user completion', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000004';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `updated_at: ${new Date().toISOString()}\n`, 'utf8');

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:00:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  appCtx.pollCopilotActivity();

  const askUserToolCallId = 'call-ask-user-1';
  const newEvents = [
    {
      type: 'assistant.turn_start',
      data: { turnId: 'turn-3' },
      timestamp: '2026-03-01T00:00:01.000Z'
    },
    {
      type: 'assistant.message',
      data: {
        toolRequests: [{ toolCallId: askUserToolCallId, name: 'ask_user', arguments: { question: 'Read file?' } }]
      },
      timestamp: '2026-03-01T00:00:02.000Z'
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: askUserToolCallId,
        toolName: 'ask_user',
        arguments: { question: 'Read file?' }
      },
      timestamp: '2026-03-01T00:00:03.000Z'
    },
    {
      type: 'tool.execution_complete',
      data: {
        toolCallId: askUserToolCallId,
        success: true
      },
      timestamp: '2026-03-01T00:00:04.000Z'
    }
  ].map((event) => JSON.stringify(event)).join('\n');
  fs.appendFileSync(eventsPath, `${newEvents}\n`, 'utf8');

  appCtx.pollCopilotActivity();
  const coder = appCtx.getState().agents.coder;
  assert.equal(coder.state, 'active');
  assert.equal(coder.substatus, 'thinking');
  assert.equal(coder.message, 'Continuing...');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});

test('pollCopilotActivity marks attention for pending command approval and clears on completion', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000005';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `updated_at: ${new Date().toISOString()}\n`, 'utf8');

  const eventsPath = path.join(sessionDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:00:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  appCtx.pollCopilotActivity();

  const commandToolCallId = 'call-python-approve-1';
  const newEvents = [
    {
      type: 'assistant.turn_start',
      data: { turnId: 'turn-approval-1' },
      timestamp: '2026-03-01T00:00:01.000Z'
    },
    {
      type: 'tool.execution_start',
      data: {
        toolCallId: commandToolCallId,
        toolName: 'python'
      },
      timestamp: '2026-03-01T00:00:02.000Z'
    }
  ].map((event) => JSON.stringify(event)).join('\n');
  fs.appendFileSync(eventsPath, `${newEvents}\n`, 'utf8');

  appCtx.pollCopilotActivity();
  let coder = appCtx.getState().agents.coder;
  assert.equal(coder.state, 'attention');
  assert.equal(coder.substatus, 'awaiting-input');
  assert.equal(coder.message, 'Waiting for approval: python');

  fs.appendFileSync(eventsPath, `${JSON.stringify({
    type: 'tool.execution_complete',
    data: {
      toolCallId: commandToolCallId,
      toolName: 'python',
      success: true
    },
    timestamp: '2026-03-01T00:00:03.000Z'
  })}\n`, 'utf8');

  appCtx.pollCopilotActivity();
  coder = appCtx.getState().agents.coder;
  assert.equal(coder.state, 'active');
  assert.equal(coder.substatus, 'thinking');
  assert.equal(coder.message, 'Continuing...');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});

test('POST /agents/:agent/resync rejects invalid agent', async () => {
  const appCtx = createTestApp();
  await request(appCtx.app).post('/agents/not-an-agent/resync').expect(400);
  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('POST /agents/:agent/resync refreshes open code agent and adds feed item', async () => {
  const db = createOpenCodeDb();
  const appCtx = setupAppWithDb(db);

  insertMessage(db, {
    id: 'm-resync-1',
    agent: 'planner',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text: 'Resync me' }]),
    time: '2026-03-01T00:20:01.000Z'
  });

  await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: 'running' }).expect(200);
  const res = await request(appCtx.app).post('/agents/planner/resync').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agent, 'planner');
  assert.equal(res.body.status.agents.planner.state, 'active');

  const feed = await request(appCtx.app).get('/feed?limit=5').expect(200);
  assert.ok(feed.body.some((item) => item.agent === 'planner' && item.message === 'Manual resync requested'));

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  db.close();
});

test('POST /agents/:agent/resync refreshes coder session tracking', async () => {
  const copilotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-copilot-'));
  const sessionId = '00000000-0000-0000-0000-000000000006';
  const sessionDir = path.join(copilotDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'workspace.yaml'), `updated_at: ${new Date().toISOString()}\n`, 'utf8');
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
    type: 'session.start',
    data: { selectedModel: 'gpt-5.3-codex' },
    timestamp: '2026-03-01T00:30:00.000Z'
  })}\n`, 'utf8');

  const appCtx = createTestApp({ copilotSessionStateDir: copilotDir });
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'started' }).expect(200);
  const res = await request(appCtx.app).post('/agents/coder/resync').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agent, 'coder');
  assert.equal(res.body.status.agents.coder.model, 'gpt-5.3-codex');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
  fs.rmSync(copilotDir, { recursive: true, force: true });
});
