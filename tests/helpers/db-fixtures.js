const Database = require('better-sqlite3');

function createOpenCodeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created TEXT
    )
  `);
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      data TEXT,
      time_created TEXT
    )
  `);
  return db;
}

function insertMessage(db, { id, agent, role, content, model, provider, time }) {
  const data = JSON.stringify({ agent, role, content, modelID: model, providerID: provider });
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, 'test-session', data, time);
}

function insertPart(db, { id, messageId, type, text, tool, toolStatus, reason, time }) {
  const partData = { type };
  if (text !== undefined) partData.text = text;
  if (tool !== undefined) partData.tool = tool;
  if (toolStatus !== undefined) partData.state = { status: toolStatus };
  if (reason !== undefined) partData.reason = reason;
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
    .run(id, messageId, 'test-session', JSON.stringify(partData), time);
}

function createLearningsDb(entries = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      type TEXT,
      title TEXT,
      content TEXT,
      project TEXT,
      tags TEXT,
      created_at TEXT
    )
  `);
  for (const entry of entries) {
    db.prepare('INSERT INTO entries (type, title, content, project, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.type, entry.title, entry.content, entry.project || null, entry.tags || null, entry.created_at);
  }
  return db;
}

module.exports = { createOpenCodeDb, insertMessage, insertPart, createLearningsDb };
