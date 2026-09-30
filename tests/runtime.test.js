import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { openDatabase } from '../local/database.js';
import { createLocalApp } from '../local/server.js';
import { environment, client, context } from './helpers.js';
import { reserve } from '../server/db.js';
import { maintenance, SWEEP_INTERVAL_MS, resetSweepGate } from '../server/maintenance.js';
import { transformPuzzle } from '../server/puzzles.js';
import { countSolutions, isConsistent, PEERS } from '../public/shared/sudoku.js';
import { handle } from '../server/worker.js';
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const jsonc = text => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));

test('server and shared code use Web APIs only: no Node built-ins, no process, Buffer or long-lived timers', () => {
  for (const dir of ['server', 'public/shared']) for (const file of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => f.endsWith('.js'))) {
    const source = read(`${dir}/${file}`).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/from\s+['"]node:/.test(source), false, `${dir}/${file} imports a Node built-in`);
    assert.equal(/\bprocess\./.test(source), false, `${dir}/${file} uses process`);
    assert.equal(/\bBuffer\b/.test(source), false, `${dir}/${file} uses Buffer`);
    assert.equal(/setInterval|require\(/.test(source), false, `${dir}/${file} uses a timer loop or require`);
    assert.equal(/worker_threads|new Worker\(|execArgv/.test(source), false, `${dir}/${file} uses worker threads`);
  }
});
test('wrangler.jsonc matches the free-plan constraints and the sibling deployment shape', () => {
  const w = jsonc(read('wrangler.jsonc'));
  assert.equal(w.name, 'jev-sudoku'); assert.equal(w.main, 'server/worker.js');
  assert.deepEqual(w.routes, [{ pattern: 'sudoku.jevplay.games', custom_domain: true }]);
  assert.deepEqual(w.assets, { directory: './public', binding: 'ASSETS', run_worker_first: ['/api/*', '/'] });
  assert.equal(w.d1_databases[0].binding, 'DB'); assert.equal(w.d1_databases[0].database_id, 'REPLACE_WITH_D1_ID'); assert.equal(w.d1_databases[0].migrations_dir, 'migrations');
  assert.equal(w.triggers, undefined, 'no cron triggers: the account-wide free-plan limit is fully used');
  assert.equal(w.limits, undefined, 'no custom CPU limit on the free plan');
  assert.equal(w.durable_objects, undefined); assert.equal(w.containers, undefined);
  assert.ok(!w.compatibility_flags || w.compatibility_flags.every(f => f === 'nodejs_compat'), 'only nodejs_compat may be enabled');
  assert.equal(w.vars.APP_ORIGIN, 'https://sudoku.jevplay.games'); assert.equal(w.vars.JEV_MODEL, 'jev-1.13.0');
  for (const secret of ['TYPESAFE_API_KEY', 'LAUNCH_SIGNING_KEY', 'DISCORD_CLIENT_SECRET', 'ADMIN_ANALYTICS_TOKEN']) assert.equal(secret in w.vars, false, `${secret} must be a secret, not a var`);
});
test('the D1-compatible shim keeps D1 semantics: null misses, RETURNING, change counts and atomic batches', async () => {
  const db = openDatabase();
  assert.equal(await db.prepare('SELECT 1 AS x FROM meta WHERE key=?').bind('none').first(), null);
  assert.equal((await db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').bind('a', 1).run()).meta.changes, 1);
  assert.deepEqual({ ...(await db.prepare('UPDATE meta SET value=value+1 WHERE key=? RETURNING value').bind('a').first()) }, { value: 2 });
  assert.equal((await db.prepare('UPDATE meta SET value=5 WHERE key=?').bind('missing').run()).meta.changes, 0);
  await assert.rejects(db.batch([db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').bind('b', 1), db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').bind('a', 9)]), /UNIQUE/);
  assert.equal(await db.prepare('SELECT 1 AS x FROM meta WHERE key=?').bind('b').first(), null, 'the whole batch rolled back');
  const results = await db.batch([db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').bind('c', 1), db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').bind('d', 1)]);
  assert.deepEqual(results.map(r => r.meta.changes), [1, 1]);
  db.close();
});
test('migrations are applied once, in order, to a file database and seed the practice pool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-sudoku-db-')), path = join(dir, 'x.sqlite');
  try {
    let db = openDatabase(path); const first = (await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(r => r.name); db.close();
    db = openDatabase(path); const again = (await db.prepare('SELECT name FROM d1_migrations ORDER BY name').all()).results.map(r => r.name);
    assert.deepEqual(first, ['0001.sql', '0002_practice_pool.sql']); assert.deepEqual(again, first);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM puzzle_pool').first()).n, 300); db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a database file from the earlier container build is refused instead of being silently mixed with the new schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-sudoku-legacy-')), path = join(dir, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(path); legacy.exec('CREATE TABLE matches(id TEXT PRIMARY KEY, state_json TEXT)'); legacy.close();
    assert.throws(() => openDatabase(path), /earlier container build/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('quota reservations are atomic fixed windows that refuse rather than overspend', async () => {
  const env = environment(), results = [];
  for (let i = 0; i < 5; i++) results.push(await reserve(env, 'subject', 3, 60000));
  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(await reserve(env, 'other-subject', 3, 60000), true);
  env.clock.advance(60000); assert.equal(await reserve(env, 'subject', 3, 60000), true, 'the next window starts fresh');
  const concurrent = await Promise.all(Array.from({ length: 10 }, () => reserve(env, 'burst', 4, 60000)));
  assert.equal(concurrent.filter(Boolean).length, 4);
});
test('the practice pool is unique-solution, distinct, and every transform preserves validity, clue count and uniqueness', async () => {
  const env = environment(), rows = (await env.DB.prepare('SELECT givens,puzzle_hash FROM puzzle_pool ORDER BY id').all()).results;
  assert.equal(rows.length, 300); assert.equal(new Set(rows.map(r => r.puzzle_hash)).size, 300);
  for (const row of rows.filter((_, i) => i % 30 === 0)) {
    assert.equal(countSolutions(row.givens, 2).count, 1);
    for (let k = 0; k < 3; k++) {
      const t = transformPuzzle(row.givens), grid = [...t].map(Number);
      assert.equal(t.length, 81); assert.equal(isConsistent(grid), true);
      assert.equal(grid.filter(Boolean).length, [...row.givens].filter(c => c !== '0').length);
      assert.equal(countSolutions(t, 2).count, 1);
    }
  }
  assert.notEqual(transformPuzzle(rows[0].givens), transformPuzzle(rows[0].givens), 'transforms are random per match');
  assert.ok(PEERS.length === 81);
});
test('the lazy maintenance sweep runs at most once per interval per isolate and once across isolates (D1 gate)', async () => {
  const env = environment(); resetSweepGate();
  assert.ok(await maintenance(env), 'first attempt runs');
  assert.equal(await maintenance(env), null, 'an isolate does not retry inside the interval');
  resetSweepGate(); assert.equal(await maintenance(env), null, 'a second isolate is stopped by the D1 gate');
  env.clock.advance(SWEEP_INTERVAL_MS + 1); resetSweepGate(); assert.ok(await maintenance(env), 'after the interval it runs again');
});
test('API requests schedule the sweep through waitUntil and never through a timer', async () => {
  const env = environment(), ctx = context(); resetSweepGate();
  await handle(new Request('http://localhost:3000/api/me', { headers: { 'cf-connecting-ip': '203.0.113.9' } }), env, ctx); await ctx.settle();
  assert.equal((await env.DB.prepare("SELECT value FROM meta WHERE key='sweep'").first()).value > 0, true);
});
test('the local adapter serves the same Worker over real HTTP, with a path guard that holds on Windows separators', async () => {
  const app = createLocalApp({ APP_ORIGIN: 'http://127.0.0.1:0', PORT: '0', LAUNCH_SIGNING_KEY: 'a'.repeat(64) }, { databasePath: ':memory:' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const page = await fetch(base + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /Sudoku Duel/);
    for (const bad of ['/..%2f..%2fpackage.json', '/..%5c..%5cpackage.json', '/%2e%2e/package.json']) assert.equal((await fetch(base + bad)).status, 404, bad);
    assert.equal((await fetch(base + '/api/health')).status, 200);
    const me = await fetch(base + '/api/me'); const cookie = me.headers.getSetCookie()[0].split(';')[0];
    assert.equal(me.status, 200);
    const body = await me.json();
    const create = origin => fetch(base + '/api/matches', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': body.csrfToken }, body: JSON.stringify({ requestId: 'http-e2e-0001' }) });
    assert.equal((await create('http://evil.example')).status, 403, 'a foreign origin is refused');
    const created = await create('http://127.0.0.1:0'); assert.equal(created.status, 201, 'the configured origin is accepted end to end');
    assert.equal((await created.json()).givens, null);
  } finally { await app.close(); }
});
test('the Discord interactions endpoint refuses unsigned requests before touching state', async () => {
  const env = environment({ DISCORD_CLIENT_ID: '123456789012345678', DISCORD_PUBLIC_KEY: 'ab'.repeat(32) }), x = await client(env, { session: false });
  const r = await x.send('/api/discord/interactions', { method: 'POST', body: { type: 1 } }); assert.equal(r.status, 401);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM security_tokens').first()).n, 0);
});
