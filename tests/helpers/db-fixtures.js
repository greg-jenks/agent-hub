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

function createMessagesDb(messages = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id             TEXT PRIMARY KEY,
      thread_id      TEXT NOT NULL,
      parent_id      TEXT,
      from_agent     TEXT NOT NULL,
      to_agent       TEXT NOT NULL,
      type           TEXT NOT NULL,
      severity       TEXT NOT NULL DEFAULT 'advisory',
      ref            TEXT,
      body           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'unread',
      created_at     TEXT NOT NULL,
      read_at        TEXT,
      addressed_at   TEXT,
      addressed_note TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO messages (
      id, thread_id, parent_id, from_agent, to_agent, type, severity, ref, body, status,
      created_at, read_at, addressed_at, addressed_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const msg of messages) {
    insert.run(
      msg.id,
      msg.thread_id || msg.id,
      msg.parent_id || null,
      msg.from_agent,
      msg.to_agent,
      msg.type || 'info',
      msg.severity || 'advisory',
      msg.ref || null,
      msg.body || '',
      msg.status || 'unread',
      msg.created_at || new Date().toISOString(),
      msg.read_at || null,
      msg.addressed_at || null,
      msg.addressed_note || null
    );
  }
  return db;
}

module.exports = { createOpenCodeDb, insertMessage, insertPart, createLearningsDb, createMessagesDb };
