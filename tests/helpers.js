import { openDatabase } from '../local/database.js';
import { assetsBinding } from '../local/server.js';
import { handle } from '../server/worker.js';
import { issueSession } from '../server/security.js';
import { resetSweepGate } from '../server/maintenance.js';
export const PUZZLE = '004678912672195348198342567859761423426853791713924856961537284287419635345286179';
export const KEY = 'a'.repeat(64);
/** A fake provider that always picks the first (canonical) candidate with a provider-shaped, 0.01-grain distribution. */
export function modelFetch({ model = 'jev-1.13.0', calls = [], fail = null } = {}) {
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    if (fail) return fail(calls.length);
    const ids = Object.keys(JSON.parse(options.body).questions.next_action.criteria);
    return Response.json({ model, answers: { next_action: { type: 'choice', choice: ids[0], confidence: 1, probabilities: Object.fromEntries(ids.map((id, i) => [id, i ? 0 : 1])) } }, usage: { input_tokens: 123, output_tokens: 12 } });
  };
  fetchImpl.calls = calls; return fetchImpl;
}
/** A Worker environment over real SQLite (through the D1-compatible shim) with a controllable clock. */
export function environment(overrides = {}) {
  const clock = { time: Date.now(), advance(ms) { clock.time += ms; }, set(ms) { clock.time = ms; } };
  const env = { APP_ORIGIN: 'http://localhost:3000', LAUNCH_SIGNING_KEY: KEY, JEV_MODEL: 'jev-1.13.0', PRACTICE_PACING_MS: '1000',
    DB: openDatabase(), ASSETS: assetsBinding(), NOW: () => clock.time, clock, FETCH: modelFetch(), ...overrides };
  resetSweepGate();
  return env;
}
/** A waitUntil collector: background work (decision preparation, metrics, sweeps) runs for real, tests await settle(). */
export function context() {
  const promises = [];
  return { waitUntil(p) { promises.push(Promise.resolve(p).catch(() => {})); }, async settle() { while (promises.length) await Promise.all(promises.splice(0)); } };
}
let addresses = 0;
/** A distinct documentation-range address per client, so the Worker's per-isolate request limiter never couples unrelated tests. */
const nextAddress = () => { const n = ++addresses; return `198.18.${(n >> 8) & 255}.${n & 255}`; };
/** A cookie/CSRF-aware client for the Worker's own handle(). */
export async function client(env, { ctx = context(), remote = nextAddress(), session = true } = {}) {
  const jar = { cookie: null, csrf: null, bearer: null };
  const send = async (path, { method = 'GET', body, headers = {}, origin = env.APP_ORIGIN, csrf = true } = {}) => {
    const h = new Headers({ 'cf-connecting-ip': remote, ...headers });
    if (jar.cookie && !jar.bearer) h.set('cookie', jar.cookie);
    if (jar.bearer) h.set('authorization', `Bearer ${jar.bearer}`);
    if (body !== undefined) { h.set('content-type', 'application/json'); if (origin) h.set('origin', origin); if (csrf && jar.csrf && !h.has('x-csrf-token')) h.set('x-csrf-token', jar.csrf); }
    const response = await handle(new Request(new URL(path, env.APP_ORIGIN), { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), env, ctx);
    const cookie = response.headers.get('set-cookie'); if (cookie) jar.cookie = cookie.split(';')[0];
    return response;
  };
  const c = { env, ctx, jar, send, async json(path, options) { const r = await send(path, options); return { status: r.status, body: await r.json() }; },
    async me() { const r = await send('/api/me'); const me = await r.json(); jar.csrf = me.csrfToken; return me; },
    async create(options = {}) { return c.json('/api/matches', { method: 'POST', body: { requestId: `create-${Math.random().toString(36).slice(2, 12)}`, mode: 'practice', ...options } }); },
    async start(id) { return c.json(`/api/matches/${id}/start`, { method: 'POST', body: {} }); },
    async act(id, revision, action, requestId = `act-${Math.random().toString(36).slice(2, 12)}`) { return c.json(`/api/matches/${id}/actions`, { method: 'POST', body: { requestId, expectedHumanRevision: revision, action } }); },
    async poll(id) { return c.json(`/api/matches/${id}`); } };
  if (session) await c.me();
  return c;
}
/** Insert a match row directly (fixed puzzle, chosen mode) the way createMatch would, for deterministic tests. */
export async function insertMatch(env, sessionRow, { mode = 'practice', givens = PUZZLE, difficulty = 'normal', pacingMs = 1000, context = null, challengeId = null, official = 0 } = {}) {
  const { createMatchState } = await import('../public/shared/match.js');
  const { hash } = await import('../server/util.js');
  const state = createMatchState(givens, { mode, difficulty, pacingMs, model: 'jev-1.13.0', engine: 'lazy-schedule-v1' }), id = crypto.randomUUID(), head = await hash(state);
  await env.DB.prepare('INSERT INTO matches(id,owner_hash,user_id,challenge_id,guild_id,channel_id,official,create_key,initial_json,state_json,status,revision,head_hash,chain_head,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)')
    .bind(id, sessionRow.hash, sessionRow.user_id, challengeId, context?.guildId ?? null, context?.channelId ?? null, official, `key-${id}`, JSON.stringify({ givens, config: state.config }), JSON.stringify(state), 'ready', head, head, env.NOW(), env.NOW()).run();
  return id;
}
export async function user(env, id = '9876543210', name = 'Player') {
  await env.DB.prepare('INSERT OR IGNORE INTO users VALUES(?,?,?,?,?)').bind(id, name, null, env.NOW(), env.NOW()).run();
  return (await issueSession(env, { userId: id })).row;
}
export async function publishChallenge(env, difficulty = 'normal', givens = PUZZLE, date = new Date(env.NOW()).toISOString().slice(0, 10)) {
  const { hash } = await import('../server/util.js');
  await env.DB.prepare('INSERT INTO challenges VALUES(?,?,?,?,?,?,?,?)').bind(`challenge-${date}-${difficulty}`, date, difficulty, givens, await hash(givens), 'seed',
    JSON.stringify({ difficulty, mode: 'ranked', model: 'jev-1.13.0', pacingMs: 8000, timeLimitMs: 3600000, puzzleBand: 'standard-v1' }), env.NOW()).run();
  return `challenge-${date}-${difficulty}`;
}
