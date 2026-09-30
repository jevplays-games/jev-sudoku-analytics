// CPU benchmark of the hot request paths, against the 10 ms per-request CPU limit of Workers Free.
//
//   npm run bench:requests                 warm (median/p95/max over N runs) plus one cold first-call per scenario in a fresh process
//   npm run bench:requests -- --runs 40 --out reports/workers/request-cpu.json
//
// What is measured: the full Worker invocation, i.e. handle() plus everything it schedules through ctx.waitUntil (decision
// preparation, metrics, the lazy sweep), because that is what Cloudflare bills against the CPU limit. Time spent inside the
// database is measured separately and subtracted: on Cloudflare a D1 query is a network round trip (wall time, not CPU), whereas
// here node:sqlite executes in-process. `appCpuMs` is therefore the JavaScript CPU an invocation spends; `dbMs` is reported for context.
// The model is a fake that answers immediately, so provider latency is excluded (it is wall time on Workers, not CPU).
// Limits of this evidence: Node/V8 on a developer machine, not the Workers runtime. Workers has no JIT warm-up guarantees and
// its timers do not advance during pure computation, so treat cold numbers as the more relevant ones and expect some variance.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { generateKeyPairSync, sign } from 'node:crypto';
import os from 'node:os';
const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const runs = Number(arg('runs', '30')), out = arg('out', 'reports/workers/request-cpu.json'), only = arg('only', null), once = args.includes('--once');
const BUDGET_MS = 10;
const { openDatabase } = await import('../local/database.js'), { assetsBinding } = await import('../local/server.js'), { handle } = await import('../server/worker.js');
const { issueSession } = await import('../server/security.js'), { resetSweepGate, maintenance } = await import('../server/maintenance.js');
const { generatePuzzle } = await import('./puzzle-lib.js'), { createMatchState } = await import('../public/shared/match.js'), { hash } = await import('../server/util.js');
const { advance, startMatch } = await import('../server/matches.js');
const clock = { time: Date.now() };
let dbMs = 0, dbCalls = 0, dbStatements = 0;
const timed = (f, statements = () => 1) => async (...a) => { dbCalls++; dbStatements += statements(...a); const t = performance.now(); try { return await f(...a); } finally { dbMs += performance.now() - t; } };
function timedDb(db) {
  const wrap = s => ({ bind: (...v) => wrap(s.bind(...v)), first: timed(s.first.bind(s)), all: timed(s.all.bind(s)), run: timed(s.run.bind(s)), _execute: () => s._execute() });
  return { prepare: sql => wrap(db.prepare(sql)), batch: timed(db.batch.bind(db), list => list.length), exec: db.exec.bind(db), close: db.close.bind(db) };
}
const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const model = async (_u, o) => { const ids = Object.keys(JSON.parse(o.body).questions.next_action.criteria); return Response.json({ model: 'jev-1.13.0', answers: { next_action: { type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((id, i) => [id, i ? 0 : 1])) } }, usage: { input_tokens: 100, output_tokens: 10 } }); };
function makeEnv(extra = {}) {
  const env = { APP_ORIGIN: 'http://localhost:3000', LAUNCH_SIGNING_KEY: 'b'.repeat(64), PRACTICE_PACING_MS: '8000', JEV_MODEL: 'jev-1.13.0', TYPESAFE_API_KEY: 'bench-key', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'x',
    DISCORD_PUBLIC_KEY: publicKey, ADMIN_ANALYTICS_TOKEN: 'bench-operator-token', MAX_ACTIVE_MATCHES: '200', MAX_JEV_CALLS_PER_DAY: '1000000', JEV_CALLS_PER_HOUR: '1000000', ...extra,
    DB: timedDb(openDatabase()), ASSETS: assetsBinding(), NOW: () => clock.time, FETCH: model };
  return env;
}
const ctxFactory = () => { const p = []; return { waitUntil(x) { p.push(Promise.resolve(x).catch(() => {})); }, async settle() { while (p.length) await Promise.all(p.splice(0)); } }; };
let ipCounter = 1;
async function client(env) {
  const ctx = ctxFactory(), jar = {}, ip = `198.51.100.${ipCounter++ % 250 + 1}`;
  const send = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const h = new Headers({ 'cf-connecting-ip': ip, ...headers }); if (jar.cookie) h.set('cookie', jar.cookie);
    if (body !== undefined) { h.set('content-type', 'application/json'); h.set('origin', env.APP_ORIGIN); h.set('x-csrf-token', jar.csrf); }
    const r = await handle(new Request(new URL(path, env.APP_ORIGIN), { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const c = r.headers.get('set-cookie'); if (c) jar.cookie = c.split(';')[0]; return r;
  };
  const me = await (await send('/api/me')).json(); jar.csrf = me.csrfToken; await ctx.settle();
  return { send, ctx, jar, session: async () => ({ hash: null }), async json(path, o) { const r = await send(path, o); return r.json(); } };
}
let rid = 0; const id = () => `bench-${Date.now().toString(36)}-${(rid++).toString(36)}-xxxx`;
const create = (c, difficulty, extra = {}) => c.json('/api/matches', { method: 'POST', body: { requestId: id(), difficulty, mode: 'practice', ...extra } });
async function runningMatch(env, c, difficulty) { const m = await create(c, difficulty); await c.json(`/api/matches/${m.id}/start`, { method: 'POST', body: {} }); await c.ctx.settle(); return m.id; }
async function finishedLongMatch(env, c, difficulty, steps) {
  // Play the opponent to its natural end (heuristic-free: fake model), producing a realistic event log.
  const m = await runningMatch(env, c, difficulty);
  for (let i = 0; i < steps; i++) { clock.time += 8100; const r = await c.send(`/api/matches/${m}`); await c.ctx.settle(); const s = await r.json(); if (s.jev.finishMs !== null || s.jev.status === 'stalled') break; }
  return m;
}
let seedRun = 0;
async function seedResults(env, count) {
  const tag = `r${seedRun++}`, s = (await issueSession(env)).row, date = new Date(clock.time).toISOString().slice(0, 10);
  await env.DB.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').bind('9000000001', 'Bench', null, clock.time, clock.time).run();
  const cid = 'bench-challenge'; await env.DB.prepare('INSERT OR IGNORE INTO challenges VALUES(?,?,?,?,?,?,?,?)').bind(cid, date, 'normal', '0'.repeat(81).replace(/0/g, '1'), 'h', 's', '{}', clock.time).run();
  const puzzle = generatePuzzle('bench-seed'), state = createMatchState(puzzle.givens, { difficulty: 'normal', mode: 'ranked' }), head = await hash(state);
  const summary = JSON.stringify({ complete: true, dimensions: { difficulty: 'normal', mode: 'ranked' }, game: { phase: 'finished', outcome: 'human', eligibility: 'ranked', humanCompleted: true, humanFinishMs: 61000, jevFinishMs: 70000 }, human: { acceptedActions: 45 }, jev: { requestCount: 40, inputTokens: 4000, outputTokens: 400 } });
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const mid = `bench-match-${tag}-${i}`, uid = `9${seedRun}${String(i).padStart(8, '0')}`, ranked = i % 2 === 0;
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').bind(uid, 'P' + i, null, clock.time, clock.time));
    stmts.push(env.DB.prepare("INSERT INTO matches(id,owner_hash,user_id,challenge_id,official,create_key,initial_json,state_json,status,revision,head_hash,chain_head,created_at,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,'finished',0,?,?,?,?,?)")
      .bind(mid, 'owner' + i, uid, ranked ? cid : null, ranked ? 1 : 0, 'k' + tag + i, JSON.stringify({ givens: puzzle.givens, config: state.config }), JSON.stringify({ ...state, phase: 'finished', human: { ...state.human, finishMs: 61000, revision: 45 } }), head, head, clock.time - i * 1000, clock.time - i * 1000, clock.time));
    stmts.push(env.DB.prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?)').bind(mid, ranked ? 1 : 0, 'human', 61000, 61 + (i % 20), 70000, summary, 'h', clock.time));
  }
  await env.DB.batch(stmts); return { session: s, challengeDate: date };
}
const scenarios = {
  'GET /api/me (new session)': { prepare: async env => ({ c: await client(env) }), run: async (env, s) => { const r = await handle(new Request('http://localhost:3000/api/me', { headers: { 'cf-connecting-ip': '198.51.100.250' } }), env, s.ctx = ctxFactory()); await r.text(); await s.ctx.settle(); } },
  'GET / (worker-first document)': { prepare: async env => ({ c: await client(env) }), run: async (env, s) => { const r = await s.c.send('/'); await r.text(); await s.c.ctx.settle(); } },
  'POST /api/matches (practice create, pool puzzle)': { prepare: async env => ({ c: await client(env) }), run: async (env, s) => { await s.c.send('/api/matches', { method: 'POST', body: { requestId: id(), difficulty: 'jev', mode: 'practice' } }); await s.c.ctx.settle(); } },
  ...Object.fromEntries(['easy', 'normal', 'hard', 'jev'].map(d => [`POST start (${d}, model-backed) incl. first decision preparation`, { prepare: async env => { const c = await client(env), m = await create(c, d); return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m.id}/start`, { method: 'POST', body: {} }); await s.c.ctx.settle(); } }])),
  'GET poll, nothing due (jev, model-backed)': { prepare: async env => { const c = await client(env); return { c, m: await runningMatch(env, c, 'jev') }; }, run: async (env, s) => { clock.time += 500; await s.c.send(`/api/matches/${s.m}`); await s.c.ctx.settle(); } },
  ...Object.fromEntries(['easy', 'normal', 'hard', 'jev'].map(d => [`model-backed opponent: GET poll applying one due step (${d}) + next decision`, { prepare: async env => { const c = await client(env); const m = await runningMatch(env, c, d); clock.time += 8100; return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m}`); await s.c.ctx.settle(); } }])),
  ...Object.fromEntries(['easy', 'normal', 'hard', 'jev'].map(d => [`model-backed opponent: GET poll catching up ${{ easy: 3, normal: 3, hard: 1, jev: 1 }[d]} due steps (${d}, the per-request budget)`, { prepare: async env => { const c = await client(env); const m = await runningMatch(env, c, d); clock.time += 8100 * 8; return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m}`); await s.c.ctx.settle(); } }])),
  ...Object.fromEntries(['easy', 'normal', 'hard', 'jev'].map(d => [`local opponent: GET poll catching up ${{ easy: 6, normal: 3, hard: 1, jev: 1 }[d]} due steps (${d})`, { env: { TYPESAFE_API_KEY: '' }, prepare: async env => { const c = await client(env); const m = await runningMatch(env, c, d); clock.time += 8100 * 8; return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m}`); await s.c.ctx.settle(); } }])),
  ...Object.fromEntries(['normal', 'jev'].map(d => [`local opponent: GET poll applying one due step (${d})`, { env: { TYPESAFE_API_KEY: '' }, prepare: async env => { const c = await client(env); const m = await runningMatch(env, c, d); clock.time += 8100; return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m}`); await s.c.ctx.settle(); } }])),
  'POST human action (set digit), jev profile': { prepare: async env => { const c = await client(env), m = await runningMatch(env, c, 'jev'); const st = await c.json(`/api/matches/${m}`); return { c, m, st }; }, run: async (env, s) => { clock.time += 300; const cell = s.st.givens.findIndex(v => !v); await s.c.send(`/api/matches/${s.m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: 0, action: { kind: 'set', cell, digit: [1, 2, 3, 4, 5, 6, 7, 8, 9].find(d => !s.st.givens.some((g, i) => g === d && (Math.floor(i / 9) === Math.floor(cell / 9) || i % 9 === cell % 9))) } } }); await s.c.ctx.settle(); } },
  'POST forfeit -> finalize after a full opponent run (normal, ~60 events)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'normal', 200); return { c, m }; }, run: async (env, s) => { const st = await s.c.json(`/api/matches/${s.m}`); if (st.phase === 'finished') return; clock.time += 100; await s.c.send(`/api/matches/${s.m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await s.c.ctx.settle(); } },
  'POST forfeit -> finalize after a full opponent run (jev, ~100 events)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'jev', 300); return { c, m }; }, run: async (env, s) => { const st = await s.c.json(`/api/matches/${s.m}`); if (st.phase === 'finished') return; clock.time += 100; await s.c.send(`/api/matches/${s.m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await s.c.ctx.settle(); } },
  'GET /api/matches/:id/analytics (finished jev match, ~1 MB of evidence: refused with 413)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'jev', 300); const st = await c.json(`/api/matches/${m}`); if (st.phase !== 'finished') await c.send(`/api/matches/${m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await c.ctx.settle(); return { c, m }; }, run: async (env, s) => { const r = await s.c.send(`/api/matches/${s.m}/analytics`); await r.text(); } },
  'GET /api/matches/:id/analytics (finished normal match, full evidence under the size cap)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'normal', 300); const st = await c.json(`/api/matches/${m}`); if (st.phase !== 'finished') await c.send(`/api/matches/${m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await c.ctx.settle(); return { c, m }; }, run: async (env, s) => { const r = await s.c.send(`/api/matches/${s.m}/analytics`); await r.text(); } },
  'GET /api/matches/:id/analytics?evidence=omit (finished jev match, on-screen view)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'jev', 300); const st = await c.json(`/api/matches/${m}`); if (st.phase !== 'finished') await c.send(`/api/matches/${m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await c.ctx.settle(); return { c, m }; }, run: async (env, s) => { const r = await s.c.send(`/api/matches/${s.m}/analytics?evidence=omit`); await r.text(); } },
  'GET /api/matches/:id/analytics?evidence=omit (finished normal match)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'normal', 300); const st = await c.json(`/api/matches/${m}`); if (st.phase !== 'finished') await c.send(`/api/matches/${m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await c.ctx.settle(); return { c, m }; }, run: async (env, s) => { const r = await s.c.send(`/api/matches/${s.m}/analytics?evidence=omit`); await r.text(); } },
  'GET /api/matches/:id/replay (finished jev match)': { prepare: async env => { const c = await client(env), m = await finishedLongMatch(env, c, 'jev', 300); const st = await c.json(`/api/matches/${m}`); if (st.phase !== 'finished') await c.send(`/api/matches/${m}/actions`, { method: 'POST', body: { requestId: id(), expectedHumanRevision: st.human.revision, action: { kind: 'forfeit' } } }); await c.ctx.settle(); return { c, m }; }, run: async (env, s) => { const r = await s.c.send(`/api/matches/${s.m}/replay`); await r.text(); } },
  'POST telemetry batch (50 events)': { prepare: async env => { const c = await client(env), m = await runningMatch(env, c, 'easy'); await c.send('/api/privacy', { method: 'POST', body: { telemetryConsent: true } }); return { c, m }; }, run: async (env, s) => { await s.c.send(`/api/matches/${s.m}/telemetry`, { method: 'POST', body: { events: Array.from({ length: 50 }, () => ({ id: id(), name: 'cell_focus', properties: { cell: 4, durationMs: 1200 } })) } }); } },
  'GET /api/leaderboard (world, 50 entries)': { prepare: async env => { const seeded = await seedResults(env, 120); return { seeded, c: await client(env) }; }, run: async (env, s) => { const r = await s.c.send(`/api/leaderboard?scope=world&difficulty=normal&date=${s.seeded.challengeDate}&limit=50`); await r.text(); } },
  'GET /api/analytics/me (100 matches)': { prepare: async env => { const c = await client(env); const s = await env.DB.prepare("SELECT hash FROM sessions ORDER BY created_at DESC LIMIT 1").first(); await seedResults(env, 120); await env.DB.prepare("UPDATE matches SET owner_hash=? WHERE owner_hash LIKE 'owner%'").bind(s.hash).run(); return { c }; }, run: async (env, s) => { const r = await s.c.send('/api/analytics/me'); await r.text(); } },
  'GET /api/analytics/operator (500 results, uncached)': { prepare: async env => ({ c: await client(env), seeded: await seedResults(env, 500) }), run: async (env, s) => { const r = await s.c.send('/api/analytics/operator?days=30&fresh=1', { headers: { authorization: 'Bearer bench-operator-token' } }); await r.text(); } },
  'GET /api/analytics/operator (cached, 5 min)': { prepare: async env => { const c = await client(env); await seedResults(env, 500); await (await c.send('/api/analytics/operator?days=30', { headers: { authorization: 'Bearer bench-operator-token' } })).text(); return { c }; }, run: async (env, s) => { const r = await s.c.send('/api/analytics/operator?days=30', { headers: { authorization: 'Bearer bench-operator-token' } }); await r.text(); } },
  'POST /api/discord/interactions (signed /jev sudoku)': { prepare: async env => ({ c: await client(env) }), run: async (env, s) => {
    const input = JSON.stringify({ id: String(Date.now()) + rid++, application_id: '123456789012345678', type: 2, data: { name: 'jev', options: [{ name: 'sudoku', type: 1 }] }, member: { user: { id: '9876543210' } }, guild_id: '5555555555', channel_id: '6666666666' });
    const ts = String(Math.floor(clock.time / 1000)), sig = sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(input)]), keys.privateKey).toString('hex');
    const r = await handle(new Request('http://localhost:3000/api/discord/interactions', { method: 'POST', headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': sig, 'content-type': 'application/json' }, body: input }), env, s.c.ctx); await r.text(); } },
  'lazy maintenance sweep (forced, 60 stale rows)': { prepare: async env => { for (let i = 0; i < 60; i++) { await env.DB.prepare('INSERT INTO operations(name,properties_json,created_at) VALUES(?,?,?)').bind('old', '{}', 1).run(); await env.DB.prepare('INSERT INTO quotas VALUES(?,?,?)').bind('q' + i + Math.random(), 1, 1).run(); } return {}; }, run: async env => { resetSweepGate(); await maintenance(env, { force: true }); } }
};
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
async function measure(name, iterations) {
  const spec = scenarios[name], env = makeEnv(spec.env || {}), samples = [];
  for (let i = 0; i < iterations; i++) {
    const state = await spec.prepare(env); resetSweepGate(); await new Promise(r => setImmediate(r));
    dbMs = 0; dbCalls = 0; dbStatements = 0; const t = performance.now(); await spec.run(env, state); const wall = performance.now() - t;
    samples.push({ appCpuMs: Math.max(0, wall - dbMs), dbMs, wallMs: wall, dbCalls, dbStatements });
  }
  return samples;
}
if (only) { const samples = await measure(only, once ? 1 : runs); console.log(JSON.stringify(samples)); process.exit(0); }
const rows = [];
for (const name of Object.keys(scenarios)) {
  const n = /operator \(500/.test(name) ? Math.max(10, Math.floor(runs / 2)) : /jev|finalize/.test(name) && /full opponent run|finished jev|evidence/.test(name) ? Math.max(10, Math.floor(runs / 2)) : runs;
  const warm = (await measure(name, n)).slice(1), cold = JSON.parse(spawnSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--only', name, '--once'], { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout.trim().split('\n').pop())[0];
  const app = warm.map(s => s.appCpuMs), db = warm.map(s => s.dbMs);
  const row = { scenario: name, runs: warm.length, appCpuMs: { median: +pct(app, .5).toFixed(2), p95: +pct(app, .95).toFixed(2), max: +Math.max(...app).toFixed(2) }, coldFirstCallMs: +cold.appCpuMs.toFixed(2), dbMsMedian: +pct(db, .5).toFixed(2), d1Calls: Math.max(...warm.map(s => s.dbCalls)), d1Statements: Math.max(...warm.map(s => s.dbStatements)) };
  row.withinBudget = row.appCpuMs.p95 <= BUDGET_MS; row.coldWithinBudget = row.coldFirstCallMs <= BUDGET_MS; rows.push(row);
  console.log(`${row.withinBudget ? 'ok  ' : 'OVER'} ${name.padEnd(82)} median ${String(row.appCpuMs.median).padStart(6)}  p95 ${String(row.appCpuMs.p95).padStart(6)}  max ${String(row.appCpuMs.max).padStart(6)}  cold ${String(row.coldFirstCallMs).padStart(6)}  (db ${row.dbMsMedian})  d1 calls ${row.d1Calls} stmts ${row.d1Statements}`);
}
const report = { schemaVersion: 'request-cpu-v1', generatedAt: new Date().toISOString(), budgetMs: BUDGET_MS, node: process.version, platform: `${os.platform()} ${os.arch()} ${String(os.cpus()[0]?.model).trim()}`,
  method: 'App JavaScript time per Worker invocation (handle + waitUntil work) with database time subtracted; fake instant model; Node/V8, not the Workers runtime.',
  limits: ['Not measured on Cloudflare: real Workers CPU may differ, especially cold.', 'Provider latency and D1 round trips are wall time on Workers and are excluded.', 'd1Calls/d1Statements are the maximum D1 API calls and statements one invocation issued (Workers Free allows 50 queries per invocation).', 'Timer-based measurements on Workers do not advance during pure computation, so production preprocessingMs fields read as 0.'], scenarios: rows };
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(`Wrote ${out}`);
