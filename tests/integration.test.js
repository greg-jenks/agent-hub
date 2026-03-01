const test = require('node:test');
const assert = require('node:assert/strict');
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
