const { createApp } = require('../../status-server');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-e2e-'));

const { app } = createApp({
  opencodeDb: null,
  learningsDb: null,
  statusFile: path.join(tmpDir, 'status.json'),
  feedFile: path.join(tmpDir, 'feed.json'),
  skipPolling: true,
  skipFlush: true
});

app.listen(3748, () => console.log('Test server on 3748'));
