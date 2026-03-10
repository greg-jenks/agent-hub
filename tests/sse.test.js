const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const request = require('supertest');
const { createTestApp } = require('./helpers/create-app');
const { collectSSEEvents } = require('./helpers/sse-helper');

function openSSE(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream' }, (res) => resolve({ req, res }));
    req.on('error', reject);
  });
}

test('GET /stream headers and init event shape', async () => {
  const appCtx = createTestApp();
  const server = appCtx.app.listen(0);
  const port = server.address().port;

  const sse = await openSSE(port);
  assert.match(sse.res.headers['content-type'], /text\/event-stream/);
  assert.match(sse.res.headers['cache-control'], /no-cache/);

  const [init] = await collectSSEEvents(sse.res, { count: 1, timeoutMs: 2500 });
  assert.equal(init.type, 'init');
  assert.ok(init.status);
  assert.ok(Array.isArray(init.feed));
  assert.ok(Array.isArray(init.learnings));
  assert.ok(init.messageCounts);

  const status = await request(server).get('/status').expect(200);
  assert.deepEqual(Object.keys(init.status.agents).sort(), Object.keys(status.body.agents).sort());

  sse.req.destroy();
  sse.res.destroy();
  appCtx.cleanup();
  await new Promise((r) => server.close(r));
  appCtx.cleanupTmpDir();
});

test('state change emits agent-update and feed events', async () => {
  const appCtx = createTestApp();
  const server = appCtx.app.listen(0);
  const port = server.address().port;

  const sse = await openSSE(port);
  await collectSSEEvents(sse.res, { count: 1, timeoutMs: 2000 });

  const eventsPromise = collectSSEEvents(sse.res, { count: 2, timeoutMs: 2500 });
  await request(server).post('/status').send({ agent: 'planner', state: 'active', message: 'hello sse' }).expect(200);
  const events = await eventsPromise;

  const update = events.find((e) => e.type === 'agent-update');
  const feed = events.find((e) => e.type === 'feed');
  assert.ok(update);
  assert.equal(update.agent, 'planner');
  assert.equal(update.data.state, 'active');
  assert.ok(feed);
  assert.equal(feed.item.agent, 'planner');
  assert.equal(feed.item.type, 'lifecycle');

  sse.req.destroy();
  sse.res.destroy();
  appCtx.cleanup();
  await new Promise((r) => server.close(r));
  appCtx.cleanupTmpDir();
});

test('multiple SSE clients receive the same update', async () => {
  const appCtx = createTestApp();
  const server = appCtx.app.listen(0);
  const port = server.address().port;

  const c1 = await openSSE(port);
  const c2 = await openSSE(port);
  await collectSSEEvents(c1.res, { count: 1, timeoutMs: 2000 });
  await collectSSEEvents(c2.res, { count: 1, timeoutMs: 2000 });

  const p1 = collectSSEEvents(c1.res, { count: 2, timeoutMs: 2500 });
  const p2 = collectSSEEvents(c2.res, { count: 2, timeoutMs: 2500 });
  await request(server).post('/status').send({ agent: 'reviewer', state: 'attention', message: 'need input' }).expect(200);
  const [e1, e2] = await Promise.all([p1, p2]);

  assert.ok(e1.some((e) => e.type === 'agent-update' && e.agent === 'reviewer'));
  assert.ok(e2.some((e) => e.type === 'agent-update' && e.agent === 'reviewer'));

  c1.req.destroy();
  c1.res.destroy();
  c2.req.destroy();
  c2.res.destroy();
  appCtx.cleanup();
  await new Promise((r) => server.close(r));
  appCtx.cleanupTmpDir();
});
