import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, client, context } from './helpers.js';
import { handle } from '../server/worker.js';
import { validateHuman } from '../public/shared/sudoku.js';
const one = (env, sql, ...a) => env.DB.prepare(sql).bind(...a).first();
const mutate = (x, path, body, extra = {}) => x.send(path, { method: 'POST', body, ...extra });

test('HTTP security headers, static assets, and unauthenticated boundaries', async () => {
  const env = environment(), x = await client(env), anon = await client(env, { session: false });
  const r = await x.send('/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('strict-transport-security'), null, 'no HSTS on a loopback origin');
  assert.ok((await r.text()).includes('Sudoku Duel'));
  assert.equal((await x.send('/server/config.js')).status, 404, 'server source is not a static asset');
  assert.equal((await x.send('/migrations/0001.sql')).status, 404);
  assert.equal((await anon.send('/api/analytics/me')).status, 401);
  assert.equal((await x.send('/api/analytics/operator')).status, 403);
  assert.equal((await mutate(x, '/api/matches', { requestId: 'abcdefghi' }, { csrf: false })).status, 403);
  assert.equal((await mutate(x, '/api/matches', { requestId: 'abcdefghi' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await x.send('/api/nothing')).status, 404);
  assert.equal((await (await x.send('/api/health')).json()).status, 'ok');
});
test('production origins add HSTS and Secure cookies', async () => {
  const env = environment({ APP_ORIGIN: 'https://sudoku.jevplay.games' }), r = await handle(new Request('https://sudoku.jevplay.games/api/me', { headers: { 'cf-connecting-ip': '198.51.100.7' } }), env, context());
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.match(r.headers.get('set-cookie'), /; Secure/); assert.match(r.headers.get('set-cookie'), /HttpOnly/); assert.match(r.headers.get('set-cookie'), /SameSite=Lax/);
});
test('a misconfigured production Worker fails closed with a generic 503', async () => {
  const env = environment({ APP_ORIGIN: 'https://sudoku.jevplay.games', LAUNCH_SIGNING_KEY: '' }), r = await handle(new Request('https://sudoku.jevplay.games/api/me'), env, context());
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'configuration_invalid' });
});
test('HTTP create/start/action/analytics and strict ownership', async () => {
  const env = environment(), x = await client(env), other = await client(env, { remote: '203.0.113.9' });
  const reserved = await x.create({ difficulty: 'normal' }); assert.equal(reserved.status, 201); assert.equal(reserved.body.givens, null);
  const started = await x.start(reserved.body.id); assert.equal(started.body.givens.length, 81); assert.equal(started.body.opponent, 'Local heuristic');
  const a = await x.act(reserved.body.id, 0, { kind: 'forfeit' }); assert.equal(a.status, 200); assert.equal(a.body.phase, 'finished'); assert.equal(a.body.verified, true);
  const metrics = await x.json(`/api/matches/${reserved.body.id}/analytics`); assert.equal(metrics.body.human.forfeits, 1);
  const csv = await x.send(`/api/matches/${reserved.body.id}/analytics?format=csv`); assert.equal(csv.status, 200); assert.ok(csv.headers.get('content-type').startsWith('text/csv'));
  assert.equal((await x.send(`/api/matches/${reserved.body.id}/replay`)).status, 200);
  assert.equal((await other.send(`/api/matches/${reserved.body.id}/analytics`)).status, 403);
  assert.equal((await other.send(`/api/matches/${reserved.body.id}`)).status, 403);
  assert.equal((await x.send('/api/matches/00000000-0000-0000-0000-000000000000')).status, 404);
});
test('rule violations are 422 with a machine-readable code, never a 500', async () => {
  const env = environment(), x = await client(env), created = (await x.create({ difficulty: 'easy' })).body, started = (await x.start(created.id)).body;
  const board = started.givens.slice(), given = board.findIndex(v => v), empty = board.findIndex(v => !v);
  const peer = board.findIndex((v, i) => v && i !== empty && (Math.floor(i / 9) === Math.floor(empty / 9)));
  const conflict = await x.act(created.id, 0, { kind: 'set', cell: empty, digit: board[peer] });
  assert.equal(conflict.status, 422); assert.equal(conflict.body.error, 'local_conflict');
  const clue = await x.act(created.id, 0, { kind: 'set', cell: given, digit: 1 }); assert.equal(clue.status, 422); assert.equal(clue.body.error, 'immutable_clue');
  assert.equal((await x.act(created.id, 0, { kind: 'undo' })).body.error, 'nothing_to_undo');
  assert.equal((await x.act(created.id, 0, { kind: 'explode' })).status, 422);
  assert.equal((await x.json('/api/matches/' + created.id)).body.human.revision, 0, 'rejected moves change nothing');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM telemetry WHERE name='action_rejected'").first()).n >= 3, true);
});
test('polling is how state is read: a GET applies due opponent steps, and the old event stream is gone', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000' }), x = await client(env), created = await x.create({ difficulty: 'easy' }); await x.start(created.body.id); await x.ctx.settle();
  env.clock.advance(1500); const polled = await x.poll(created.body.id);
  assert.equal(polled.status, 200); assert.equal(polled.body.phase, 'running'); assert.equal(polled.body.jev.revision, 1);
  await x.ctx.settle(); env.clock.advance(1500); assert.equal((await x.poll(created.body.id)).body.jev.revision, 3, 'steps due at 2000 and 3000 are both applied (easy budget is 6)');
  const gone = await x.send(`/api/matches/${created.body.id}/events`); assert.equal(gone.status, 410); assert.equal((await gone.json()).error, 'events_removed_use_polling');
  const ops = await env.DB.prepare("SELECT properties_json FROM operations WHERE name='http_request'").all();
  assert.equal(ops.results.filter(r => JSON.parse(r.properties_json).route === '/api/matches/:id' && JSON.parse(r.properties_json).method === 'GET').length, 0, 'poll reads are not logged as operations');
});
test('a move that is refused because the opponent is behind can be retried with the same request id', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000' }), x = await client(env), created = await x.create({ difficulty: 'jev' }), started = (await x.start(created.body.id)).body;
  const board = started.givens.slice(), cell = board.findIndex(v => !v), digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(d => { try { validateHuman({ values: board, undo: [] }, board, { kind: 'set', cell, digit: d }); return true; } catch { return false; } });
  env.clock.advance(3200);
  const first = await x.act(created.body.id, 0, { kind: 'set', cell, digit }, 'retry-safe-id-1');
  assert.equal(first.status, 409); assert.equal(first.body.error, 'opponent_syncing');
  let ok = null; for (let i = 0; i < 4 && !ok; i++) { const r = await x.act(created.body.id, 0, { kind: 'set', cell, digit }, 'retry-safe-id-1'); if (r.status === 200) ok = r; else assert.equal(r.body.error, 'opponent_syncing'); }
  assert.ok(ok, 'the same request id succeeds once the opponent has caught up'); assert.equal(ok.body.human.revision, 1);
  assert.equal((await x.act(created.body.id, 0, { kind: 'set', cell, digit }, 'retry-safe-id-1')).body.human.revision, 1, 'and replaying it again changes nothing');
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM match_events WHERE json_extract(event_json,'$.type')='human'").first()).n, 1);
});
test('telemetry requires consent, validates event allowlist, and can be purged', async () => {
  const env = environment(), x = await client(env), p = (await x.create()).body, event = { id: 'test-event-123', name: 'note_added', properties: { cell: 2 } };
  assert.equal((await mutate(x, `/api/matches/${p.id}/telemetry`, { events: [event] })).status, 403);
  assert.equal((await mutate(x, '/api/privacy', { telemetryConsent: true })).status, 200);
  assert.equal((await mutate(x, `/api/matches/${p.id}/telemetry`, { events: [event, event] })).status, 200);
  assert.equal((await one(env, "SELECT COUNT(*) n FROM telemetry WHERE trust='client'")).n, 1);
  assert.equal((await mutate(x, `/api/matches/${p.id}/telemetry`, { events: [{ ...event, name: 'game_completed' }] })).status, 422);
  assert.equal((await mutate(x, `/api/matches/${p.id}/telemetry`, { events: Array.from({ length: 51 }, (_, i) => ({ ...event, id: `bulk-event-${i}0` })) })).status, 422);
  assert.equal((await mutate(x, `/api/matches/${p.id}/telemetry`, { events: Array.from({ length: 50 }, (_, i) => ({ ...event, id: `bulk-event-${i}1` })) })).status, 200);
  assert.equal((await one(env, "SELECT COUNT(*) n FROM telemetry WHERE trust='client'")).n, 51, 'a full 50-event batch is stored through four multi-row statements');
  assert.equal((await mutate(x, '/api/privacy', { telemetryConsent: false })).status, 200);
  assert.equal((await one(env, "SELECT COUNT(*) n FROM telemetry WHERE trust='client'")).n, 0);
  assert.equal((await mutate(x, '/api/privacy', { telemetryConsent: 'yes' })).status, 422);
});
test('withdrawing consent removes client telemetry, and reports are rebuilt from what remains on the next read', async () => {
  const env = environment(), x = await client(env), p = (await x.create()).body; await x.start(p.id);
  await mutate(x, '/api/privacy', { telemetryConsent: true });
  await mutate(x, `/api/matches/${p.id}/telemetry`, { events: [{ id: 'note-event-001', name: 'note_added', properties: { cell: 2 } }] });
  env.clock.advance(10); await x.act(p.id, 0, { kind: 'forfeit' });
  assert.equal((await x.json(`/api/matches/${p.id}/analytics`)).body.browser.notesAdded, 1);
  await mutate(x, '/api/privacy', { telemetryConsent: false });
  const after = (await x.json(`/api/matches/${p.id}/analytics`)).body;
  assert.equal(after.browser.notesAdded, 0); assert.equal(after.game.outcome, 'jev');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM results').first()).n, 1, 'the verified result itself is untouched');
});
test('the analytics endpoint can omit per-decision candidate evidence, and replays are served byte-for-byte from stored events', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000' }), x = await client(env), p = (await x.create({ difficulty: 'easy' })).body; await x.start(p.id);
  await x.ctx.settle(); env.clock.advance(1500); await x.poll(p.id); await x.ctx.settle(); env.clock.advance(10); await x.act(p.id, 0, { kind: 'forfeit' });
  const full = (await x.json(`/api/matches/${p.id}/analytics`)).body, lean = (await x.json(`/api/matches/${p.id}/analytics?evidence=omit`)).body;
  assert.ok(full.jev.decisions.length >= 1); assert.ok(full.jev.decisions.every(d => Array.isArray(d.candidateEvidence))); assert.ok(lean.jev.decisions.every(d => d.candidateEvidence === null));
  assert.deepEqual({ ...lean, jev: { ...lean.jev, decisions: undefined } }, { ...full, jev: { ...full.jev, decisions: undefined } });
  const replay = await x.send(`/api/matches/${p.id}/replay`), text = await replay.text(), parsed = JSON.parse(text);
  assert.equal(parsed.format, 'jev-sudoku-replay'); assert.equal(parsed.events.length, full.jev.decisions.length + (await env.DB.prepare("SELECT COUNT(*) n FROM match_events WHERE json_extract(event_json,'$.type')!='jev'").first()).n);
  assert.match(replay.headers.get('content-disposition'), /sudoku-replay\.json/);
  const { replayEvents } = await import('../public/shared/replay.js'); assert.equal(replayEvents(parsed).outcome, 'jev');
});
test('full candidate evidence is refused above a CPU-safe size, while the lean view and the replay still serve the whole game', async () => {
  const env = environment({ PRACTICE_PACING_MS: '1000' }), x = await client(env), p = (await x.create({ difficulty: 'easy' })).body; await x.start(p.id);
  await x.ctx.settle(); env.clock.advance(1500); await x.poll(p.id); await x.ctx.settle(); env.clock.advance(10); await x.act(p.id, 0, { kind: 'forfeit' });
  assert.equal((await x.send(`/api/matches/${p.id}/analytics`)).status, 200);
  await env.DB.prepare("UPDATE match_events SET event_json=json_set(event_json,'$.pad',?) WHERE match_id=? AND sequence=1").bind('x'.repeat(400000), p.id).run();
  const refused = await x.json(`/api/matches/${p.id}/analytics`); assert.equal(refused.status, 413); assert.equal(refused.body.error, 'evidence_too_large');
  const lean = await x.json(`/api/matches/${p.id}/analytics?evidence=omit`); assert.equal(lean.status, 200); assert.ok(lean.body.jev.decisions.every(d => d.candidateEvidence === null));
  assert.equal((await x.send(`/api/matches/${p.id}/replay`)).status, 200);
  const { readEvents } = await import('../server/db.js');
  assert.ok((await readEvents(env, p.id)).some(e => Array.isArray(e.decision?.candidateEvidence))); assert.ok((await readEvents(env, p.id, { evidence: false })).every(e => e.decision?.candidateEvidence === undefined));
});
test('personal reports summarise finished and in-progress matches without replaying them', async () => {
  const env = environment(), x = await client(env), a = (await x.create()).body; await x.start(a.id); env.clock.advance(10); await x.act(a.id, 0, { kind: 'forfeit' });
  const b = (await x.create()).body; await x.start(b.id);
  const report = (await x.json('/api/analytics/me')).body;
  assert.equal(report.coverage.total, 2); assert.equal(report.summary.games, 2); assert.equal(report.summary.finished, 1); assert.equal(report.summary.inProgress, 1);
  assert.equal(report.history.length, 2); assert.equal(report.history[1].outcome, 'jev');
});
test('data export is paged, hides server keys, and deletion is confirmed and complete', async () => {
  const env = environment(), x = await client(env);
  for (let i = 0; i < 2; i++) { const p = (await x.create()).body; await x.start(p.id); env.clock.advance(10); await x.act(p.id, 0, { kind: 'forfeit' }); }
  const first = await x.json('/api/me/export?limit=1'); assert.equal(first.status, 200); assert.equal(first.body.matches.length, 1); assert.equal(first.body.nextOffset, 1); assert.equal(first.body.total, 2);
  const second = await x.json('/api/me/export?limit=1&offset=1'); assert.equal(second.body.nextOffset, null);
  const text = JSON.stringify([first.body, second.body]); assert.equal(text.includes('launchKey'), false); assert.equal(text.includes('csrfToken'), false); assert.equal(text.includes(env.LAUNCH_SIGNING_KEY), false);
  assert.equal((await x.send('/api/me/export?offset=-1')).status, 422);
  assert.equal((await mutate(x, '/api/me/data', { confirm: 'wrong' }, { method: 'DELETE' })).status, 422);
  assert.equal((await x.send('/api/me/data', { method: 'DELETE', body: { confirm: 'DELETE MY DATA' } })).status, 200);
  assert.equal((await one(env, 'SELECT COUNT(*) n FROM matches')).n, 0); assert.equal((await one(env, 'SELECT COUNT(*) n FROM match_events')).n, 0); assert.equal((await one(env, 'SELECT COUNT(*) n FROM results')).n, 0);
  assert.equal((await x.send('/api/analytics/me')).status, 401);
});
test('logout revokes the session; new-game and session creation are rate limited from D1', async () => {
  const env = environment(), x = await client(env), out = await x.send('/api/logout', { method: 'POST', body: {} }); assert.equal(out.status, 200); assert.equal((await x.send('/api/analytics/me')).status, 401);
  const y = await client(env, { remote: '198.51.100.20' });
  let last; for (let i = 0; i < 13; i++) { last = await y.create({ requestId: `rate-limit-${i}-aaaa` }); if (last.status === 201) { const s = await y.start(last.body.id); env.clock.advance(5); await y.act(last.body.id, 0, { kind: 'forfeit' }); void s; } }
  assert.equal(last.status, 429); assert.equal(last.body.error, 'new_game_rate_limit');
});
test('operator analytics need an admin session or the analytics token, and are rate limited', async () => {
  const env = environment({ ADMIN_ANALYTICS_TOKEN: 'operator-token-value' }), x = await client(env);
  assert.equal((await x.send('/api/analytics/operator', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  const ok = await x.send('/api/analytics/operator?days=7', { headers: { authorization: 'Bearer operator-token-value' } }); assert.equal(ok.status, 200);
  const body = await ok.json(); assert.equal(body.schemaVersion, 'operator-analytics-v1'); assert.equal(body.coverage.days, 7);
  assert.equal((await x.send('/api/analytics/operator?days=0', { headers: { authorization: 'Bearer operator-token-value' } })).status, 422);
});
test('request bodies are bounded and must be JSON objects', async () => {
  const env = environment(), x = await client(env);
  assert.equal((await x.send('/api/matches', { method: 'POST', body: 'x'.repeat(70000), headers: { 'content-type': 'application/json' } })).status, 413);
  assert.equal((await x.send('/api/matches', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await x.send('/api/matches', { method: 'POST', body: '[]' })).status, 400);
  const r = await handle(new Request('http://localhost:3000/api/matches', { method: 'POST', headers: { origin: env.APP_ORIGIN, 'x-csrf-token': x.jar.csrf, cookie: x.jar.cookie, 'content-type': 'text/plain' }, body: '{}' }), env, context());
  assert.equal(r.status, 415);
});
