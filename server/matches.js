// Match lifecycle on Workers + D1.
//
// There is no long-lived process, so nothing here relies on timers or in-memory state. The opponent's schedule is a pure
// function of the persisted state and the wall clock: a step is due at lastActionMs + pacingMs. Whenever a request touches a
// match, advance() applies every step that has become due (bounded per request by config.stepBudget), stamping each event with
// its scheduled time rather than the arrival time of the request that happened to record it. The decision for the next step is
// prepared ahead of time (ctx.waitUntil) under a durable lease in `pending_decisions`, exactly like the old in-process scheduler
// prepared it while waiting for the pacing delay. Every append is a compare-and-swap on matches.revision.
import { createMatchState, advanceState, publicState } from '../public/shared/match.js';
import { getJevCandidates, PROFILES } from '../public/shared/sudoku-ai.js';
import { REPLAY_VERSION } from '../public/shared/replay.js';
import { RULES_VERSION } from '../public/shared/sudoku.js';
import { analyzeMatch, redactAnalytics } from '../public/shared/analytics.js';
import { one, all, run, stmt, batch, readMatch, readEvents, readTelemetry, eventBytes, reserve, isConstraint } from './db.js';
import { httpError, hash, hmac, hex, now, utcDay } from './util.js';
import { track, operation } from './telemetry.js';
import { loadConfig } from './config.js';
import { JevAdapter } from './jev.js';
import { practicePuzzle } from './puzzles.js';
/** Recorded in every match config so cohorts produced by this scheduling model are never mixed with another. */
export const ENGINE_VERSION = 'lazy-schedule-v1';
export const REPLAY_HASH_ALGORITHM = 'event-chain-sha256-v1';
const ACTIVE = ['running', 'settling'];
const cleanAction = a => {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !['set', 'clear', 'undo', 'forfeit'].includes(a.kind)) throw httpError(422, 'invalid_action');
  const allowed = a.kind === 'set' ? ['kind', 'cell', 'digit'] : a.kind === 'clear' ? ['kind', 'cell'] : ['kind'];
  if (Object.keys(a).some(k => !allowed.includes(k))) throw httpError(422, 'unknown_action_field');
  return Object.fromEntries(allowed.map(k => [k, a[k]]));
};
const validRequestId = v => typeof v === 'string' && /^[\w-]{8,80}$/.test(v);
export function elapsed(env, row) {
  const s = row.state;
  if (s.phase === 'ready') return 0;
  if (s.phase === 'finished') return s.elapsedMs;
  return Math.max(s.elapsedMs, now(env) - (row.started_at || now(env)));
}
export async function ownedMatch(env, id, session) {
  const row = await readMatch(env, id); if (!row) throw httpError(404, 'match_not_found');
  if (!session || !(row.user_id ? row.user_id === session.user_id : row.owner_hash === session.hash)) throw httpError(403, 'match_not_owned');
  return row;
}
// ---------------------------------------------------------------------------------------------------------------- create
export async function createMatch(env, session, input) {
  const config = loadConfig(env), requestId = input?.requestId;
  if (!validRequestId(requestId)) throw httpError(422, 'invalid_request_id');
  const duplicate = await one(env, 'SELECT id FROM matches WHERE owner_hash=? AND create_key=?', session.hash, requestId);
  if (duplicate) return project(env, await readMatch(env, duplicate.id));
  const difficulty = input.difficulty || 'normal', mode = input.mode || 'practice';
  if (!PROFILES[difficulty] || !['practice', 'ranked'].includes(mode)) throw httpError(422, 'invalid_configuration');
  if (Object.keys(input).some(k => !['requestId', 'difficulty', 'mode'].includes(k))) throw httpError(422, 'unknown_match_field');
  await expireReservations(env, 2);
  const active = await one(env, "SELECT id FROM matches WHERE status!='finished' AND (owner_hash=? OR (user_id IS NOT NULL AND user_id=?))", session.hash, session.user_id);
  if (active) throw httpError(409, `active_match_exists:${active.id}`);
  let challenge = null, clues, attemptKey = null, source = null;
  if (mode === 'ranked') {
    if (!session.user_id) throw httpError(401, 'discord_login_required');
    if (!config.jevKey) throw httpError(503, 'ranked_requires_jev');
    challenge = await one(env, 'SELECT * FROM challenges WHERE utc_date=? AND difficulty=?', utcDay(now(env)), difficulty);
    if (!challenge) throw httpError(503, 'daily_challenge_not_published');
    attemptKey = hex(await hmac(config.launchKey, `daily-attempt:${session.user_id}:${challenge.id}`));
    if (await one(env, 'SELECT 1 AS x FROM matches WHERE user_id=? AND challenge_id=? AND official=1', session.user_id, challenge.id)
      || await one(env, "SELECT 1 AS x FROM security_tokens WHERE hash=? AND kind='attempt' AND expires_at>?", attemptKey, now(env))) throw httpError(409, 'official_attempt_already_used');
    clues = challenge.givens;
  } else { const p = await practicePuzzle(env); clues = p.givens; source = p.source; }
  const gameConfig = { difficulty, mode, pacingMs: mode === 'ranked' ? 8000 : config.pacingMs, timeLimitMs: 3600000, puzzleBand: 'standard-v1', model: config.jevModel,
    engine: ENGINE_VERSION, ...(source ? { puzzleSource: source } : {}), ...(challenge ? JSON.parse(challenge.config_json) : {}) };
  if (mode === 'ranked' && gameConfig.model !== config.jevModel) throw httpError(503, 'challenge_model_mismatch');
  const state = createMatchState(clues, gameConfig), initial = { givens: clues, config: state.config };
  const context = session.context_json ? JSON.parse(session.context_json) : null;
  const validContext = context && context.expiresAt > now(env) && context.userId === session.user_id ? context : null;
  const id = crypto.randomUUID(), at = now(env), head = await hash(state);
  const statements = [stmt(env, `INSERT INTO matches(id,owner_hash,user_id,challenge_id,guild_id,channel_id,official,create_key,initial_json,state_json,status,revision,head_hash,chain_head,created_at,last_seen_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,? WHERE (SELECT COUNT(*) FROM matches WHERE status!='finished')<?`,
    id, session.hash, session.user_id, challenge?.id || null, validContext?.guildId || null, validContext?.channelId || null, mode === 'ranked' ? 1 : 0, requestId,
    JSON.stringify(initial), JSON.stringify(state), 'ready', head, head, at, at, config.maxActive)];
  // The single-use attempt tombstone is written in the same atomic batch, and only if the match row was.
  if (attemptKey) statements.push(stmt(env, 'INSERT INTO security_tokens(hash,kind,payload_json,expires_at,used_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=?)',
    attemptKey, 'attempt', '{}', Date.parse(`${challenge.utc_date}T00:00:00Z`) + 86400000, at, id));
  let results;
  try { results = await batch(env, statements); }
  catch (e) {
    if (!isConstraint(e)) throw e;
    const again = await one(env, 'SELECT id FROM matches WHERE owner_hash=? AND create_key=?', session.hash, requestId); if (again) return project(env, await readMatch(env, again.id));
    const other = await one(env, "SELECT id FROM matches WHERE status!='finished' AND (owner_hash=? OR (user_id IS NOT NULL AND user_id=?))", session.hash, session.user_id);
    if (other) throw httpError(409, `active_match_exists:${other.id}`);
    throw httpError(409, 'official_attempt_already_used');
  }
  if (results[0].meta.changes !== 1) throw httpError(503, 'active_match_limit');
  await operation(env, 'match_reserved', { mode, difficulty, authenticated: !!session.user_id, community: !!validContext });
  return project(env, await readMatch(env, id));
}
export async function expireReservations(env, limit = 5) {
  const at = now(env), today = utcDay(at);
  const stale = await all(env, "SELECT m.id FROM matches m LEFT JOIN challenges c ON c.id=m.challenge_id WHERE m.status='ready' AND (m.created_at<? OR (c.utc_date IS NOT NULL AND c.utc_date!=?)) LIMIT ?", at - 300000, today, limit);
  for (const r of stale) await appendSafe(env, r.id, { type: 'void', ms: 0, reason: 'expired_reservation' }, 'expired-reservation');
  // Reservations are bounded; no disclosed ranked puzzle exists before start.
  await run(env, "DELETE FROM matches WHERE status='ready' AND created_at<?", at - 600000);
  return stale.length;
}
// ------------------------------------------------------------------------------------------------------------------ start
export async function startMatch(env, ctx, id, session) {
  const config = loadConfig(env);
  await expireReservations(env, 2);
  let row = await ownedMatch(env, id, session);
  if (row.state.phase !== 'ready') return project(env, (await advance(env, ctx, row, { touch: true })).row);
  if (row.challenge_id) {
    const ch = await one(env, 'SELECT utc_date FROM challenges WHERE id=?', row.challenge_id);
    if (ch.utc_date !== utcDay(now(env))) { await appendSafe(env, id, { type: 'void', ms: 0, reason: 'expired_reservation' }, 'expired-reservation'); throw httpError(409, 'challenge_day_expired'); }
  }
  const at = now(env);
  await run(env, "UPDATE matches SET started_at=?,deadline_at=?,last_seen_at=? WHERE id=? AND status='ready'", at, at + row.state.config.timeLimitMs, at, id);
  row = (await append(env, id, { type: 'start', ms: 0 }, 'start')).row;
  if (!config.jevKey) row = (await append(env, id, { type: 'eligibility', ms: 0, reason: 'local_opponent' }, 'local-opponent')).row;
  await track(env, id, 'game_started', { mode: row.state.config.mode, difficulty: row.state.config.difficulty });
  const pending = await ensureDecision(env, ctx, row);
  return project(env, row, { pending });
}
// ----------------------------------------------------------------------------------------------------------------- append
const decisionSummary = e => ({ source: e.decision?.source, confidence: e.decision?.confidence ?? null, candidateCount: e.decision?.candidateCount ?? null,
  latencyMs: e.decision?.latencyMs ?? null, technique: e.action.proof.technique, action: e.action });
/**
 * Validate one event against the authoritative state and record it. The event row and the match row change in a single
 * atomic batch guarded by matches.revision (compare-and-swap). `event` may be a function of the freshly read row so system
 * events (timeouts, downgrades, voids) can be re-derived and retried after a lost race. Returns {row} or, when `expect`
 * was given and the match moved, {conflict:true}. A repeated requestId is an idempotent no-op ({row,duplicate:true}). `after`
 * statements commit in the same atomic batch.
 */
export async function append(env, id, event, requestId, { candidates = null, expect = undefined, row: known = null, after = [] } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // A caller that has just read (or appended) the row may hand it over, saving a query; a retry after a lost race always re-reads.
    const row = attempt === 0 && known ? known : await readMatch(env, id); if (!row) throw httpError(404, 'match_not_found');
    if (expect !== undefined && row.revision !== expect) return { conflict: true, row };
    const s = row.state;
    // Every append re-checks the stored state against the hash recorded by the previous append, so the chain is verified link by link.
    if (row.head_hash !== await hash(s)) { await operation(env, 'verification_failed', { reason: 'state_hash_mismatch' }); throw httpError(500, 'state_integrity_failed'); }
    const e = { ...(typeof event === 'function' ? event(row) : event), sequence: s.sequence + 1 };
    const next = advanceState(s, e, { candidates });
    const eventJson = JSON.stringify(e), resulting = await hash(next), chain = await hash(`${row.chain_head}|${eventJson}`);
    const nextJson = JSON.stringify(next), decisionJson = e.type === 'jev' ? JSON.stringify(decisionSummary(e)) : null;
    let results;
    try {
      results = await batch(env, [
        stmt(env, 'INSERT INTO match_events(match_id,sequence,request_id,event_json,previous_hash,resulting_hash,chain_hash) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=? AND revision=?)',
          id, e.sequence, requestId, eventJson, row.head_hash, resulting, chain, id, row.revision),
        stmt(env, 'UPDATE matches SET state_json=?,status=?,revision=?,head_hash=?,chain_head=?,decision_json=COALESCE(?,decision_json) WHERE id=? AND revision=?',
          nextJson, next.phase, e.sequence, resulting, chain, decisionJson, id, row.revision), ...after]);
    } catch (err) {
      if (isConstraint(err)) return { row: await readMatch(env, id), duplicate: true };
      throw err;
    }
    if (results[1].meta.changes !== 1) { if (expect !== undefined) return { conflict: true, row: await readMatch(env, id) }; continue; }
    const result = { ...row, state: next, status: next.phase, state_json: nextJson, revision: e.sequence, head_hash: resulting, chain_head: chain, decision_json: decisionJson ?? row.decision_json };
    if (next.phase === 'finished') await finalize(env, result);
    return { row: result };
  }
  throw httpError(409, 'stale_revision');
}
const appendSafe = async (env, id, event, requestId) => { try { return await append(env, id, event, requestId); } catch (e) { if (e.status === 404) return null; throw e; } };
export const voidMatch = (env, id, reason, requestId = `void-${reason}`) => appendSafe(env, id, row => ({ type: 'void', ms: elapsed(env, row), reason }), requestId);
// ---------------------------------------------------------------------------------------------------------------- advance
/** The earliest scheduled occurrence that is due at `ms`, with timeout/settle taking priority over an opponent step at the same instant. */
export function nextDue(s, ms) {
  if (!ACTIVE.includes(s.phase)) return null;
  const due = [];
  if (ms >= s.config.timeLimitMs) due.push({ type: 'timeout', at: s.config.timeLimitMs, rank: 0 });
  if (s.human.finishMs !== null) { const at = (Math.floor(s.human.finishMs / 1000) + 1) * 1000; if (ms >= at) due.push({ type: 'settle', at, rank: 1 }); }
  if (s.jev.finishMs === null && s.jev.status === 'thinking') { const at = s.jev.lastActionMs + s.config.pacingMs; if (ms >= at) due.push({ type: 'jev', at, rank: 2 }); }
  return due.sort((a, b) => a.at - b.at || a.rank - b.rank)[0] || null;
}
/**
 * Bring a match up to date with the clock. Applies due timeouts, tie-bucket settlements and opponent steps (at most
 * stepBudget[difficulty] steps, so a request stays inside the Workers Free CPU budget) and makes sure the next decision is
 * being prepared. `behind` is true when a due step could not be applied yet (budget spent, or its decision is still in flight).
 * With {touch:true} (the owner's request) a match that nobody has touched for abandonedAfterMs is voided instead.
 */
export async function advance(env, ctx, rowOrId, { touch = false, budget = null } = {}) {
  const config = loadConfig(env);
  let row = typeof rowOrId === 'string' ? await readMatch(env, rowOrId) : rowOrId, steps = 0, behind = false, pending = null;
  if (!row) throw httpError(404, 'match_not_found');
  // A model-backed step issues many more database statements than a local one (lease, quota, telemetry), and Workers Free allows 50
  // per invocation, so those are capped lower.
  const perProfile = config.stepBudget[row.state.config.difficulty] ?? 1;
  const limit = budget ?? (isModelBacked(env, row.state) ? Math.min(perProfile, config.modelStepBudget) : perProfile);
  if (touch && ACTIVE.includes(row.state.phase)) {
    const at = now(env);
    if (at - row.last_seen_at > config.abandonedAfterMs) { const r = await voidMatch(env, row.id, 'abandoned', 'abandoned'); return { row: r?.row || await readMatch(env, row.id), behind: false, pending: null }; }
    if (at - row.last_seen_at > 20000) { await run(env, 'UPDATE matches SET last_seen_at=? WHERE id=?', at, row.id); row = { ...row, last_seen_at: at }; }
  }
  for (let guard = 0; guard < 16; guard++) {
    const s = row.state; if (!ACTIVE.includes(s.phase)) break;
    const ms = now(env) - row.started_at, due = nextDue(s, ms);
    if (!due) { pending = await ensureDecision(env, ctx, row); break; }
    if (due.type !== 'jev') { row = (await append(env, row.id, { type: due.type, ms: Math.max(due.at, s.elapsedMs) }, due.type)).row; continue; }
    if (steps >= limit) { behind = true; break; }
    const r = await applyJevStep(env, ctx, row, due.at);
    row = r.row; if (r.blocked) { behind = true; break; }
    if (r.applied) steps++;
  }
  return { row, behind, pending };
}
/**
 * Start preparing the opponent's next decision if none is prepared or in flight. Returns 'ready' | 'inflight' | null.
 * Only a model-backed opponent has anything worth preparing ahead of time: a local heuristic makes no provider call, so it is decided
 * inline when its step is applied (no lease, no stored row, far fewer database statements).
 */
export async function ensureDecision(env, ctx, row) {
  const s = row.state; if (!ACTIVE.includes(s.phase) || s.jev.finishMs !== null || s.jev.status !== 'thinking') return null;
  if (!isModelBacked(env, s)) return null;
  const p = await one(env, 'SELECT revision,status,lease_until FROM pending_decisions WHERE match_id=?', row.id);
  if (p && p.revision === s.jev.revision && (p.status === 'ready' || p.lease_until > now(env))) return p.status;
  const work = prepareDecision(env, row).catch(async e => { try { await operation(env, 'scheduler_error', { reason: e.code || e.message || 'internal_error' }); } catch { /* best effort */ } });
  if (ctx?.waitUntil) { ctx.waitUntil(work); return 'inflight'; }
  await work; return 'ready';
}
const isModelBacked = (env, s) => !!loadConfig(env).jevKey && !s.providerFallback;
const boardHash = b => hash({ values: b.values, eliminated: b.eliminated, branches: b.branches });
const leaseMs = config => config.timeoutMs * 2 + 4000;
export function makeAdapter(env, config = loadConfig(env)) {
  const fetchImpl = env.FETCH || ((...a) => fetch(...a));
  return new JevAdapter(config, { fetchImpl,
    reserve: async () => await reserve(env, 'jev-day', config.jevCallsPerDay, 86400000) && await reserve(env, 'jev-hour', config.jevCallsPerHour, 3600000),
    // One batch: the telemetry row (guarded, so a late provider call for a since-deleted match cannot violate the foreign key) and, if the
    // match already has a stored result, that result's provider-usage totals. Same arithmetic analyzeMatch applies to these rows.
    onRequest: async e => {
      const p = e.properties, input = Number.isFinite(p.inputTokens) ? p.inputTokens : 0, output = Number.isFinite(p.outputTokens) ? p.outputTokens : 0;
      await batch(env, [
        stmt(env, 'INSERT INTO telemetry(match_id,name,trust,properties_json,client_event_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM matches WHERE id=?)', e.matchId, e.name, 'server', JSON.stringify(p), null, now(env), e.matchId),
        stmt(env, "UPDATE results SET summary_json=json_set(summary_json,'$.jev.requestCount',json_extract(summary_json,'$.jev.requestCount')+1,'$.jev.inputTokens',json_extract(summary_json,'$.jev.inputTokens')+?,'$.jev.outputTokens',json_extract(summary_json,'$.jev.outputTokens')+?) WHERE match_id=?", input, output, e.matchId)]);
    } });
}
/** The decision for a local opponent (no key, or after a provider downgrade): no provider call, so nothing to lease or store. */
async function localDecision(env, row) {
  const s = row.state, t = performance.now(), bundle = getJevCandidates(s.jev, s.config.difficulty), preprocessingMs = performance.now() - t;
  if (!bundle.candidates.length) return { stalled: true };
  const decision = await makeAdapter(env).choose({ board: s.jev, givens: s.givens, bundle, matchId: row.id, forceLocal: true });
  if (s.ineligibleReason !== 'local_opponent') decision.source = 'heuristic_fallback';
  return { decision, candidates: bundle.candidates, preprocessingMs };
}
/**
 * Choose the model-backed opponent's next action for the board at row.state.jev.revision and store it (status='ready'). The INSERT ...
 * ON CONFLICT below is the durable lease: it succeeds for exactly one caller per board, and a crashed holder's lease simply expires.
 * Returns {status:'ready', decision, candidates, preprocessingMs}, {status:'held'} or {status:'stalled'}.
 */
export async function prepareDecision(env, row) {
  const config = loadConfig(env), s = row.state, board = s.jev, at = now(env);
  const stateHash = await boardHash(board);
  const lease = await run(env, `INSERT INTO pending_decisions(match_id,revision,state_hash,status,lease_until,created_at) VALUES(?,?,?,'inflight',?,?)
    ON CONFLICT(match_id) DO UPDATE SET revision=excluded.revision,state_hash=excluded.state_hash,status='inflight',lease_until=excluded.lease_until,decision_json=NULL,bundle_json=NULL,created_at=excluded.created_at
    WHERE pending_decisions.revision<excluded.revision OR (pending_decisions.status='inflight' AND pending_decisions.lease_until<?)`,
    row.id, board.revision, stateHash, at + leaseMs(config), at, at);
  if (lease.meta.changes !== 1) return { status: 'held' };
  const t = performance.now(), bundle = getJevCandidates(board, s.config.difficulty), preprocessingMs = performance.now() - t;
  if (!bundle.candidates.length) {
    await run(env, 'DELETE FROM pending_decisions WHERE match_id=?', row.id);
    await append(env, row.id, r => ({ type: 'jev_stalled', ms: elapsed(env, r) }), `stall-${board.revision}`);
    return { status: 'stalled' };
  }
  const requests = (await one(env, "SELECT COUNT(*) AS n FROM telemetry WHERE match_id=? AND name='jev_request_finished'", row.id)).n;
  const local = requests + 2 > config.maxRequestsPerMatch;
  if (local) await append(env, row.id, r => ({ type: 'eligibility', ms: elapsed(env, r), reason: 'request_budget' }), 'request-budget');
  let decision;
  try {
    decision = await makeAdapter(env, config).choose({ board, givens: s.givens, bundle, matchId: row.id, forceLocal: local });
    if (local && s.ineligibleReason !== 'local_opponent') decision.source = 'heuristic_fallback';
  } catch {
    decision = { candidateCount: bundle.candidates.length, rawCandidateCount: bundle.rawCount, prunedCount: bundle.prunedCount, previewSteps: bundle.previewSteps, source: 'heuristic_fallback',
      reason: 'adapter_error', actionId: bundle.candidates[0].id, boardRevision: board.revision, stateHash, model: null, latencyMs: 0, attempts: 0 };
  }
  await run(env, "UPDATE pending_decisions SET status='ready',decision_json=?,bundle_json=?,lease_until=0 WHERE match_id=? AND revision=? AND status='inflight'",
    JSON.stringify({ ...decision, preprocessingMs }), JSON.stringify(bundle.candidates), row.id, board.revision);
  return { status: 'ready', decision, candidates: bundle.candidates, preprocessingMs };
}
async function applyJevStep(env, ctx, row, dueAt) {
  const s = row.state, board = s.jev, id = row.id;
  let decision, candidates, preprocessingMs, prepared = false;
  if (!isModelBacked(env, s)) {
    const r = await localDecision(env, row);
    if (r.stalled) { const a = await append(env, id, { type: 'jev_stalled', ms: elapsed(env, row) }, `stall-${board.revision}`, { row }); return { row: a.row, applied: false }; }
    ({ decision, candidates, preprocessingMs } = r);
  } else {
    const stateHash = await boardHash(board);
    let pending = await one(env, 'SELECT * FROM pending_decisions WHERE match_id=?', id);
    const usable = p => p && p.status === 'ready' && p.revision === board.revision && p.state_hash === stateHash;
    if (usable(pending)) { decision = JSON.parse(pending.decision_json); candidates = JSON.parse(pending.bundle_json); preprocessingMs = decision.preprocessingMs ?? null; delete decision.preprocessingMs; }
    else {
      if (pending && pending.status === 'inflight' && pending.revision === board.revision && pending.lease_until > now(env)) return { row, blocked: true };
      // Nothing usable was prepared ahead of time (first step, evicted isolate, discarded stale row): decide now, inside this request.
      if (pending && pending.revision === board.revision) await run(env, 'DELETE FROM pending_decisions WHERE match_id=?', id);
      const r = await prepareDecision(env, row);
      if (r.status === 'held') return { row, blocked: true };
      if (r.status === 'stalled') return { row: await readMatch(env, id), applied: false };
      ({ decision, candidates, preprocessingMs } = r);
    }
    prepared = true;
  }
  // The step is stamped with its scheduled time, or with the moment the decision would have been ready in-process (previous step
  // + measured decision latency) if that is later. The lag of the request that records it never enters the game clock.
  const readyAt = s.jev.lastActionMs + Math.ceil(decision.latencyMs || 0) + Math.ceil(preprocessingMs || 0);
  const ms = Math.max(dueAt, readyAt, s.elapsedMs);
  if (ms >= s.config.timeLimitMs) { const r = await append(env, id, { type: 'timeout', ms: Math.max(s.config.timeLimitMs, s.elapsedMs) }, 'timeout', { row }); return { row: r.row, applied: false }; }
  let current = row;
  if (decision.source === 'heuristic_fallback' && !s.providerFallback) {
    current = (await append(env, id, { type: 'eligibility', ms, reason: 'provider_fallback' }, `fallback-${board.revision}`, { row })).row;
    await track(env, id, 'jev_fallback', { reason: decision.reason || 'provider_unavailable' });
  }
  const action = candidates.find(c => c.id === decision.actionId);
  if (!action) { const r = await append(env, id, { type: 'void', ms, reason: 'internal_invalid_decision' }, `invalid-${board.revision}`, { row: current }); return { row: r.row, applied: false }; }
  const enriched = { ...decision, preprocessingMs, pacingWaitMs: Math.max(0, ms - readyAt) };
  // The prepared row is consumed in the same atomic batch as the step it produced.
  const after = prepared ? [stmt(env, 'DELETE FROM pending_decisions WHERE match_id=? AND revision=?', id, board.revision)] : [];
  const r = await append(env, id, { type: 'jev', ms, action, decision: enriched }, `jev-${board.revision}`, { candidates, row: current, after });
  return { row: r.row, applied: !r.duplicate };
}
// ------------------------------------------------------------------------------------------------------------------ human
export async function humanAction(env, ctx, id, session, input) {
  const config = loadConfig(env);
  if (!validRequestId(input?.requestId)) throw httpError(422, 'invalid_request_id');
  let row = await ownedMatch(env, id, session);
  if (await one(env, 'SELECT 1 AS x FROM match_events WHERE match_id=? AND request_id=?', id, input.requestId)) return project(env, row);
  if (Object.keys(input).some(k => !['requestId', 'expectedHumanRevision', 'action'].includes(k))) throw httpError(422, 'unknown_request_field');
  for (let attempt = 0; attempt < 3; attempt++) {
    const advanced = await advance(env, ctx, id, { touch: true });
    row = advanced.row;
    // A human action is ordered after every opponent step that was already due, so it must wait for them (the client retries).
    if (ACTIVE.includes(row.state.phase) && advanced.behind) throw httpError(409, 'opponent_syncing');
    if (row.state.phase === 'finished' && row.state.elapsedMs >= row.state.config.timeLimitMs && row.state.human.finishMs === null && !row.state.human.forfeited) throw httpError(409, 'match_timed_out');
    const ms = elapsed(env, row);
    if (row.state.sequence >= config.maxMatchEvents) { await voidMatch(env, id, 'event_limit', 'event-limit'); throw httpError(429, 'event_limit'); }
    try {
      if (input.expectedHumanRevision !== row.state.human.revision) throw httpError(409, 'stale_human_revision');
      const result = await append(env, id, { type: 'human', ms, action: cleanAction(input.action) }, input.requestId, { expect: row.revision });
      if (result.conflict) continue;
      row = result.row;
      if (row.state.human.finishMs !== null && !result.duplicate) await track(env, id, 'human_completed', { elapsedMs: row.state.human.finishMs });
      return project(env, row, { pending: advanced.pending });
    } catch (e) { await track(env, id, 'action_rejected', { reason: e.code || e.message }); if (!e.status) e.status = 422; throw e; }
  }
  throw httpError(409, 'stale_revision');
}
export async function revealMatch(env, id, session) {
  let row = await ownedMatch(env, id, session);
  if (row.state.phase === 'ready') throw httpError(409, 'match_not_started');
  if (row.state.phase !== 'finished' && row.state.eligibility === 'ranked') row = (await append(env, id, r => ({ type: 'eligibility', ms: elapsed(env, r), reason: 'answers_revealed' }), 'reveal')).row;
  return project(env, row);
}
// --------------------------------------------------------------------------------------------------------------- reports
export async function reportFor(env, row, { evidence = true } = {}) {
  const config = loadConfig(env), [events, telemetry] = await Promise.all([readEvents(env, row.id, { evidence }), readTelemetry(env, row.id)]);
  // Events came out of our own database and were validated when appended and chain-checked on every append, so the replay for
  // analytics skips re-deriving candidates (which would cost hundreds of milliseconds for a long game).
  const report = analyzeMatch(row.initial, events, telemetry, { elapsedMs: elapsed(env, row), inputUsdPerMillion: config.inputUsdPerMillion, outputUsdPerMillion: config.outputUsdPerMillion, trusted: true });
  return report;
}
/**
 * The small list/aggregate view of a match, derived from its state alone (no event replay), in the shape aggregateReports() and the
 * history view read. `usage` adds the provider request counts and token totals recorded as server telemetry.
 */
export function summaryOf(row, usage = null) {
  const s = row.state, clues = s.givens.filter(Boolean).length;
  return { schemaVersion: 'analytics-v1', complete: s.phase === 'finished', dimensions: { difficulty: s.config.difficulty, puzzleBand: s.config.puzzleBand || 'standard-v1', mode: s.config.mode, policyVersion: s.config.policyVersion, model: s.config.model, rulesVersion: s.rulesVersion },
    game: { phase: s.phase, outcome: s.outcome, eligibility: s.eligibility, ineligibleReason: s.ineligibleReason, initialClues: clues, initialEmpty: 81 - clues, durationMs: s.elapsedMs, humanFinishMs: s.human.finishMs, jevFinishMs: s.jev.finishMs, humanCompleted: s.human.finishMs !== null },
    human: { acceptedActions: s.human.revision }, jev: { requestCount: usage?.requestCount ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 } };
}
export const liveSummary = summaryOf;
const providerUsage = async (env, id) => {
  const u = await one(env, "SELECT COUNT(*) AS n,COALESCE(SUM(json_extract(properties_json,'$.inputTokens')),0) AS i,COALESCE(SUM(json_extract(properties_json,'$.outputTokens')),0) AS o FROM telemetry WHERE match_id=? AND trust='server' AND name='jev_request_finished'", id);
  return { requestCount: u.n, inputTokens: u.i, outputTokens: u.o };
};
/** Full candidate evidence for a long game is about a megabyte: parsing and re-serialising it exceeds a Worker request's CPU budget. */
export const EVIDENCE_LIMIT_BYTES = 350000;
export async function analytics(env, id, session, { evidence = true } = {}) {
  const row = await ownedMatch(env, id, session);
  if (evidence && await eventBytes(env, id) > EVIDENCE_LIMIT_BYTES) throw httpError(413, 'evidence_too_large');
  return redactAnalytics(await reportFor(env, row, { evidence }), row.state.eligibility === 'ranked' && row.state.phase !== 'finished');
}
/**
 * The replay document as a JSON string, assembled from the stored event rows without parsing them. A long game's events carry
 * the model's full candidate evidence (about a megabyte), and parsing and re-serialising that would cost more CPU than a
 * Worker request may spend; concatenation costs almost nothing and is byte-for-byte what JSON.stringify of the object gives.
 */
export async function replayJson(env, id, session) {
  const row = await ownedMatch(env, id, session);
  if (row.state.phase !== 'finished') throw httpError(409, 'replay_available_after_finish');
  const [result, events] = await Promise.all([one(env, 'SELECT replay_hash FROM results WHERE match_id=?', id), all(env, 'SELECT event_json FROM match_events WHERE match_id=? ORDER BY sequence', id)]);
  const integrity = JSON.stringify({ replayHash: result?.replay_hash, replayHashAlgorithm: REPLAY_HASH_ALGORITHM, authority: 'server-recorded; downloaded copies are not official submissions' });
  return `{"format":"jev-sudoku-replay","formatVersion":${REPLAY_VERSION},"rulesVersion":${JSON.stringify(RULES_VERSION)},"initial":${row.initial_json},"events":[${events.map(e => e.event_json).join(',')}],"finalState":${row.state_json},"integrity":${integrity}}`;
}
export const replayFor = async (env, id, session) => JSON.parse(await replayJson(env, id, session));
/**
 * Turn a finished match into a result. The full replay is not re-simulated here (that would cost far more than a Worker request
 * may spend); instead the integrity guarantees are the ones enforced on every append: each event was validated against the
 * authoritative state, each state hash was checked against the previous append, and the events form a hash chain whose head
 * becomes the replay hash. This function re-checks the heads, the event count and, for ranked matches, that no non-model
 * decision slipped in.
 */
export async function finalize(env, row) {
  if (await one(env, 'SELECT 1 AS x FROM results WHERE match_id=?', row.id)) return;
  try {
    if (row.head_hash !== await hash(row.state)) throw new Error('broken_state_hash');
    const count = await one(env, 'SELECT COUNT(*) AS n,MAX(sequence) AS m FROM match_events WHERE match_id=?', row.id);
    if (count.n !== row.state.sequence || count.m !== row.state.sequence) throw new Error('broken_hash_chain');
    if (row.state.eligibility === 'ranked' && await one(env, "SELECT 1 AS x FROM match_events WHERE match_id=? AND json_extract(event_json,'$.type')='jev' AND json_extract(event_json,'$.decision.source') NOT IN('jev','forced') LIMIT 1", row.id)) throw new Error('ranked_non_jev_opponent');
    const s = row.state, eligible = Number(s.eligibility === 'ranked' && !!row.user_id && !!row.challenge_id);
    await run(env, 'INSERT OR IGNORE INTO results(match_id,eligible,winner,human_ms,human_bucket,jev_ms,summary_json,replay_hash,verified_at) VALUES(?,?,?,?,?,?,?,?,?)',
      row.id, eligible, s.outcome, s.human.finishMs, s.human.finishMs === null ? null : Math.floor(s.human.finishMs / 1000), s.jev.finishMs, JSON.stringify(summaryOf(row, await providerUsage(env, row.id))), row.chain_head, now(env));
    await operation(env, 'score_verified', { eligible: !!eligible, outcome: s.outcome, difficulty: s.config.difficulty });
  } catch (e) { await operation(env, 'verification_failed', { reason: e.code || e.message }); throw e; }
}
/** Refresh a stored result's provider usage (a provider request finished after the match did). */
export async function refreshResult(env, id) {
  const row = await readMatch(env, id); if (!row || row.state.phase !== 'finished') return;
  await run(env, 'UPDATE results SET summary_json=? WHERE match_id=?', JSON.stringify(summaryOf(row, await providerUsage(env, id))), id);
}
// -------------------------------------------------------------------------------------------------------------- projection
export async function project(env, row, { pending = null } = {}) {
  const config = loadConfig(env), p = publicState(row.state); let decision = null;
  if (row.decision_json) {
    const e = JSON.parse(row.decision_json);
    decision = { source: e.source, confidence: e.confidence ?? null, candidateCount: e.candidateCount ?? null, latencyMs: e.latencyMs ?? null, technique: e.technique };
    if (row.state.eligibility !== 'ranked' || row.state.phase === 'finished') decision.action = e.action;
  }
  if (p.jev && pending === 'ready') p.jev.status = 'ready';
  return { id: row.id, challengeId: row.challenge_id, hasCommunity: !!row.guild_id, serverNow: now(env), startedAt: row.started_at,
    ...p, elapsedMs: elapsed(env, row), decision,
    opponent: !config.jevKey ? 'Local heuristic' : row.state.providerFallback ? 'Heuristic fallback' : 'JEV',
    verified: row.state.phase === 'finished' ? !!(await one(env, 'SELECT 1 AS x FROM results WHERE match_id=?', row.id)) : false };
}
