import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, client, modelFetch } from './helpers.js';
import { makeAdapter } from '../server/matches.js';
import { resetSweepGate } from '../server/maintenance.js';
// Workers Free allows 50 database queries per invocation. These tests count every statement each invocation issues (a batch counts
// once per statement, the conservative reading) so the opponent-step budgets, the lazy sweep and the write paths cannot silently
// grow past it. The ceiling asserted is 45, leaving headroom for the request-log write.
const CEILING = 45;
function counted(env) {
  const db = env.DB, tally = { statements: 0, calls: 0 };
  const wrap = s => ({ bind: (...v) => wrap(s.bind(...v)), first: (...a) => { tally.statements++; tally.calls++; return s.first(...a); }, all: () => { tally.statements++; tally.calls++; return s.all(); }, run: () => { tally.statements++; tally.calls++; return s.run(); }, _execute: () => s._execute() });
  env.DB = { prepare: sql => wrap(db.prepare(sql)), batch: list => { tally.statements += list.length; tally.calls++; return db.batch(list); }, exec: db.exec.bind(db), close: db.close.bind(db) };
  return tally;
}
async function measured(env, tally, x, fn) { await x.ctx.settle(); tally.statements = 0; tally.calls = 0; const result = await fn(); await x.ctx.settle(); return { result, used: tally.statements }; }

for (const [label, key] of [['local opponent', false], ['model-backed opponent', true]]) {
  for (const [difficulty, steps] of [['easy', key ? 3 : 6], ['normal', 3], ['hard', 1], ['jev', 1]]) {
    test(`${label}: catching up on the ${difficulty} profile applies its per-request budget of ${steps} step(s) within the database query ceiling`, async () => {
      const env = environment({ PRACTICE_PACING_MS: '1000', ...(key ? { TYPESAFE_API_KEY: 'k' } : {}), FETCH: modelFetch() }), tally = counted(env), x = await client(env);
      const created = (await x.create({ difficulty })).body; await x.start(created.id); await x.ctx.settle();
      env.clock.advance(1100 * 9);
      const { result, used } = await measured(env, tally, x, () => x.poll(created.id));
      assert.equal(result.body.jev.revision, steps, 'the budget bounds the steps applied in one invocation');
      assert.ok(used <= CEILING, `${used} statements in one invocation`);
    });
  }
}
test('the write paths and the sweep each stay under the query ceiling', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000', TYPESAFE_API_KEY: 'k', FETCH: modelFetch() }), tally = counted(env), x = await client(env);
  const usage = {};
  const created = await measured(env, tally, x, () => x.create({ difficulty: 'jev' })); usage.create = created.used;
  const id = created.result.body.id;
  usage.start = (await measured(env, tally, x, () => x.start(id))).used;
  env.clock.advance(300); const st = (await x.poll(id)).body, cell = st.givens.findIndex(v => !v);
  usage.action = (await measured(env, tally, x, () => x.act(id, 0, { kind: 'set', cell, digit: [1, 2, 3, 4, 5, 6, 7, 8, 9].find(d => !st.givens.some((g, i) => g === d && (Math.floor(i / 9) === Math.floor(cell / 9) || i % 9 === cell % 9 || Math.floor(i / 27) * 3 + Math.floor(i % 9 / 3) === Math.floor(cell / 27) * 3 + Math.floor(cell % 9 / 3)))) }))).used;
  env.clock.advance(50);
  usage.forfeitAndFinalize = (await measured(env, tally, x, () => x.act(id, 1, { kind: 'forfeit' }))).used;
  for (let i = 0; i < 40; i++) { await env.DB.prepare('INSERT INTO operations(name,properties_json,created_at) VALUES(?,?,?)').bind('old', '{}', 1).run(); await env.DB.prepare('INSERT INTO quotas VALUES(?,?,?)').bind(`stale${i}`, 1, 1).run(); }
  resetSweepGate(); env.clock.advance(120000);
  usage.meWithSweep = (await measured(env, tally, x, () => x.send('/api/me'))).used;
  for (const [name, used] of Object.entries(usage)) assert.ok(used <= CEILING, `${name} used ${used} statements`);
  assert.ok(usage.meWithSweep > usage.action, 'the sweep really ran in that invocation');
});
test('a stale-heavy sweep is bounded: reservations, abandoned matches and unfinalized results are each capped', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000' }), tally = counted(env), x = await client(env, { session: false });
  for (let i = 0; i < 6; i++) { const y = await client(env, { remote: `198.51.100.${10 + i}` }); const m = (await y.create()).body; await y.start(m.id); }
  env.clock.advance(3600000); resetSweepGate();
  const { used } = await measured(env, tally, x, () => x.send('/api/health').then(() => import('../server/maintenance.js').then(m => m.sweep(env))));
  assert.ok(used <= CEILING, `${used} statements in a sweep that found six abandoned matches`);
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE status IN ('running','settling')").first();
  assert.ok(left.n >= 4, 'at most two are voided per sweep; the rest wait for the next one');
});
test('a provider request that finishes after the match did is counted in the stored result, in one batch', async () => {
  const env = environment({ TYPESAFE_API_KEY: 'k' }), x = await client(env), created = (await x.create()).body; await x.start(created.id); await x.ctx.settle();
  env.clock.advance(10); await x.act(created.id, 0, { kind: 'forfeit' });
  const read = async () => JSON.parse((await env.DB.prepare('SELECT summary_json FROM results WHERE match_id=?').bind(created.id).first()).summary_json).jev;
  const before = await read();
  await makeAdapter(env).onRequest({ matchId: created.id, name: 'jev_request_finished', properties: { outcome: 'ok', latencyMs: 4, inputTokens: 50, outputTokens: 5 } });
  await makeAdapter(env).onRequest({ matchId: created.id, name: 'jev_request_finished', properties: { outcome: 'timeout', latencyMs: 4, inputTokens: null, outputTokens: null } });
  const after = await read();
  assert.equal(after.requestCount, before.requestCount + 2); assert.equal(after.inputTokens, before.inputTokens + 50); assert.equal(after.outputTokens, before.outputTokens + 5);
  const { analytics } = await import('../server/matches.js'), row = await env.DB.prepare('SELECT owner_hash,user_id FROM matches WHERE id=?').bind(created.id).first();
  assert.equal((await analytics(env, created.id, { hash: row.owner_hash, user_id: row.user_id })).jev.requestCount, after.requestCount, 'the stored summary agrees with a full recomputation');
  await makeAdapter(env).onRequest({ matchId: 'deleted-match', name: 'jev_request_finished', properties: { outcome: 'ok', latencyMs: 1, inputTokens: 1, outputTokens: 1 } });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE match_id='deleted-match'").first()).n, 0, 'no orphan telemetry for a match that no longer exists');
});
