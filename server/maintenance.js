// Lazy maintenance. Cloudflare Workers Free allows five cron triggers for the whole account and they are all in use, so there is
// no scheduler: every API request may opportunistically run one small, bounded sweep through ctx.waitUntil. A D1 compare-and-swap
// on `meta` keeps it to roughly one sweep per interval across all isolates, and every step is LIMITed so a sweep is always cheap
// (Workers Free allows 50 database queries per invocation, so a sweep stays well under that even when it finds work).
import { all, run, parseMatch } from './db.js';
import { now } from './util.js';
import { loadConfig } from './config.js';
import { operation } from './telemetry.js';
import { expireReservations, voidMatch, finalize } from './matches.js';
export const SWEEP_INTERVAL_MS = 60000;
let lastAttempt = 0;
export const resetSweepGate = () => { lastAttempt = 0; };
/** Run one sweep if none ran in the last interval anywhere. Never throws; returns what it did, or null when gated. */
export async function maintenance(env, { force = false } = {}) {
  const at = now(env);
  if (!force && at - lastAttempt < SWEEP_INTERVAL_MS) return null;
  lastAttempt = at;
  try {
    const gate = await run(env, 'INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE meta.value<?', 'sweep', at, force ? at + 1 : at - SWEEP_INTERVAL_MS);
    if (gate.meta.changes !== 1) return null;
    return await sweep(env, at);
  } catch { return null; }
}
export async function sweep(env, at = now(env)) {
  const config = loadConfig(env), done = { expiredReservations: 0, abandoned: 0, finalized: 0, purged: 0 };
  done.expiredReservations = await expireReservations(env, 2);
  // Active attempts nobody has touched: the opponent cannot be raced fairly without requests, so they are voided (documented semantics).
  for (const { id } of await all(env, "SELECT id FROM matches WHERE status IN('running','settling') AND last_seen_at<? LIMIT 2", at - config.abandonedAfterMs)) { await voidMatch(env, id, 'abandoned', 'abandoned'); done.abandoned++; }
  // A finish whose result write failed is retried here, so a verified result is never lost to one failed request.
  for (const row of await all(env, "SELECT m.* FROM matches m LEFT JOIN results r ON r.match_id=m.id WHERE m.status='finished' AND r.match_id IS NULL LIMIT 1")) {
    try { await finalize(env, parseMatch(row)); done.finalized++; } catch { /* verification_failed is already recorded as an operation */ }
  }
  const purge = async (sql, ...args) => { const r = await run(env, sql, ...args); done.purged += r.meta.changes; };
  await purge('DELETE FROM operations WHERE rowid IN(SELECT rowid FROM operations WHERE created_at<? LIMIT 500)', at - config.operationRetentionDays * 86400000);
  await purge('DELETE FROM security_tokens WHERE rowid IN(SELECT rowid FROM security_tokens WHERE expires_at<? LIMIT 500)', at);
  await purge('DELETE FROM sessions WHERE rowid IN(SELECT rowid FROM sessions WHERE expires_at<? LIMIT 500)', at);
  await purge('DELETE FROM quotas WHERE rowid IN(SELECT rowid FROM quotas WHERE expires_at<? LIMIT 500)', at);
  await purge("DELETE FROM pending_decisions WHERE rowid IN(SELECT p.rowid FROM pending_decisions p JOIN matches m ON m.id=p.match_id WHERE m.status='finished' LIMIT 200)");
  // Optional client telemetry past retention. Provider request usage (server trust) stays with the match so costs are never lost.
  // Nothing is cached from it (reports are rebuilt from the retained rows on demand), so there is nothing else to fix up.
  await purge("DELETE FROM telemetry WHERE rowid IN(SELECT rowid FROM telemetry WHERE trust='client' AND created_at<? LIMIT 500)", at - config.detailedRetentionDays * 86400000);
  if (done.abandoned || done.finalized) await operation(env, 'sweep', done);
  return done;
}
/** Consent withdrawal: delete this player's client telemetry. Reports are rebuilt from what remains the next time they are read. */
export async function withdrawTelemetry(env, session) {
  await run(env, "DELETE FROM telemetry WHERE trust='client' AND match_id IN (SELECT id FROM matches WHERE owner_hash=? OR (user_id IS NOT NULL AND user_id=?))", session.hash, session.user_id);
}
