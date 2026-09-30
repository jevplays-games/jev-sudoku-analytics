// D1 access helpers. `env.DB` is a real D1 binding on Cloudflare and the node:sqlite-backed D1-compatible shim
// (local/database.js) everywhere else, so every query here is async and uses only prepare().bind().first()/all()/run()/batch().
import { httpError, sha256, now } from './util.js';
export const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
export const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
export const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
export const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
export const batch = (env, statements) => env.DB.batch(statements);
export const isConstraint = e => /UNIQUE|constraint|CHECK/i.test(String(e?.message || e));
export function parseMatch(row) { return row ? { ...row, initial: JSON.parse(row.initial_json), state: JSON.parse(row.state_json) } : null; }
export async function readMatch(env, id) { return parseMatch(await one(env, 'SELECT * FROM matches WHERE id=?', id)); }
// With {evidence:false} the per-decision candidate evidence (about 10 KB per opponent step) is stripped inside the database, so the Worker
// never pays to fetch and parse it. Everything else in each event is unchanged.
export async function readEvents(env, id, { evidence = true } = {}) {
  const column = evidence ? 'event_json' : "json_remove(event_json,'$.decision.candidateEvidence') AS event_json";
  return (await all(env, `SELECT ${column} FROM match_events WHERE match_id=? ORDER BY sequence`, id)).map(x => JSON.parse(x.event_json));
}
export async function eventBytes(env, id) { return (await one(env, 'SELECT COALESCE(SUM(length(event_json)),0) AS n FROM match_events WHERE match_id=?', id)).n; }
export async function readTelemetry(env, id) { return (await all(env, 'SELECT name,trust,properties_json,created_at FROM telemetry WHERE match_id=? ORDER BY id', id)).map(t => ({ ...t, properties: JSON.parse(t.properties_json) })); }
/**
 * Fixed-window quota reservation. The counter row is created or incremented atomically and the increment is refused once
 * the limit is reached, so concurrent isolates cannot overspend. Returns false (never throws) when the quota is exhausted.
 */
export async function reserve(env, subject, limit, windowMs) {
  if (!(limit > 0)) return false; // a limit of 0 means "none allowed", never "unlimited"
  const at = now(env), bucket = Math.floor(at / windowMs);
  const id = await sha256(`${env.LAUNCH_SIGNING_KEY || 'local'}|${subject}|${windowMs}|${bucket}`);
  const row = await one(env, 'INSERT INTO quotas(id,n,expires_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET n=n+1 WHERE n<? RETURNING n', id, (bucket + 1) * windowMs, limit);
  return !!row;
}
export async function quota(env, subject, limit, windowMs, code = 'rate_limit') { if (!(await reserve(env, subject, limit, windowMs))) throw httpError(429, code); }
