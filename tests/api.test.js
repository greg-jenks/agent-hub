const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createTestApp } = require('./helpers/create-app');
const { createLearningsDb } = require('./helpers/db-fixtures');
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
