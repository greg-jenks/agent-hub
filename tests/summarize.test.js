const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers/create-app');

function getSummarizer() {
  const appCtx = createTestApp();
  const fn = appCtx.summarizeContent;
  return { appCtx, fn };
}

test('summarizeContent parsing and truncation', () => {
  const { appCtx, fn } = getSummarizer();

  assert.equal(fn(JSON.stringify([{ type: 'text', text: 'hello' }])), 'hello');
  assert.equal(fn(JSON.stringify([{ type: 'image', url: 'x' }, { type: 'text', text: 'hello-2' }])), 'hello-2');
  assert.equal(fn(JSON.stringify([{ type: 'image', url: 'x' }])), '');
  assert.equal(fn(JSON.stringify('hello')), 'hello');
  assert.equal(fn(JSON.stringify({ text: 'hello' })), 'hello');
  assert.equal(fn('not-json'), 'not-json');
  assert.equal(fn(null), '');
  assert.equal(fn(undefined), '');
  assert.equal(fn(''), '');

  const exact500 = 'a'.repeat(500);
  const over501 = 'b'.repeat(501);
  const over1000 = 'c'.repeat(1000);
  assert.equal(fn(exact500), exact500);
  assert.equal(fn(over501), `${'b'.repeat(500)}...`);
  assert.equal(fn(over1000), `${'c'.repeat(500)}...`);

  appCtx.cleanup();
  appCtx.cleanupTmpDir();
});
