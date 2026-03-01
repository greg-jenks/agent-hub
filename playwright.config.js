const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:3748'
  },
  webServer: {
    command: 'node tests/e2e/test-server.js',
    port: 3748,
    reuseExistingServer: false
  }
});
