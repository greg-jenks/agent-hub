const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('./helpers/create-app');
const { createLearningsDb, createMessagesDb } = require('./helpers/db-fixtures');
const { VALID_AGENTS } = require('../status-server');

test.describe('GET /status', () => {
  test('returns expected status shape', async () => {
    const appCtx = createTestApp();
    const res = await request(appCtx.app).get('/status').expect(200);

    assert.ok(res.body.agents);
    assert.ok(res.body.serverStarted);
    assert.deepEqual(Object.keys(res.body.agents).sort(), [...VALID_AGENTS].sort());
    for (const agent of VALID_AGENTS) {
      const state = res.body.agents[agent];
      assert.equal(typeof state.state, 'string');
      assert.equal(typeof state.message, 'string');
      assert.equal(typeof state.updated, 'string');
      assert.ok(Array.isArray(state.recentActivity));
    }

    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });
});

test.describe('POST /status validation and write/read', () => {
  test('validates required fields and defaults message', async () => {
    const appCtx = createTestApp();

    await request(appCtx.app).post('/status').send({ state: 'active' }).expect(400);
    await request(appCtx.app).post('/status').send({ agent: 'bad', state: 'active' }).expect(400);
    await request(appCtx.app).post('/status').send({ agent: 'planner' }).expect(400);
    await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'bad' }).expect(400);

    const ok = await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active' }).expect(200);
    assert.equal(ok.body.ok, true);

    const status = await request(appCtx.app).get('/status').expect(200);
    assert.equal(status.body.agents.planner.state, 'active');
    assert.equal(status.body.agents.planner.message, '');

    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('updates one agent without affecting others', async () => {
    const appCtx = createTestApp();

    const before = await request(appCtx.app).get('/status').expect(200);
    const oldUpdated = before.body.agents.planner.updated;
    const coderState = before.body.agents.coder.state;

    await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: 'running' }).expect(200);
    const after = await request(appCtx.app).get('/status').expect(200);

    assert.equal(after.body.agents.planner.state, 'active');
    assert.notEqual(after.body.agents.planner.updated, oldUpdated);
    assert.equal(after.body.agents.coder.state, coderState);

    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('accepts optional sessionId and persists it on agent state', async () => {
    const appCtx = createTestApp();

    await request(appCtx.app).post('/status')
      .send({ agent: 'coder', state: 'active', message: 'running', sessionId: 'session-123' })
      .expect(200);

    const status = await request(appCtx.app).get('/status').expect(200);
    assert.equal(status.body.agents.coder.sessionId, 'session-123');

    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });
});

test.describe('GET /feed', () => {
  test('returns array, enforces limit and cap', async () => {
    const appCtx = createTestApp();

    for (let i = 0; i < 30; i += 1) {
      await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: `m${i}` }).expect(200);
    }

    const defaultRes = await request(appCtx.app).get('/feed').expect(200);
    assert.ok(Array.isArray(defaultRes.body));
    assert.ok(defaultRes.body.length <= 20);

    const limited = await request(appCtx.app).get('/feed?limit=5').expect(200);
    assert.equal(limited.body.length, 5);

    const capped = await request(appCtx.app).get('/feed?limit=999').expect(200);
    assert.ok(capped.body.length <= 50);
    const first = capped.body[0];
    assert.ok(['lifecycle', 'prompt', 'response', 'info'].includes(first.type));
    assert.equal(typeof first.agent, 'string');
    assert.equal(typeof first.message, 'string');
    assert.equal(typeof first.time, 'string');

    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });
});

test.describe('GET /learnings and /', () => {
  test('handles null db and fixture db', async () => {
    const nullCtx = createTestApp({ learningsDb: null });
    const empty = await request(nullCtx.app).get('/learnings').expect(200);
    assert.deepEqual(empty.body, []);
    nullCtx.cleanup();
    nullCtx.cleanupTmpDir();

    const learningsDb = createLearningsDb([
      { type: 'tip', title: 'A', content: 'alpha', created_at: '2026-01-01T00:00:00.000Z' },
      { type: 'tip', title: 'B', content: 'beta', created_at: '2026-01-02T00:00:00.000Z' },
      { type: 'tip', title: 'C', content: 'gamma', created_at: '2026-01-03T00:00:00.000Z' },
      { type: 'tip', title: 'D', content: 'delta', created_at: '2026-01-04T00:00:00.000Z' }
    ]);
    const dbCtx = createTestApp({ learningsDb });
    const limited = await request(dbCtx.app).get('/learnings?limit=3').expect(200);
    assert.equal(limited.body.length, 3);

    const capped = await request(dbCtx.app).get('/learnings?limit=999').expect(200);
    assert.ok(capped.body.length <= 50);

    learningsDb.close();
    dbCtx.cleanup();
    dbCtx.cleanupTmpDir();
  });

  test('serves html at /', async () => {
    const appCtx = createTestApp();
    await request(appCtx.app).get('/').expect(200).expect('Content-Type', /text\/html/);
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });
});

test.describe('GET /api/messages*', () => {
  test('returns empty counts shape with null db', async () => {
    const appCtx = createTestApp({ messagesDb: null });
    const res = await request(appCtx.app).get('/api/messages/counts').expect(200);
    assert.deepEqual(Object.keys(res.body).sort(), [...VALID_AGENTS].sort());
    for (const agent of VALID_AGENTS) {
      assert.deepEqual(res.body[agent], { total: 0, blocking: 0 });
    }
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('returns unread counts from fixture db', async () => {
    const messagesDb = createMessagesDb([
      { id: 'm1', from_agent: 'reviewer', to_agent: 'coder', type: 'diff_feedback', severity: 'blocking', status: 'unread', body: 'fix validation' },
      { id: 'm2', from_agent: 'planner', to_agent: 'coder', type: 'question', severity: 'advisory', status: 'unread', body: 'need paging?' },
      { id: 'm3', from_agent: 'coder', to_agent: 'reviewer', type: 'info', severity: 'info', status: 'read', body: 'done' }
    ]);
    const appCtx = createTestApp({ messagesDb });
    const res = await request(appCtx.app).get('/api/messages/counts').expect(200);
    assert.deepEqual(res.body.coder, { total: 2, blocking: 1 });
    assert.deepEqual(res.body.reviewer, { total: 0, blocking: 0 });
    messagesDb.close();
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('filters message list by to, severity, and status', async () => {
    const messagesDb = createMessagesDb([
      { id: 'm1', from_agent: 'reviewer', to_agent: 'coder', type: 'diff_feedback', severity: 'blocking', status: 'unread', body: 'fix validation', created_at: '2026-01-03T00:00:00.000Z' },
      { id: 'm2', from_agent: 'planner', to_agent: 'coder', type: 'question', severity: 'advisory', status: 'unread', body: 'need paging?', created_at: '2026-01-02T00:00:00.000Z' },
      { id: 'm3', from_agent: 'coder', to_agent: 'reviewer', type: 'info', severity: 'info', status: 'read', body: 'done', created_at: '2026-01-01T00:00:00.000Z' }
    ]);
    const appCtx = createTestApp({ messagesDb });

    const toCoder = await request(appCtx.app).get('/api/messages?to=coder').expect(200);
    assert.equal(toCoder.body.length, 2);
    assert.ok(toCoder.body.every((m) => m.to_agent === 'coder'));

    const blocking = await request(appCtx.app).get('/api/messages?severity=blocking').expect(200);
    assert.equal(blocking.body.length, 1);
    assert.equal(blocking.body[0].id, 'm1');

    const unread = await request(appCtx.app).get('/api/messages?status=unread').expect(200);
    assert.equal(unread.body.length, 2);
    assert.ok(unread.body.every((m) => m.status === 'unread'));

    messagesDb.close();
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('orders messages by recency before severity', async () => {
    const messagesDb = createMessagesDb([
      { id: 'm-old-blocking', from_agent: 'reviewer', to_agent: 'coder', type: 'diff_feedback', severity: 'blocking', status: 'unread', body: 'older blocking', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'm-new-advisory', from_agent: 'planner', to_agent: 'coder', type: 'question', severity: 'advisory', status: 'unread', body: 'newer advisory', created_at: '2026-01-02T00:00:00.000Z' }
    ]);
    const appCtx = createTestApp({ messagesDb });

    const res = await request(appCtx.app).get('/api/messages?limit=10').expect(200);
    assert.equal(res.body[0].id, 'm-new-advisory');
    assert.equal(res.body[1].id, 'm-old-blocking');

    messagesDb.close();
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });

  test('returns 404 for missing message id', async () => {
    const messagesDb = createMessagesDb([
      { id: 'm1', from_agent: 'reviewer', to_agent: 'coder', type: 'diff_feedback', severity: 'blocking', status: 'unread', body: 'fix validation' }
    ]);
    const appCtx = createTestApp({ messagesDb });
    await request(appCtx.app).get('/api/messages/not-found').expect(404);
    messagesDb.close();
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
  });
});
