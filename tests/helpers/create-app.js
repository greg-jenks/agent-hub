const { createApp } = require('../../status-server');
const os = require('os');
const path = require('path');
const fs = require('fs');

function createTestApp(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'));
  const defaults = {
    opencodeDb: null,
    learningsDb: null,
    messagesDb: null,
    statusFile: path.join(tmpDir, 'status.json'),
    feedFile: path.join(tmpDir, 'feed.json'),
    skipPolling: true,
    skipFlush: true
  };
  const result = createApp({ ...defaults, ...overrides });
  result.cleanupTmpDir = () => fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

module.exports = { createTestApp };
