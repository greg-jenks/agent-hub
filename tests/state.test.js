const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { createTestApp } = require('./helpers/create-app');
const { createApp } = require('../status-server');

async function getStatus(app) {
  const res = await request(app).get('/status').expect(200);
  return res.body;
}

test('default state starts idle with empty messages', async () => {
  const appCtx = createTestApp();
  const status = await getStatus(appCtx.app);

  for (const agent of Object.keys(status.agents)) {
    assert.equal(status.agents[agent].state, 'idle');
    assert.equal(status.agents[agent].message, '');
  }

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('state transitions are allowed', async () => {
  const appCtx = createTestApp();

  for (const state of ['active', 'done', 'attention', 'error', 'active']) {
    await request(appCtx.app).post('/status').send({ agent: 'planner', state, message: state }).expect(200);
    const status = await getStatus(appCtx.app);
    assert.equal(status.agents.planner.state, state);
  }

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('non-active states clear substatus and active preserves it', async () => {
  const appCtx = createTestApp();
  const stateRef = appCtx.getState().agents.planner;
  stateRef.substatus = 'awaiting-input';
  stateRef.toolName = 'tool-x';

  await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: 'on' }).expect(200);
  assert.equal(appCtx.getState().agents.planner.substatus, 'awaiting-input');

  for (const state of ['done', 'error', 'idle', 'attention']) {
    appCtx.getState().agents.planner.substatus = 'awaiting-input';
    appCtx.getState().agents.planner.toolName = 'tool-x';
    await request(appCtx.app).post('/status').send({ agent: 'planner', state, message: state }).expect(200);
    assert.equal(appCtx.getState().agents.planner.substatus, null);
    assert.equal(appCtx.getState().agents.planner.toolName, null);
  }

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('feed accumulates lifecycle events newest first and caps at 50', async () => {
  const appCtx = createTestApp();

  for (let i = 0; i < 60; i += 1) {
    await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: `msg-${i}` }).expect(200);
  }

  const feed = await request(appCtx.app).get('/feed?limit=1000').expect(200);
  assert.equal(feed.body.length, 50);
  assert.equal(feed.body[0].message, 'msg-59');
  assert.equal(feed.body[0].type, 'lifecycle');
  assert.equal(feed.body[0].agent, 'planner');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('agent isolation across updates', async () => {
  const appCtx = createTestApp();

  await request(appCtx.app).post('/status').send({ agent: 'planner', state: 'active', message: 'p' }).expect(200);
  await request(appCtx.app).post('/status').send({ agent: 'coder', state: 'active', message: 'c' }).expect(200);

  const status = await getStatus(appCtx.app);
  assert.equal(status.agents.planner.state, 'active');
  assert.equal(status.agents.coder.state, 'active');
  assert.equal(status.agents.reviewer.state, 'idle');

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});

test('stale active and attention states reset to idle on startup', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-stale-'));
  const statusFile = path.join(tmpDir, 'status.json');
  const feedFile = path.join(tmpDir, 'feed.json');
  const staleTime = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
  const freshTime = new Date().toISOString();

  fs.writeFileSync(statusFile, JSON.stringify({
    agents: {
      planner: { state: 'attention', message: 'Waiting for your response', updated: staleTime, substatus: 'awaiting-input' },
      coder: { state: 'active', message: 'Working', updated: freshTime, substatus: 'thinking' },
      reviewer: { state: 'idle', message: '', updated: staleTime },
      puddleglum: { state: 'active', message: 'Running', updated: staleTime, substatus: 'tool' }
    },
    serverStarted: staleTime
  }), 'utf8');
  fs.writeFileSync(feedFile, '[]', 'utf8');

  const appCtx = createApp({
    opencodeDb: null,
    learningsDb: null,
    messagesDb: null,
    statusFile,
    feedFile,
    skipPolling: true,
    skipFlush: true
  });

  const status = await getStatus(appCtx.app);
  assert.equal(status.agents.planner.state, 'idle');
  assert.equal(status.agents.planner.message, '');
  assert.equal(status.agents.puddleglum.state, 'idle');
  assert.equal(status.agents.coder.state, 'active');
  assert.notEqual(status.serverStarted, staleTime);

  appCtx.cleanup();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
