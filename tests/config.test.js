import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';
const key = 'k'.repeat(40);
test('public https origin means production, and production requires a launch signing key', () => {
  const c = loadConfig({ APP_ORIGIN: 'https://sudoku.example.com', LAUNCH_SIGNING_KEY: key });
  assert.equal(c.production, true);
  assert.equal(c.launchKey, key);
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://sudoku.example.com' }), /LAUNCH_SIGNING_KEY/);
  assert.throws(() => loadConfig({ APP_ORIGIN: 'https://sudoku.example.com', LAUNCH_SIGNING_KEY: 'short' }), /LAUNCH_SIGNING_KEY/);
});
test('loopback and http origins stay development; NODE_ENV=production still enforces https', () => {
  for (const o of ['http://localhost:3000', 'https://localhost:3000', 'https://127.0.0.1']) {
    const c = loadConfig({ APP_ORIGIN: o });
    assert.equal(c.production, false);
    assert.equal(c.launchKey.length, 64, 'development gets an ephemeral key');
  }
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://example.com', LAUNCH_SIGNING_KEY: key }), /HTTPS/);
});
test('numeric settings are validated and defaults match the documented free-plan quotas', () => {
  const c = loadConfig({ APP_ORIGIN: 'http://localhost:3000' });
  assert.equal(c.pacingMs, 8000);
  assert.equal(c.jevCallsPerDay, 5000);
  assert.equal(c.jevCallsPerHour, 600);
  assert.equal(c.abandonedAfterMs, 600000);
  assert.deepEqual(c.stepBudget, { easy: 6, normal: 3, hard: 1, jev: 1 }); assert.equal(c.modelStepBudget, 3);
  assert.equal(c.jevEndpoint, 'https://api.typesafe.ai/v1/systemone');
  for (const bad of [{ PRACTICE_PACING_MS: '10' }, { MAX_ACTIVE_MATCHES: 'x' }, { ABANDONED_AFTER_MS: '5' }, { JEV_INPUT_USD_PER_MILLION: '-1' }]) assert.throws(() => loadConfig({ APP_ORIGIN: 'http://localhost:3000', ...bad }), /Invalid/);
});
test('config is derived from the Discord client id and cached per env object', () => {
  const env = { APP_ORIGIN: 'http://localhost:3000', DISCORD_CLIENT_ID: '123456789012345678', ADMIN_DISCORD_IDS: ' 1, 2 ,' };
  const c = loadConfig(env);
  assert.equal(c.activityOrigin, 'https://123456789012345678.discordsays.com');
  assert.deepEqual(c.admins, ['1', '2']);
  assert.equal(loadConfig(env), c);
  assert.equal(loadConfig({ APP_ORIGIN: 'http://localhost:3000' }).activityOrigin, null);
});
