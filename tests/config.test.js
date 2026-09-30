import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
const key = 'k'.repeat(40);
test('public https origin implies production even when NODE_ENV is overridden', () => {
  const c = loadConfig({ NODE_ENV: 'development', APP_ORIGIN: 'https://sudoku.example.com', LAUNCH_SIGNING_KEY: key });
  assert.equal(c.production, true);
  assert.equal(c.host, '0.0.0.0');
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://sudoku.example.com' }), /LAUNCH_SIGNING_KEY/);
});
test('loopback and http origins stay development; NODE_ENV=production still enforces https', () => {
  for (const o of ['http://localhost:3000', 'https://localhost:3000', 'https://127.0.0.1']) {
    const c = loadConfig({ APP_ORIGIN: o });
    assert.equal(c.production, false);
    assert.equal(c.host, '127.0.0.1');
  }
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://example.com', LAUNCH_SIGNING_KEY: key }), /HTTPS/);
});
