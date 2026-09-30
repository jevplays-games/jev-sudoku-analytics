// JEV Sudoku Worker: one handle(request, env, ctx) written against Web APIs only. Cloudflare runs it directly (wrangler.jsonc);
// local/server.js adapts Node's http server to it with a node:sqlite-backed D1-compatible `env.DB`. Business logic never branches on
// the runtime; only `env` differs.
import './warmup.js';
import { loadConfig } from './config.js';
import { HttpError, httpError, json, readJson, readBody, same, now } from './util.js';
import { one, all, run, stmt, batch, readMatch, quota } from './db.js';
import { getSession, prepareSession, sessionCookie, requireCsrf, RateLimiter } from './security.js';
import { startOAuth, finishOAuth, redeemContext, handleInteraction, activityConfig, activitySession } from './auth.js';
import { track, operation, validateClientEvent } from './telemetry.js';
import { leaderboard, personalReports, operatorReport } from './reports.js';
import { createMatch, startMatch, humanAction, revealMatch, advance, ownedMatch, project, analytics, replayJson } from './matches.js';
import { maintenance, withdrawTelemetry } from './maintenance.js';
import { toCsv } from '../public/shared/analytics.js';
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
// Discord shows an Activity inside its own iframe. Only a document loaded with Discord's frame_id may be framed, and only by Discord.
export const ACTIVITY_FRAME_ANCESTORS = 'frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
const normalizeRoute = path => path.replace(/\/api\/matches\/[^/]+/, '/api/matches/:id');
const rate = new RateLimiter();
const LIGHT = new Set(['GET /api/me', 'POST /api/matches', 'GET /api/leaderboard', 'GET /api/analytics/me', 'POST /api/activity/session']);
const noop = { waitUntil() {} };
export async function handle(request, env, ctx = undefined) {
  const started = performance.now(), url = new URL(request.url), path = url.pathname, isApi = path.startsWith('/api/');
  let response, config = null;
  try {
    try { config = loadConfig(env); } catch { throw httpError(503, 'configuration_invalid'); }
    response = isApi ? await api(request, env, ctx, url, config) : await env.ASSETS.fetch(request);
  } catch (e) {
    // Validation failures from the pure rules code carry a status and a machine-readable message (e.g. 422 local_conflict); anything
    // else is an internal error and reveals nothing about itself.
    const known = e instanceof HttpError || Number.isInteger(e?.status), status = known ? e.status : 500;
    if (status === 500) console.error(JSON.stringify({ type: 'request_failed', path: normalizeRoute(path), name: e?.name }));
    response = json({ error: known ? (e.code || e.message) : 'internal_error' }, status, status === 429 ? { 'Retry-After': '60' } : {});
    if (isApi && config && env.DB) defer(ctx, recordFailure(env, path, status, e));
  }
  if (isApi && config && env.DB) {
    const poll = request.method === 'GET' && /^\/api\/matches\/[^/]+$/.test(path);
    if (!poll && path !== '/api/health') defer(ctx, operation(env, 'http_request', { route: normalizeRoute(path), method: request.method, status: response.status, durationMs: performance.now() - started }).catch(() => {}));
    // The sweep piggybacks only on light requests; a match poll may already be spending most of its 50-query budget on opponent steps.
    if (LIGHT.has(`${request.method} ${path}`)) defer(ctx, maintenance(env).catch(() => {}));
  }
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (!isApi && url.searchParams.has('frame_id')) { headers.delete('X-Frame-Options'); headers.set('Content-Security-Policy', SECURITY_HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", ACTIVITY_FRAME_ANCESTORS)); }
  if (config?.production) headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function defer(ctx, promise) { if (ctx?.waitUntil) ctx.waitUntil(promise); }
async function recordFailure(env, path, status, error) {
  try {
    if ([401, 403, 429].includes(status)) await operation(env, 'security_rejected', { route: normalizeRoute(path), status, reason: error.code || error.message });
    if (status >= 500) await operation(env, 'request_error', { route: normalizeRoute(path), reason: error instanceof HttpError ? error.code : 'internal_error' });
  } catch { /* metrics are best effort */ }
}
const clientIp = (request, env) => request.headers.get('cf-connecting-ip') || (loadConfig(env).production ? 'unknown' : 'local');
async function api(request, env, ctx, url, config) {
  const path = url.pathname, method = request.method, remote = clientIp(request, env);
  if (!rate.allow(`ip:${remote}`, 1200, 60000)) throw httpError(429, 'request_rate_limit');
  if (method === 'GET' && path === '/api/health') return json({ status: 'ok', runtime: 'workers' });
  if (path === '/api/discord/interactions' && method === 'POST') return json(await handleInteraction(env, config, request, await readBody(request)));
  if (path === '/api/activity/config' && method === 'GET') return json(activityConfig(config));
  if (path === '/api/activity/session' && method === 'POST') {
    await quota(env, `activity-session:${remote}`, 300, 3600000, 'session_rate_limit');
    return json(await activitySession(env, config, request.headers.get('origin'), (await readJson(request)).code, env.FETCH));
  }
  let session = await getSession(env, request);
  const cookieHeaders = {};
  const ensureSession = async () => { if (!session) { const issued = await prepareSession(env); await issued.insert.run(); session = issued.row; cookieHeaders['Set-Cookie'] = sessionCookie(issued.raw, config.production); } return session; };
  if (path === '/api/me' && method === 'GET') {
    await ensureSession();
    let context = session.context_json ? JSON.parse(session.context_json) : null; if (context?.expiresAt <= now(env)) context = null;
    const user = session.user_id ? await one(env, 'SELECT id,display_name FROM users WHERE id=?', session.user_id) : null;
    const active = await one(env, "SELECT id,status FROM matches WHERE status!='finished' AND (owner_hash=? OR (user_id IS NOT NULL AND user_id=?)) ORDER BY created_at DESC LIMIT 1", session.hash, session.user_id) || null;
    return json({ user, csrfToken: session.csrf, context: context ? { guildId: context.guildId, channelId: context.channelId, expiresAt: context.expiresAt } : null,
      telemetryConsent: !!session.telemetry_consent, activeMatch: active, admin: !!user && config.admins.includes(user.id),
      capabilities: { discord: !!config.discordClientId && !!config.discordClientSecret, jev: !!config.jevKey, ranked: !!config.jevKey && !!config.discordClientId }, version: '1.0.0' }, 200, cookieHeaders);
  }
  if (path === '/api/auth/discord' && method === 'GET') {
    await ensureSession();
    return new Response(null, { status: 302, headers: { Location: await startOAuth(env, config, session), 'Cache-Control': 'no-store', ...cookieHeaders } });
  }
  if (path === '/api/auth/discord/callback' && method === 'GET') {
    try {
      const issued = await finishOAuth(env, config, session, url.searchParams, env.FETCH);
      return new Response(null, { status: 302, headers: { Location: '/#login=success', 'Set-Cookie': sessionCookie(issued.raw, config.production) } });
    } catch (e) { await operation(env, 'oauth_failed', { reason: e.status ? e.message : 'provider_error' }); return new Response(null, { status: 302, headers: { Location: '/#login=failed' } }); }
  }
  if (path === '/api/leaderboard' && method === 'GET') return json(await leaderboard(env, session, url.searchParams));
  if (path === '/api/analytics/operator' && method === 'GET') {
    const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer /, '');
    const allowed = session?.user_id && config.admins.includes(session.user_id) || config.analyticsToken && same(bearer, config.analyticsToken);
    if (!allowed) throw httpError(403, 'operator_access_required');
    if (!rate.allow(`operator:${session?.hash || remote}`, 20, 60000)) throw httpError(429, 'analytics_rate_limit');
    const days = Number(url.searchParams.get('days') || 30), difficulty = url.searchParams.get('difficulty') || null, key = `operator:${days}:${difficulty || ''}`;
    // The report scans up to a thousand result summaries; serving it from a five-minute cache keeps repeated dashboard loads far below the CPU limit.
    const cached = await one(env, 'SELECT body FROM report_cache WHERE key=? AND expires_at>?', key, now(env));
    if (cached && url.searchParams.get('fresh') !== '1') return new Response(cached.body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Report-Cache': 'hit' } });
    const body = JSON.stringify(await operatorReport(env, { days, difficulty }));
    await run(env, 'INSERT INTO report_cache(key,expires_at,body) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET expires_at=excluded.expires_at,body=excluded.body', key, now(env) + 300000, body);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Report-Cache': 'miss' } });
  }
  if (!session) throw httpError(401, 'session_required');
  if (['POST', 'DELETE', 'PATCH'].includes(method)) requireCsrf(request, session, config.origin, config.activityOrigin);
  if (path === '/api/logout' && method === 'POST') { await run(env, 'DELETE FROM sessions WHERE hash=?', session.hash); return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', config.production, 0) }); }
  if (path === '/api/context' && method === 'POST') return json(await redeemContext(env, config, session, (await readJson(request)).launch));
  if (path === '/api/privacy' && method === 'POST') {
    const input = await readJson(request); if (typeof input.telemetryConsent !== 'boolean') throw httpError(422, 'invalid_consent');
    await run(env, 'UPDATE sessions SET telemetry_consent=? WHERE hash=?', Number(input.telemetryConsent), session.hash);
    if (!input.telemetryConsent) await withdrawTelemetry(env, session);
    return json({ telemetryConsent: input.telemetryConsent });
  }
  if (path === '/api/me/export' && method === 'GET') return exportPage(env, session, url.searchParams);
  if (path === '/api/me/data' && method === 'DELETE') {
    if ((await readJson(request)).confirm !== 'DELETE MY DATA') throw httpError(422, 'deletion_confirmation_required');
    const owned = '(owner_hash=? OR (user_id IS NOT NULL AND user_id=?))';
    const statements = [stmt(env, `DELETE FROM matches WHERE ${owned}`, session.hash, session.user_id)];
    if (session.user_id) statements.push(stmt(env, 'DELETE FROM security_tokens WHERE user_id=?', session.user_id), stmt(env, 'DELETE FROM sessions WHERE user_id=?', session.user_id), stmt(env, 'DELETE FROM users WHERE id=?', session.user_id));
    else statements.push(stmt(env, 'DELETE FROM sessions WHERE hash=?', session.hash));
    await batch(env, statements);
    return json({ deleted: true }, 200, { 'Set-Cookie': sessionCookie('', config.production, 0) });
  }
  if (path === '/api/analytics/me' && method === 'GET') {
    if (!rate.allow(`personal:${session.hash}`, 30, 60000)) throw httpError(429, 'analytics_rate_limit');
    return json(await personalReports(env, session));
  }
  if (path === '/api/matches' && method === 'POST') {
    await quota(env, `create:${session.hash}`, 12, 3600000, 'new_game_rate_limit'); await quota(env, `create-ip:${remote}`, 60, 3600000, 'new_game_rate_limit');
    return json(await createMatch(env, session, await readJson(request)), 201);
  }
  const match = path.match(/^\/api\/matches\/([a-zA-Z0-9-]{1,80})(?:\/(start|actions|events|analytics|replay|reveal|telemetry))?$/);
  if (match) {
    const [, id, action] = match;
    if (!action && method === 'GET') {
      // The poll. Reading the match is also what lets due opponent steps be applied between the owner's actions.
      const row = await ownedMatch(env, id, session);
      const advanced = await advance(env, ctx, row, { touch: true });
      return json(await project(env, advanced.row, { pending: advanced.pending }));
    }
    if (action === 'start' && method === 'POST') { await readJson(request); return json(await startMatch(env, ctx, id, session)); }
    if (action === 'actions' && method === 'POST') {
      if (!rate.allow(`actions:${id}`, 180, 60000)) throw httpError(429, 'action_rate_limit');
      return json(await humanAction(env, ctx, id, session, await readJson(request)));
    }
    if (action === 'reveal' && method === 'POST') { await readJson(request); return json(await revealMatch(env, id, session)); }
    if (action === 'replay' && method === 'GET') return new Response(await replayJson(env, id, session), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="sudoku-replay.json"' } });
    if (action === 'analytics' && method === 'GET') {
      if (!rate.allow(`analytics:${id}`, 40, 60000)) throw httpError(429, 'analytics_rate_limit');
      // ?evidence=omit drops the per-decision candidate evidence (about a megabyte for a long game) for on-screen use; downloads ask for it all.
      const report = await analytics(env, id, session, { evidence: url.searchParams.get('evidence') !== 'omit' });
      if (url.searchParams.get('format') === 'csv') return new Response(toCsv(report.jev.decisions, ['sequence', 'ms', 'source', 'model', 'kind', 'technique', 'candidates', 'confidence', 'entropyBits', 'topTwoMargin', 'inferenceMs', 'preprocessingMs', 'pacingWaitMs', 'branchDepth']),
        { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sudoku-decisions.csv"', 'Cache-Control': 'no-store' } });
      return json(report);
    }
    if (action === 'telemetry' && method === 'POST') {
      await ownedMatch(env, id, session);
      if (!session.telemetry_consent) throw httpError(403, 'telemetry_consent_required');
      if (!rate.allow(`telemetry:${id}`, 20, 60000)) throw httpError(429, 'telemetry_rate_limit');
      const body = await readJson(request); if (!Array.isArray(body.events) || body.events.length > 50) throw httpError(422, 'invalid_telemetry_batch');
      let events; try { events = body.events.map(validateClientEvent); } catch (e) { throw httpError(422, e.code || 'invalid_telemetry'); }
      // Multi-row inserts, 16 rows (96 bound values, under D1's 100 per statement) at a time: 50 events cost 4 statements, not 50.
      const chunks = []; for (let i = 0; i < events.length; i += 16) chunks.push(events.slice(i, i + 16));
      if (chunks.length) await batch(env, chunks.map(chunk => env.DB.prepare(`INSERT OR IGNORE INTO telemetry(match_id,name,trust,properties_json,client_event_id,created_at) VALUES ${chunk.map(() => '(?,?,?,?,?,?)').join(',')}`)
        .bind(...chunk.flatMap(e => [id, e.name, 'client', JSON.stringify(e.properties), e.id, now(env)]))));
      return json({ accepted: events.length });
    }
    // Live push streams are gone on Workers; clients poll GET /api/matches/:id instead.
    if (action === 'events') throw httpError(410, 'events_removed_use_polling');
  }
  throw httpError(404, 'not_found');
}
const EXPORT_PAGE = 5, EXPORT_EVENT_BYTES = 400000;
/**
 * Account export, paged so one request never assembles more than a Worker request can afford: at most `limit` matches and about
 * EXPORT_EVENT_BYTES of recorded events (always at least one match). Replays are spliced in as stored strings, never re-serialised.
 */
async function exportPage(env, session, params) {
  const offset = Number(params.get('offset') || 0), limit = Math.min(10, Number(params.get('limit') || EXPORT_PAGE));
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1) throw httpError(422, 'invalid_export_page');
  const owned = '(owner_hash=? OR (user_id IS NOT NULL AND user_id=?))';
  const total = (await one(env, `SELECT COUNT(*) AS n FROM matches WHERE ${owned}`, session.hash, session.user_id)).n;
  const rows = await all(env, `SELECT m.id,COALESCE((SELECT SUM(length(e.event_json)) FROM match_events e WHERE e.match_id=m.id),0) AS bytes FROM matches m WHERE ${owned} ORDER BY m.created_at,m.id LIMIT ? OFFSET ?`, session.hash, session.user_id, limit, offset);
  const items = []; let spent = 0;
  for (const { id, bytes } of rows) {
    if (items.length && spent + bytes > EXPORT_EVENT_BYTES) break;
    spent += bytes;
    const row = await readMatch(env, id);
    items.push(`{"id":${JSON.stringify(id)},"state":${JSON.stringify(await project(env, row))},"analytics":${JSON.stringify(await analytics(env, id, session, { evidence: false }))},"replay":${row.state.phase === 'finished' ? await replayJson(env, id, session) : 'null'}}`);
  }
  const next = offset + items.length < total ? offset + items.length : null;
  return new Response(`{"exportVersion":2,"generatedAt":${JSON.stringify(new Date(now(env)).toISOString())},"total":${total},"offset":${offset},"nextOffset":${next},"matches":[${items.join(',')}]}`,
    { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
export default { fetch: (request, env, ctx) => handle(request, env, ctx) };
