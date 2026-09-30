import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, context, insertMatch, user, publishChallenge, modelFetch, PUZZLE } from './helpers.js';
import { issueSession, hash } from '../server/security.js';
import { readMatch, readEvents, one, all, run } from '../server/db.js';
import { createMatch, startMatch, humanAction, advance, project, ownedMatch, revealMatch, analytics, replayFor, finalize, append, prepareDecision, expireReservations, nextDue } from '../server/matches.js';
import { sweep } from '../server/maintenance.js';
import { leaderboard, operatorReport } from '../server/reports.js';
import { replayEvents } from '../public/shared/replay.js';
import { validateHuman } from '../public/shared/sudoku.js';
import { generatePuzzle } from '../scripts/puzzle-lib.js';
const say = (n, s) => `${n}-${s}-0000`;
async function setup({ jev = false, ...overrides } = {}) {
  const env = environment({ ...(jev ? { TYPESAFE_API_KEY: 'test-key' } : {}), ...overrides }), ctx = context(), session = (await issueSession(env)).row;
  return { env, ctx, session, advance: ms => env.clock.advance(ms) };
}
const eventsOf = (env, id) => readEvents(env, id);
const results = async (env, id) => (await one(env, 'SELECT COUNT(*) AS n FROM results WHERE match_id=?', id)).n;

test('start withholds initial clues until official start and a completed human race is verified against an independent replay', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session);
  assert.equal((await project(x.env, await readMatch(x.env, id))).givens, null);
  let p = await startMatch(x.env, x.ctx, id, x.session); assert.equal(p.givens.length, 81);
  x.advance(200); p = await humanAction(x.env, x.ctx, id, x.session, { requestId: 'first-move-1', expectedHumanRevision: 0, action: { kind: 'set', cell: 0, digit: 5 } });
  x.advance(200); p = await humanAction(x.env, x.ctx, id, x.session, { requestId: 'second-move-1', expectedHumanRevision: 1, action: { kind: 'set', cell: 1, digit: 3 } });
  assert.equal(p.phase, 'settling');
  x.advance(700); const { row } = await advance(x.env, x.ctx, id); assert.equal(row.state.phase, 'finished');
  p = await project(x.env, row); assert.equal(p.verified, true);
  const replay = await replayFor(x.env, id, x.session);
  assert.equal(replayEvents(replay).outcome, 'human', 'the stored events replay, fully re-derived, to the stored result');
  assert.equal(replay.integrity.replayHashAlgorithm, 'event-chain-sha256-v1');
  assert.equal(replay.integrity.replayHash, row.chain_head);
  assert.equal(await results(x.env, id), 1);
  await finalize(x.env, row); assert.equal(await results(x.env, id), 1, 'finalize is idempotent');
});
test('actions are owned, revision checked, idempotent and do not accept fabricated score fields', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, x.ctx, id, x.session);
  await assert.rejects(ownedMatch(x.env, id, (await issueSession(x.env)).row), /owned/);
  const request = { requestId: 'duplicate-move', expectedHumanRevision: 0, action: { kind: 'set', cell: 0, digit: 5 } };
  x.advance(50); await humanAction(x.env, x.ctx, id, x.session, request);
  assert.equal((await humanAction(x.env, x.ctx, id, x.session, request)).human.revision, 1);
  await assert.rejects(humanAction(x.env, x.ctx, id, x.session, { ...request, requestId: 'new-move-123' }), /stale/);
  await assert.rejects(humanAction(x.env, x.ctx, id, x.session, { ...request, requestId: 'forged-score', score: 99999 }), /unknown_request/);
  await assert.rejects(humanAction(x.env, x.ctx, id, x.session, { requestId: 'fabricated', expectedHumanRevision: 1, action: { kind: 'set', cell: 1, digit: 3, elapsedMs: 1 } }), /unknown_action/);
  await assert.rejects(humanAction(x.env, x.ctx, id, x.session, { requestId: 'x', expectedHumanRevision: 1, action: { kind: 'undo' } }), /invalid_request_id/);
});
test('opponent steps are applied lazily at their scheduled time, not at the arrival time of the request that records them', async () => {
  const x = await setup({ jev: true }), id = await insertMatch(x.env, x.session, { difficulty: 'jev' });
  await startMatch(x.env, x.ctx, id, x.session); await x.ctx.settle();
  x.advance(999); assert.equal((await advance(x.env, x.ctx, id)).row.state.jev.revision, 0);
  x.advance(2000); const first = await advance(x.env, x.ctx, id);
  assert.equal(first.row.state.jev.revision, 1, 'the jev profile applies one step per request even though two are overdue');
  await x.ctx.settle(); x.advance(50); const second = await advance(x.env, x.ctx, id);
  assert.ok(second.row.state.jev.finishMs !== null, 'the second step is applied on the next request');
  const steps = (await eventsOf(x.env, id)).filter(e => e.type === 'jev');
  assert.deepEqual(steps.map(e => e.ms), [1000, 2000], 'events carry their scheduled times (1000, 2000), not 3001/3051');
  assert.ok(steps.every(e => ['jev', 'forced'].includes(e.decision.source)) && steps.every(e => e.decision.source === 'forced' || e.decision.model === 'jev-1.13.0'));
  assert.equal(second.row.state.phase, 'running');
});
test('a request applies at most stepBudget due steps and reports that the opponent is behind', async () => {
  const givens = generatePuzzle('lazy-catch-up').givens;
  const x = await setup(), id = await insertMatch(x.env, x.session, { givens, difficulty: 'normal' });
  await startMatch(x.env, undefined, id, x.session);
  x.advance(5500);
  let a = await advance(x.env, undefined, id); assert.equal(a.row.state.jev.revision, 3, 'normal profile budget is 3 steps'); assert.equal(a.behind, true);
  a = await advance(x.env, undefined, id); assert.equal(a.row.state.jev.revision, 5); assert.equal(a.behind, false);
  assert.deepEqual((await eventsOf(x.env, id)).filter(e => e.type === 'jev').map(e => e.ms), [1000, 2000, 3000, 4000, 5000]);
  assert.equal(nextDue(a.row.state, 5500), null);
});
test('a human action waits for every opponent step that was already due, and is then ordered after them', async () => {
  const givens = generatePuzzle('ordering').givens, x = await setup(), id = await insertMatch(x.env, x.session, { givens, difficulty: 'normal' });
  await startMatch(x.env, undefined, id, x.session); x.advance(5200);
  const board = [...givens].map(Number), cell = board.findIndex(v => v === 0), digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(d => { try { validateHuman({ values: board, undo: [] }, board, { kind: 'set', cell, digit: d }); return true; } catch { return false; } });
  const action = { requestId: 'ordered-move-1', expectedHumanRevision: 0, action: { kind: 'set', cell, digit } };
  await assert.rejects(humanAction(x.env, undefined, id, x.session, action), /opponent_syncing/, 'five steps are due but the budget is three');
  let result = null;
  for (let tries = 0; tries < 4 && !result; tries++) { try { result = await humanAction(x.env, undefined, id, x.session, action); } catch (e) { if (e.message !== 'opponent_syncing') throw e; } }
  assert.ok(result, 'the move is accepted once the opponent has caught up');
  const events = await eventsOf(x.env, id), stamps = events.map(e => e.ms);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), 'event times never go backwards');
  assert.deepEqual(events.filter(e => e.type === 'jev').map(e => e.ms), [1000, 2000, 3000, 4000, 5000]);
  const human = events.find(e => e.type === 'human');
  assert.ok(human.ms >= 5200 && events.indexOf(human) > events.findLastIndex(e => e.type === 'jev'), 'the human move follows every opponent step that was due before it');
});
test('the decision lease lets exactly one request spend a provider call per board, and a dead lease can be retaken', async () => {
  const calls = [], x = await setup({ jev: true, FETCH: modelFetch({ calls }) }), id = await insertMatch(x.env, x.session);
  await startMatch(x.env, undefined, id, x.session);
  const row = await readMatch(x.env, id);
  await x.env.DB.prepare('DELETE FROM pending_decisions').run(); calls.length = 0;
  const [a, b, c] = await Promise.all([prepareDecision(x.env, row), prepareDecision(x.env, row), prepareDecision(x.env, row)]);
  assert.deepEqual([a, b, c].map(r => r.status).sort(), ['held', 'held', 'ready']);
  assert.equal(calls.length, 1, 'one provider call for the board');
  await x.env.DB.prepare("UPDATE pending_decisions SET status='inflight',lease_until=? WHERE match_id=?").bind(x.env.NOW() - 1, id).run();
  assert.equal((await prepareDecision(x.env, row)).status, 'ready', 'an expired lease is retaken');
  assert.equal(calls.length, 2);
  await x.env.DB.prepare("UPDATE pending_decisions SET status='inflight',lease_until=? WHERE match_id=?").bind(x.env.NOW() + 60000, id).run();
  assert.equal((await prepareDecision(x.env, row)).status, 'held', 'a live lease is respected');
});
test('append is compare-and-swap: a stale writer loses, a repeated request id is idempotent, and tampered state is refused', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  const before = await readMatch(x.env, id);
  const raced = await append(x.env, id, { type: 'human', ms: 100, action: { kind: 'set', cell: 0, digit: 5 } }, 'cas-one-00', { expect: before.revision });
  assert.equal(raced.conflict, undefined);
  const stale = await append(x.env, id, { type: 'human', ms: 110, action: { kind: 'set', cell: 1, digit: 3 } }, 'cas-two-00', { expect: before.revision });
  assert.equal(stale.conflict, true, 'a writer holding the old revision is refused');
  const again = await append(x.env, id, { type: 'human', ms: 120, action: { kind: 'set', cell: 1, digit: 3 } }, 'cas-one-00');
  assert.equal(again.duplicate, true);
  assert.equal((await eventsOf(x.env, id)).filter(e => e.type === 'human').length, 1);
  await run(x.env, "UPDATE matches SET state_json=json_set(state_json,'$.human.revision',7) WHERE id=?", id);
  await assert.rejects(append(x.env, id, { type: 'human', ms: 130, action: { kind: 'clear', cell: 0 } }, 'cas-three-0'), /state_integrity_failed/);
  assert.equal((await one(x.env, "SELECT COUNT(*) AS n FROM operations WHERE name='verification_failed'")).n, 1);
});
test('ranked analytics and public projection do not leak opponent answers', async () => {
  const x = await setup({ jev: true }), id = await insertMatch(x.env, x.session, { mode: 'ranked', pacingMs: 1000 });
  await startMatch(x.env, x.ctx, id, x.session); await x.ctx.settle(); x.advance(1001);
  const { row, pending } = await advance(x.env, x.ctx, id), p = await project(x.env, row, { pending });
  assert.equal(p.jev.hidden, true); assert.equal(p.decision.action, undefined);
  const a = await analytics(x.env, id, x.session);
  assert.equal(a.jev.decisions[0].digit, undefined); assert.equal(a.jev.decisions[0].candidateEvidence, undefined);
  await assert.rejects(replayFor(x.env, id, x.session), /after_finish/);
  const revealed = await revealMatch(x.env, id, x.session); assert.equal(revealed.eligibility, 'practice'); assert.equal(revealed.jev.hidden, false);
});
test('the model never receives hidden state: no solution grid, no human board, history or result', async () => {
  const calls = [], x = await setup({ jev: true, FETCH: modelFetch({ calls }) }), id = await insertMatch(x.env, x.session);
  await startMatch(x.env, x.ctx, id, x.session); x.advance(100);
  await humanAction(x.env, x.ctx, id, x.session, { requestId: 'human-secret-1', expectedHumanRevision: 0, action: { kind: 'set', cell: 0, digit: 5 } });
  await x.ctx.settle(); x.advance(1100); await advance(x.env, x.ctx, id); await x.ctx.settle();
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    const text = JSON.stringify(call.body);
    for (const banned of ['solution', 'human', 'undo', 'humanFinishMs', 'elapsedMs', 'revision']) assert.equal(text.includes(banned), false, banned);
    assert.equal(call.body.model, 'jev-1.13.0'); assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone'); assert.equal(call.headers.Authorization, 'Bearer test-key');
  }
});
test('provider failure downgrades before the heuristic move and is never labelled jev', async () => {
  const x = await setup({ jev: true, FETCH: modelFetch({ fail: () => new Response('', { status: 401 }) }) }), id = await insertMatch(x.env, x.session, { mode: 'ranked' });
  await startMatch(x.env, x.ctx, id, x.session); await x.ctx.settle(); x.advance(1001);
  const { row } = await advance(x.env, x.ctx, id);
  assert.equal(row.state.eligibility, 'practice'); assert.equal(row.state.providerFallback, true); assert.equal(row.state.jev.revision, 1);
  const events = await eventsOf(x.env, id);
  assert.equal(events[1].type, 'eligibility'); assert.equal(events[1].reason, 'provider_fallback'); assert.equal(events[2].type, 'jev'); assert.equal(events[2].decision.source, 'heuristic_fallback');
  assert.ok(events.filter(e => e.type === 'jev').every(e => e.decision.source !== 'jev'));
});
test('the daily and hourly provider quotas are reserved in D1 and exhaustion falls back explicitly', async () => {
  const calls = [], givens = generatePuzzle('quota-check').givens, x = await setup({ jev: true, MAX_JEV_CALLS_PER_DAY: '1', FETCH: modelFetch({ calls }) }), id = await insertMatch(x.env, x.session, { givens });
  await startMatch(x.env, undefined, id, x.session); x.advance(1001); await advance(x.env, undefined, id); x.advance(1001);
  const { row } = await advance(x.env, undefined, id);
  assert.equal(calls.length, 1, 'only the reserved call reached the provider');
  const steps = (await eventsOf(x.env, id)).filter(e => e.type === 'jev');
  assert.equal(steps[0].decision.source, 'jev'); assert.equal(steps[1].decision.source, 'heuristic_fallback'); assert.equal(steps[1].decision.reason, 'provider_quota_limit');
  assert.equal(row.state.providerFallback, true); assert.equal(row.state.eligibility, 'practice');
  assert.equal((await one(x.env, "SELECT n FROM quotas WHERE n>=1 ORDER BY n DESC LIMIT 1")).n >= 1, true);
});
test('abandoned active attempts are voided when touched and by the lazy sweep, and their result is recorded', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  x.advance(700000);
  const { row } = await advance(x.env, undefined, id, { touch: true });
  assert.equal(row.state.eligibility, 'void'); assert.equal(row.state.phase, 'finished'); assert.equal(row.state.ineligibleReason, 'abandoned');
  assert.equal(await results(x.env, id), 1);
  const other = await insertMatch(x.env, (await issueSession(x.env)).row); await startMatch(x.env, undefined, other, (await ownedSession(x.env, other)));
  x.advance(700000); const done = await sweep(x.env);
  assert.equal(done.abandoned, 1); assert.equal((await readMatch(x.env, other)).state.eligibility, 'void');
});
async function ownedSession(env, id) { const r = await readMatch(env, id); return { hash: r.owner_hash, user_id: r.user_id }; }
test('the time limit ends an attempt at exactly the limit, after every opponent step that was due before it', async () => {
  const x = await setup({ PRACTICE_PACING_MS: '60000' }), id = await insertMatch(x.env, x.session, { pacingMs: 60000 }); await startMatch(x.env, undefined, id, x.session);
  x.advance(3700000);
  const { row } = await advance(x.env, undefined, id, { touch: false });
  assert.equal(row.state.phase, 'finished');
  const events = await eventsOf(x.env, id); assert.equal(events.at(-1).type, 'timeout'); assert.equal(events.at(-1).ms, 3600000);
  await assert.rejects(humanAction(x.env, undefined, id, x.session, { requestId: 'late-move-001', expectedHumanRevision: 0, action: { kind: 'set', cell: 0, digit: 5 } }), /timed_out/);
});
test('finalization refuses a ranked match containing a non-model decision, and records the failed verification', async () => {
  const x = await setup({ jev: true }), id = await insertMatch(x.env, x.session, { mode: 'ranked', pacingMs: 1000 });
  await startMatch(x.env, undefined, id, x.session);
  const row = await readMatch(x.env, id), { getJevCandidates } = await import('../public/shared/sudoku-ai.js');
  const candidates = getJevCandidates(row.state.jev, 'normal').candidates, action = candidates[0];
  await append(x.env, id, { type: 'jev', ms: 1000, action, decision: { source: 'heuristic', actionId: action.id } }, 'forged-step', { candidates });
  await assert.rejects(humanAction(x.env, undefined, id, x.session, { requestId: 'forfeit-forged', expectedHumanRevision: 0, action: { kind: 'forfeit' } }), /ranked_non_jev_opponent/);
  assert.equal(await results(x.env, id), 0, 'no result, so nothing can rank');
  assert.equal((await one(x.env, "SELECT COUNT(*) AS n FROM operations WHERE name='verification_failed'")).n, 1);
});
test('a ranked race with a real model call is verified end to end and appears on the leaderboard', async () => {
  const calls = [], x = await setup({ jev: true, FETCH: modelFetch({ calls }) }), player = await user(x.env), challengeId = await publishChallenge(x.env);
  const created = await createMatch(x.env, player, { requestId: 'ranked-create-1', mode: 'ranked', difficulty: 'normal' });
  assert.equal(created.givens, null); assert.equal(created.challengeId, challengeId);
  await startMatch(x.env, x.ctx, created.id, player); await x.ctx.settle();
  x.advance(9000); await advance(x.env, x.ctx, created.id); await x.ctx.settle();
  const human = async (n, cell, digit, rev) => { x.advance(100); return humanAction(x.env, x.ctx, created.id, player, { requestId: `ranked-move-${n}`, expectedHumanRevision: rev, action: { kind: 'set', cell, digit } }); };
  await human(1, 0, 5, 0); let p = await human(2, 1, 3, 1); assert.equal(p.phase, 'settling');
  x.advance(1200); const { row } = await advance(x.env, x.ctx, created.id); assert.equal(row.state.phase, 'finished');
  const result = await one(x.env, 'SELECT * FROM results WHERE match_id=?', created.id);
  assert.equal(result.eligible, 1); assert.equal(result.replay_hash, row.chain_head);
  const steps = (await eventsOf(x.env, created.id)).filter(e => e.type === 'jev');
  assert.ok(steps.length >= 1 && steps.every(e => ['jev', 'forced'].includes(e.decision.source)) && steps.some(e => e.decision.source === 'jev'));
  assert.ok(calls.length >= 1);
  const replay = await replayFor(x.env, created.id, player); assert.equal(replayEvents(replay).eligibility, 'ranked');
  const board = await leaderboard(x.env, null, new URLSearchParams({ scope: 'world', difficulty: 'normal' }));
  assert.equal(board.entries.length, 1); assert.equal(board.entries[0].display_name, 'Player');
  await assert.rejects(createMatch(x.env, player, { requestId: 'ranked-create-2', mode: 'ranked', difficulty: 'normal' }), /official_attempt_already_used/);
});
test('ranked needs a signed-in player, a configured model and a published challenge', async () => {
  const guest = await setup({ jev: true }); await assert.rejects(createMatch(guest.env, guest.session, { requestId: 'guest-ranked-1', mode: 'ranked' }), /discord_login_required/);
  const p = await user(guest.env); await assert.rejects(createMatch(guest.env, p, { requestId: 'nochallenge-1', mode: 'ranked' }), /daily_challenge_not_published/);
  const local = await setup(), lp = await user(local.env); await assert.rejects(createMatch(local.env, lp, { requestId: 'nokey-ranked-1', mode: 'ranked' }), /ranked_requires_jev/);
});
test('official attempt reservation survives deletion as a short-lived keyed tombstone', async () => {
  const x = await setup({ jev: true }), player = await user(x.env); await publishChallenge(x.env);
  const p = await createMatch(x.env, player, { requestId: 'tombstone-a-1', mode: 'ranked', difficulty: 'normal' });
  await run(x.env, 'DELETE FROM matches WHERE id=?', p.id);
  await assert.rejects(createMatch(x.env, player, { requestId: 'tombstone-b-1', mode: 'ranked', difficulty: 'normal' }), /already_used/);
  const t = await one(x.env, "SELECT * FROM security_tokens WHERE kind='attempt'"); assert.equal(t.user_id, null); assert.equal(t.payload_json, '{}');
});
test('creation is idempotent, single-active per session and per account, and bounded by the global active limit', async () => {
  const x = await setup({ MAX_ACTIVE_MATCHES: '2' }), a = await createMatch(x.env, x.session, { requestId: 'idempotent-1', mode: 'practice' });
  assert.equal((await createMatch(x.env, x.session, { requestId: 'idempotent-1', mode: 'practice' })).id, a.id);
  await assert.rejects(createMatch(x.env, x.session, { requestId: 'idempotent-2', mode: 'practice' }), new RegExp(`active_match_exists:${a.id}`));
  await createMatch(x.env, (await issueSession(x.env)).row, { requestId: 'other-one-01', mode: 'practice' });
  await assert.rejects(createMatch(x.env, (await issueSession(x.env)).row, { requestId: 'other-two-01', mode: 'practice' }), /active_match_limit/);
  const shared = await setup(), s1 = await user(shared.env), s2 = await user(shared.env);
  await createMatch(shared.env, s1, { requestId: 'account-one-1', mode: 'practice' });
  await assert.rejects(createMatch(shared.env, s2, { requestId: 'account-two-1', mode: 'practice' }), /active_match_exists/);
  await assert.rejects(createMatch(shared.env, (await issueSession(shared.env)).row, { requestId: 'bad', mode: 'practice' }), /invalid_request_id/);
  await assert.rejects(createMatch(shared.env, (await issueSession(shared.env)).row, { requestId: 'bad-mode-01', mode: 'zzz' }), /invalid_configuration/);
  await assert.rejects(createMatch(shared.env, (await issueSession(shared.env)).row, { requestId: 'bad-field-1', extra: 1 }), /unknown_match_field/);
});
test('practice puzzles come from the verified pool with a per-match transform and record their source', async () => {
  const x = await setup(), a = await createMatch(x.env, x.session, { requestId: 'pool-source-1', mode: 'practice' });
  const row = await readMatch(x.env, a.id); assert.equal(row.state.config.puzzleSource, 'pool-transform-v1'); assert.equal(row.state.config.engine, 'lazy-schedule-v1');
  const { countSolutions } = await import('../public/shared/sudoku.js');
  const started = await startMatch(x.env, undefined, a.id, x.session);
  assert.equal(countSolutions(started.givens, 2).count, 1);
});
test('an empty puzzle pool is a clear 503, never a silent generator run', async () => {
  const x = await setup(); await run(x.env, 'DELETE FROM puzzle_pool');
  await assert.rejects(createMatch(x.env, x.session, { requestId: 'empty-pool-01', mode: 'practice' }), /puzzle_pool_empty/);
});
test('channel/server/world leaderboards, tied ranks and pagination', async () => {
  const x = await setup(), date = new Date(x.env.NOW()).toISOString().slice(0, 10), cid = await publishChallenge(x.env, 'normal', PUZZLE, date);
  for (let i = 0; i < 4; i++) {
    const uid = String(1000000000 + i), s = await user(x.env, uid, 'Player ' + i);
    const id = await insertMatch(x.env, s, { context: { guildId: i === 3 ? 'g2' : 'g1', channelId: i === 2 ? 'c2' : 'c1' } });
    await run(x.env, 'UPDATE matches SET challenge_id=?,status=? WHERE id=?', cid, 'finished', id);
    const seconds = i < 2 ? 10 : 11;
    await run(x.env, 'INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?)', id, 1, 'human', seconds * 1000, seconds, null, '{}', 'hash', x.env.NOW());
  }
  const context = { user_id: '1000000000', context_json: JSON.stringify({ guildId: 'g1', channelId: 'c1', userId: '1000000000', expiresAt: x.env.NOW() + 60000 }) };
  const p = new URLSearchParams({ date, difficulty: 'normal', scope: 'world', limit: 2 }), page = await leaderboard(x.env, null, p);
  assert.equal(page.entries.length, 2); assert.deepEqual(page.entries.map(e => e.rank), [1, 1]);
  p.set('cursor', page.nextCursor); assert.deepEqual((await leaderboard(x.env, null, p)).entries.map(e => e.rank), [3, 3]);
  assert.equal((await leaderboard(x.env, context, new URLSearchParams({ date, scope: 'server' }))).entries.length, 3);
  assert.equal((await leaderboard(x.env, context, new URLSearchParams({ date, scope: 'channel' }))).entries.length, 2);
  await assert.rejects(leaderboard(x.env, null, new URLSearchParams({ scope: 'channel', date })), /context/);
  await assert.rejects(leaderboard(x.env, null, new URLSearchParams({ date, cursor: 'garbage' })), /cursor/);
});
test('operator reports make empty data and coverage explicit, and count real matches from SQL aggregates', async () => {
  const x = await setup(), empty = await operatorReport(x.env);
  assert.equal(empty.coverage.matches, 0); assert.equal(empty.summary.winRate, null); assert.equal(empty.activity.authenticatedDAU, 0); assert.equal(empty.retention.length, 0);
  await assert.rejects(operatorReport(x.env, { days: 0 }), /days/);
  const id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  x.advance(100); await humanAction(x.env, undefined, id, x.session, { requestId: 'op-forfeit-01', expectedHumanRevision: 0, action: { kind: 'forfeit' } });
  const r = await operatorReport(x.env);
  assert.equal(r.coverage.matches, 1); assert.equal(r.funnel.started, 1); assert.equal(r.funnel.finished, 1); assert.equal(r.funnel.firstAction, 1); assert.equal(r.coverage.completedReports, 1); assert.equal(r.summary.losses, 1);
  assert.equal((await operatorReport(x.env, { difficulty: 'hard' })).coverage.matches, 0);
});
test('expired ready reservations do not permanently block starting another game', async () => {
  const x = await setup(), old = await insertMatch(x.env, x.session);
  await run(x.env, 'UPDATE matches SET created_at=? WHERE id=?', 0, old);
  const next = await createMatch(x.env, x.session, { requestId: 'new-after-expired', mode: 'practice' });
  assert.notEqual(next.id, old); assert.equal((await readMatch(x.env, old)).state.eligibility, 'void');
  assert.equal(await expireReservations(x.env), 0);
});
test('a lazy sweep retries a finished match whose result was never written', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  x.advance(50); await humanAction(x.env, undefined, id, x.session, { requestId: 'sweep-forfeit-1', expectedHumanRevision: 0, action: { kind: 'forfeit' } });
  await run(x.env, 'DELETE FROM results WHERE match_id=?', id); assert.equal(await results(x.env, id), 0);
  const done = await sweep(x.env); assert.equal(done.finalized, 1); assert.equal(await results(x.env, id), 1);
});
test('sweeps purge expired sessions, tokens and quota windows in bounded batches', async () => {
  const x = await setup(), old = x.env.NOW() - 40 * 86400000;
  for (let i = 0; i < 3; i++) { await run(x.env, 'INSERT INTO operations(name,properties_json,created_at) VALUES(?,?,?)', 'old', '{}', old); await run(x.env, 'INSERT INTO quotas VALUES(?,?,?)', `q${i}`, 1, old); }
  await run(x.env, "UPDATE sessions SET expires_at=1"); await run(x.env, "INSERT INTO security_tokens(hash,kind,payload_json,expires_at) VALUES('t','x','{}',1)");
  const done = await sweep(x.env); assert.ok(done.purged >= 8);
  assert.equal((await one(x.env, "SELECT COUNT(*) AS n FROM operations WHERE name='old'")).n, 0);
  assert.equal((await one(x.env, 'SELECT COUNT(*) AS n FROM quotas')).n, 0);
});
test('client telemetry past retention is purged, provider usage is kept, and reports rebuild from what remains', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  const { track } = await import('../server/telemetry.js');
  await track(x.env, id, 'note_added', { cell: 0 }, 'client', 'old-note-fixture', x.env.NOW() - 31 * 86400000); await track(x.env, id, 'note_added', { cell: 1 }, 'client', 'new-note-fixture');
  await track(x.env, id, 'jev_request_finished', { outcome: 'ok', latencyMs: 5, inputTokens: 100, outputTokens: 10 }, 'server', null, x.env.NOW() - 31 * 86400000);
  x.advance(50); await humanAction(x.env, undefined, id, x.session, { requestId: 'purge-forfeit-1', expectedHumanRevision: 0, action: { kind: 'forfeit' } });
  assert.equal((await analytics(x.env, id, x.session)).browser.notesAdded, 2);
  await sweep(x.env);
  const report = await analytics(x.env, id, x.session);
  assert.equal(report.browser.notesAdded, 1); assert.equal(report.browser.focusDwellMsByCell.length, 81); assert.equal(report.game.outcome, 'jev');
  assert.equal(report.jev.requestCount, 1, 'server-trust provider usage is never purged');
  assert.equal((await one(x.env, "SELECT COUNT(*) AS n FROM telemetry WHERE trust='client'")).n, 1);
});
test('a stored result is a small state-derived summary with provider usage, and late provider telemetry refreshes it', async () => {
  const x = await setup(), id = await insertMatch(x.env, x.session); await startMatch(x.env, undefined, id, x.session);
  const { track } = await import('../server/telemetry.js'), { refreshResult } = await import('../server/matches.js');
  await track(x.env, id, 'jev_request_finished', { outcome: 'ok', latencyMs: 5, inputTokens: 100, outputTokens: 10 });
  x.advance(50); await humanAction(x.env, undefined, id, x.session, { requestId: 'summary-forfeit-1', expectedHumanRevision: 0, action: { kind: 'forfeit' } });
  const read = async () => JSON.parse((await one(x.env, 'SELECT summary_json FROM results WHERE match_id=?', id)).summary_json);
  let summary = await read(); assert.equal(summary.game.outcome, 'jev'); assert.equal(summary.game.eligibility, 'practice'); assert.equal(summary.human.acceptedActions, 1); assert.equal(summary.jev.requestCount, 1); assert.equal(summary.jev.inputTokens, 100); assert.equal(summary.jev.outputTokens, 10);
  assert.ok(JSON.stringify(summary).length < 2000, 'small enough to aggregate hundreds per request');
  await track(x.env, id, 'jev_request_finished', { outcome: 'timeout', latencyMs: 5, inputTokens: null, outputTokens: null }); await refreshResult(x.env, id);
  summary = await read(); assert.equal(summary.jev.requestCount, 2); assert.equal(summary.jev.inputTokens, 100);
  const full = await analytics(x.env, id, x.session); assert.equal(full.jev.requestCount, 2); assert.equal(full.jev.inputTokens, summary.jev.inputTokens);
});
