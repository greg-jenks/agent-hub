const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestApp } = require('./helpers/create-app');
const { createOpenCodeDb, insertMessage, insertPart } = require('./helpers/db-fixtures');

function setupTextCase(text) {
  const db = createOpenCodeDb();
  insertMessage(db, {
    id: 'm1',
    agent: 'planner',
    role: 'assistant',
    content: JSON.stringify([{ type: 'text', text }]),
    time: '2026-03-01T00:00:00.000Z'
  });
  insertPart(db, {
    id: 'p1',
    messageId: 'm1',
    type: 'text',
    text,
    time: '2026-03-01T00:00:01.000Z'
  });
  return db;
}

test('ATTENTION_PATTERNS positive matches', () => {
  const positives = [
    'What do you think?',
    'Should I proceed with this approach?',
    'Would you like me to continue?',
    'Do you want me to push this?',
    'Please confirm the approach',
    'Please clarify the requirements',
    'Let me know if this looks right?',
    'I need from you the API key',
    'What would you prefer here?',
    'Can you confirm this is correct?',
    'Waiting for your input',
    'Waiting for your response',
    'How would you like this organized?',
    'Which option do you prefer?',
    'Which approach should we take?'
  ];

  for (const text of positives) {
    const db = setupTextCase(text);
    const appCtx = createTestApp({ opencodeDb: db });
    assert.equal(appCtx.checkNeedsAttention(db, 'planner'), true, text);
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
    db.close();
  }
});

test('ATTENTION_PATTERNS negative matches', () => {
  const negatives = [
    "Here's the implementation.",
    'Done. All tests pass.',
    "I've fixed the bug and updated tests.",
    '### Summary\n- Changed X\n- Updated Y',
    'Let me know when ready.',
    'I thought about whether I should refactor.'
  ];

  for (const text of negatives) {
    const db = setupTextCase(text);
    const appCtx = createTestApp({ opencodeDb: db });
    assert.equal(appCtx.checkNeedsAttention(db, 'planner'), false, text);
    appCtx.cleanup();
    appCtx.cleanupTmpDir();
    db.close();
  }
});

test('checkNeedsAttention long text behavior and no-data behavior', () => {
  const longStartQuestion = `${'?'}${'a'.repeat(2999)}`;
  const db1 = setupTextCase(longStartQuestion);
  const app1 = createTestApp({ opencodeDb: db1 });
  assert.equal(app1.checkNeedsAttention(db1, 'planner'), false);
  app1.cleanup();
  app1.cleanupTmpDir();
  db1.close();

  const longTailQuestion = `${'a'.repeat(1700)} Should I continue?`;
  const db2 = setupTextCase(longTailQuestion);
  const app2 = createTestApp({ opencodeDb: db2 });
  assert.equal(app2.checkNeedsAttention(db2, 'planner'), true);
  app2.cleanup();
  app2.cleanupTmpDir();
  db2.close();

  const db3 = createOpenCodeDb();
  const app3 = createTestApp({ opencodeDb: db3 });
  assert.equal(app3.checkNeedsAttention(db3, 'planner'), false);
  app3.cleanup();
  app3.cleanupTmpDir();
  db3.close();
});
