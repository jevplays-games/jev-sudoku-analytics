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
test('malformed or insecure LEGACY_APP_ORIGINS entries are skipped instead of breaking every request', async () => {
  const { handle } = await import('../server/worker.js'); const { environment, context } = await import('./helpers.js');
  const config = loadConfig({ APP_ORIGIN: 'https://typedoku.jevplay.games', LAUNCH_SIGNING_KEY: 'a'.repeat(64),
    LEGACY_APP_ORIGINS: 'not a url, https://old.jevplay.games/some/path , http://plain.jevplay.games,javascript:alert(1),,https://typedoku.jevplay.games,https://sudoku.jevplay.games/' });
  // The path entry is skipped, not normalised to its origin; a single trailing slash on a bare origin is fine.
  assert.deepEqual(config.origins, ['https://typedoku.jevplay.games', 'https://sudoku.jevplay.games']);
  const env = environment({ APP_ORIGIN: 'https://typedoku.jevplay.games', LEGACY_APP_ORIGINS: '::::,https://sudoku.jevplay.games' });
  const r = await handle(new Request('https://typedoku.jevplay.games/api/health'), env, context());
  assert.equal(r.status, 200);
});
test('decision D9: only bare legacy origins are admitted; userinfo, fragment, path, query and wildcard entries never widen the allowlist', async () => {
  const { handle } = await import('../server/worker.js'); const { environment, context } = await import('./helpers.js');
  const hostile = ['https://user:pw@evil.example', 'https://evil.example#@sudoku.jevplay.games', 'https://evil.example/path', 'https://evil.example?q=1', 'https://*.jevplay.games',
    'https://evil.example?x=@sudoku.jevplay.games', 'https://evil.example/@sudoku.jevplay.games'];
  const warn = console.warn, warnings = []; console.warn = m => warnings.push(m);
  let env;
  try { env = environment({ APP_ORIGIN: 'https://typedoku.jevplay.games', LEGACY_APP_ORIGINS: [...hostile, 'https://sudoku.jevplay.games'].join(','), DISCORD_CLIENT_ID: '1234567890', DISCORD_CLIENT_SECRET: 'secret' }); loadConfig(env); }
  finally { console.warn = warn; }
  assert.deepEqual(loadConfig(env).origins, ['https://typedoku.jevplay.games', 'https://sudoku.jevplay.games']);
  assert.equal(warnings.length, 1, 'one structured warning'); assert.equal(JSON.parse(warnings[0]).count, hostile.length);
  const send = (url, init = {}) => handle(new Request(url, { ...init, headers: { 'cf-connecting-ip': '198.51.100.9', ...init.headers } }), env, context());
  // The evil host is not served: OAuth falls back to the canonical callback, and its Origin is refused for CSRF and Activity sign-in.
  const me = await send('https://evil.example/api/me'), cookie = me.headers.get('set-cookie').split(';')[0], { csrfToken } = await me.json();
  const login = await send('https://evil.example/api/auth/discord', { headers: { cookie } });
  assert.equal(new URL(login.headers.get('location')).searchParams.get('redirect_uri'), 'https://typedoku.jevplay.games/api/auth/discord/callback');
  const post = await send('https://evil.example/api/matches', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'd9-evil-0001', mode: 'practice' }) });
  assert.equal(post.status, 403); assert.equal((await post.json()).error, 'csrf_rejected');
  const activity = await send('https://typedoku.jevplay.games/api/activity/session', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }) });
  assert.equal(activity.status, 403); assert.equal((await activity.json()).error, 'origin_rejected');
  // The canonical and the real legacy host are still served.
  for (const host of ['https://typedoku.jevplay.games', 'https://sudoku.jevplay.games']) {
    const m = await send(host + '/api/me'), c = m.headers.get('set-cookie').split(';')[0], { csrfToken: t } = await m.json();
    const ok = await send(host + '/api/matches', { method: 'POST', headers: { cookie: c, origin: host, 'x-csrf-token': t, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: `d9-${host.length}-ok01`, mode: 'practice' }) });
    assert.equal(ok.status, 201, host);
  }
});
