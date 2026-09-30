// Read-side reports. Everything that can grow with the number of matches is computed by D1 (SQL aggregates) or from the small
// per-result `summary_json`, never by parsing full match state or analytics for every row inside the Worker.
import { distribution, aggregateReports } from '../public/shared/analytics.js';
import { httpError, b64url, fromB64url, utf8, text, utcDay, now } from './util.js';
import { one, all } from './db.js';
import { liveSummary } from './matches.js';
const ROW_CAP = 1000;
export async function leaderboard(env, session, params, at = now(env)) {
  const scope = params.get('scope') || 'world', date = params.get('date') || utcDay(at), difficulty = params.get('difficulty') || 'normal';
  if (!['world', 'server', 'channel'].includes(scope) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['easy', 'normal', 'hard', 'jev'].includes(difficulty)) throw httpError(422, 'invalid_leaderboard_filter');
  const context = session?.context_json ? JSON.parse(session.context_json) : null;
  if (scope !== 'world' && (!session?.user_id || !context || context.expiresAt <= at || context.userId !== session.user_id)) throw httpError(403, 'fresh_discord_context_required');
  const challenge = await one(env, 'SELECT id FROM challenges WHERE utc_date=? AND difficulty=?', date, difficulty);
  const requestedLimit = Number(params.get('limit') || 50); if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) throw httpError(422, 'invalid_limit');
  let offset = 0;
  if (params.get('cursor')) {
    try {
      const c = JSON.parse(text(fromB64url(params.get('cursor'))));
      if (c.scope !== scope || c.date !== date || c.difficulty !== difficulty || !Number.isInteger(c.offset) || c.offset < 0 || c.offset > 1000000) throw Error();
      offset = c.offset;
    } catch { throw httpError(422, 'invalid_cursor'); }
  }
  if (!challenge) return { scope, date, difficulty, entries: [], nextCursor: null, published: false };
  let conditions = 'm.challenge_id=? AND r.eligible=1 AND r.human_bucket IS NOT NULL AND m.user_id IS NOT NULL'; const values = [challenge.id];
  if (scope !== 'world') { conditions += ' AND m.guild_id=?'; values.push(context.guildId); }
  if (scope === 'channel') { conditions += ' AND m.channel_id=?'; values.push(context.channelId); }
  const entries = await all(env, `SELECT * FROM (SELECT RANK() OVER(ORDER BY r.human_bucket) AS rank,m.id AS match_id,
    u.display_name,r.human_bucket AS seconds,r.winner FROM results r JOIN matches m ON m.id=r.match_id JOIN users u ON u.id=m.user_id
    WHERE ${conditions}) ORDER BY seconds,match_id LIMIT ? OFFSET ?`, ...values, requestedLimit + 1, offset);
  const hasMore = entries.length > requestedLimit; entries.splice(requestedLimit);
  return { scope, date, difficulty, published: true, entries, nextCursor: hasMore ? b64url(utf8(JSON.stringify({ scope, date, difficulty, offset: offset + requestedLimit }))) : null };
}
export async function personalReports(env, session, limit = 200) {
  const where = session.user_id ? 'm.user_id=?' : 'm.owner_hash=?', value = session.user_id || session.hash;
  const total = (await one(env, `SELECT COUNT(*) AS n FROM matches m WHERE ${where}`, value)).n;
  const rows = await all(env, `SELECT m.id,m.created_at,m.state_json,r.summary_json FROM matches m LEFT JOIN results r ON r.match_id=m.id WHERE ${where} ORDER BY m.created_at DESC LIMIT ?`, value, limit);
  // A finished match has a stored small summary; a live one is summarised from its state (no event replay per row).
  const summaries = rows.map(r => r.summary_json ? JSON.parse(r.summary_json) : liveSummary({ state: JSON.parse(r.state_json) }));
  return { coverage: { returned: rows.length, total, limit, truncated: total > limit, order: 'Most recent matches; streaks apply to this returned window.' },
    summary: aggregateReports([...summaries].reverse()), history: rows.map((r, i) => { const report = summaries[i];
      return { id: r.id, createdAt: r.created_at, phase: report.game.phase, difficulty: report.dimensions.difficulty, mode: report.dimensions.mode,
        eligibility: report.game.eligibility, outcome: report.game.outcome, humanTimeMs: report.game.humanFinishMs, jevTimeMs: report.game.jevFinishMs }; }) };
}
export async function operatorReport(env, { days = 30, at = now(env), difficulty = null } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 365) throw httpError(422, 'invalid_days');
  const since = at - days * 86400000, clauses = ['m.created_at>=?', 'm.created_at<=?'], params = [since, at];
  if (difficulty) { if (!['easy', 'normal', 'hard', 'jev'].includes(difficulty)) throw httpError(422, 'invalid_difficulty'); clauses.push("json_extract(m.initial_json,'$.config.difficulty')=?"); params.push(difficulty); }
  const where = clauses.join(' AND ');
  const funnelRow = await one(env, `SELECT COUNT(*) AS reserved,COALESCE(SUM(m.started_at IS NOT NULL),0) AS started,COALESCE(SUM(json_extract(m.state_json,'$.human.revision')>0),0) AS firstAction,
    COALESCE(SUM(m.status='finished'),0) AS finished,COALESCE(SUM(json_extract(m.state_json,'$.human.finishMs') IS NOT NULL),0) AS completed,
    COALESCE(SUM(json_extract(r.summary_json,'$.game.eligibility')='ranked'),0) AS rankedVerified FROM matches m LEFT JOIN results r ON r.match_id=m.id WHERE ${where}`, ...params);
  const funnel = { reserved: funnelRow.reserved, started: funnelRow.started, firstAction: funnelRow.firstAction, finished: funnelRow.finished, completed: funnelRow.completed, rankedVerified: funnelRow.rankedVerified };
  const resultReports = (await all(env, `SELECT r.summary_json FROM matches m JOIN results r ON r.match_id=m.id WHERE ${where} ORDER BY m.created_at DESC LIMIT ${ROW_CAP}`, ...params)).map(r => JSON.parse(r.summary_json)).reverse();
  const httpTotal = (await one(env, "SELECT COUNT(*) AS n FROM operations WHERE name='http_request' AND created_at BETWEEN ? AND ?", since, at)).n;
  const requests = (await all(env, `SELECT properties_json FROM operations WHERE name='http_request' AND created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT ${ROW_CAP}`, since, at)).map(r => JSON.parse(r.properties_json));
  const byRoute = {}; for (const r of requests) { const key = `${r.method} ${r.route}`; (byRoute[key] ||= []).push(r); }
  const routeMetrics = Object.entries(byRoute).map(([route, rs]) => ({ route, requests: rs.length, serverErrors: rs.filter(r => r.status >= 500).length,
    clientErrors: rs.filter(r => r.status >= 400 && r.status < 500).length, rateLimited: rs.filter(r => r.status === 429).length, latencyMs: distribution(rs.map(r => r.durationMs)) }));
  const diff = difficulty ? " AND json_extract(initial_json,'$.config.difficulty')=?" : '', dv = difficulty ? [difficulty] : [];
  const windowed = `started_at BETWEEN ? AND ?${diff}`;
  const distinct = async span => (await one(env, `SELECT COUNT(DISTINCT user_id) AS n FROM matches WHERE ${windowed} AND user_id IS NOT NULL AND started_at>=?`, since, at, ...dv, at - span)).n;
  const guestSessions = (await one(env, `SELECT COUNT(DISTINCT owner_hash) AS n FROM matches WHERE ${windowed} AND user_id IS NULL`, since, at, ...dv)).n;
  const byDay = await all(env, `SELECT date(started_at/1000,'unixepoch') AS date,COUNT(DISTINCT user_id) AS authenticatedPlayers FROM matches WHERE ${windowed} GROUP BY date ORDER BY date`, since, at, ...dv);
  const allActive = await all(env, `SELECT DISTINCT user_id,date(started_at/1000,'unixepoch') AS day FROM matches WHERE user_id IS NOT NULL AND started_at IS NOT NULL ORDER BY user_id LIMIT ${ROW_CAP * 4}`);
  const activity = new Map(); for (const r of allActive) { if (!activity.has(r.user_id)) activity.set(r.user_id, new Set()); activity.get(r.user_id).add(r.day); }
  const cohorts = {};
  for (const [, dates] of activity) {
    const first = [...dates].sort()[0], firstMs = Date.parse(first + 'T00:00:00Z'); if (firstMs < since || firstMs > at) continue;
    const c = cohorts[first] ||= { cohortDate: first, players: 0, d1Eligible: 0, d1Returned: 0, d7Eligible: 0, d7Returned: 0, d30Eligible: 0, d30Returned: 0 }; c.players++;
    for (const offset of [1, 7, 30]) { const target = firstMs + offset * 86400000; if (target + 86400000 <= at) { c[`d${offset}Eligible`]++; if (dates.has(utcDay(target))) c[`d${offset}Returned`]++; } }
  }
  const retention = Object.values(cohorts).map(c => ({ ...c, d1: c.d1Eligible ? c.d1Returned / c.d1Eligible : null, d7: c.d7Eligible ? c.d7Returned / c.d7Eligible : null, d30: c.d30Eligible ? c.d30Returned / c.d30Eligible : null }));
  const totals = await one(env, 'SELECT COUNT(*) AS events,MIN(created_at) AS firstAt,MAX(created_at) AS lastAt FROM operations WHERE created_at BETWEEN ? AND ?', since, at);
  const security = await all(env, "SELECT name,COUNT(*) AS count FROM operations WHERE created_at BETWEEN ? AND ? AND name IN('security_rejected','context_rejected','verification_failed','scheduler_error') GROUP BY name", since, at);
  return { schemaVersion: 'operator-analytics-v1', coverage: { from: new Date(since).toISOString(), through: new Date(at).toISOString(), days, difficulty,
      matches: funnel.reserved, completedReports: resultReports.length, httpMetrics: requests.length, httpMetricsTotal: httpTotal, httpMetricsSampled: httpTotal > requests.length,
      operations: totals, liveMatchesExcludedFromCompletedSummary: true, rowCap: ROW_CAP, summariesTruncated: funnel.reserved > resultReports.length && resultReports.length >= ROW_CAP },
    summary: aggregateReports(resultReports), funnel,
    activity: { authenticatedDAU: days >= 1 ? await distinct(86400000) : null, authenticatedWAU: days >= 7 ? await distinct(7 * 86400000) : null,
      authenticatedMAU: days >= 30 ? await distinct(30 * 86400000) : null, guestSessions, byUtcDay: byDay },
    retention, routeMetrics, security,
    definitions: { active: 'Authenticated user with a started match within the rolling window. Guests are separate sessions, not people.',
      retention: 'Exact UTC-day return after first observed started match; only fully elapsed return days enter the denominator. All difficulties, independent of the difficulty filter.',
      funnel: 'Reserved matches in the selected creation-time window, not unique people.',
      http: 'Application handlers only; opponent-state polling reads (GET /api/matches/:id) are not logged, and at most the most recent rowCap requests in the window feed the latency percentiles (httpMetricsSampled says when that happened).',
      samples: 'Percentiles use linear interpolation; small sample sizes are shown, not suppressed or extrapolated.',
      window: 'All returned observations are bounded by stored data. Retention/purges and account deletion affect historical counts.' } };
}
