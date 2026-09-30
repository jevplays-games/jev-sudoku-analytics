// Analytics exports from a local database (npm start / tests). For the Cloudflare database, call the operator endpoint instead:
//   curl -H "Authorization: Bearer $ADMIN_ANALYTICS_TOKEN" https://sudoku.jevplay.games/api/analytics/operator?days=30
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../local/database.js';
import { readMatch } from '../server/db.js';
import { reportFor } from '../server/matches.js';
import { operatorReport } from '../server/reports.js';
import { toCsv } from '../public/shared/analytics.js';
const args = process.argv.slice(2), arg = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const matchId = arg('match', null), format = arg('format', 'json'), out = arg('out', null);
const env = { DB: openDatabase(process.env.DATABASE_PATH || resolve('.data/sudoku.sqlite')), APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:3000',
  JEV_INPUT_USD_PER_MILLION: process.env.JEV_INPUT_USD_PER_MILLION, JEV_OUTPUT_USD_PER_MILLION: process.env.JEV_OUTPUT_USD_PER_MILLION };
try {
  let report;
  if (matchId) {
    const row = await readMatch(env, matchId); if (!row) throw Error('Match not found');
    if (row.state.phase !== 'finished') throw Error('CLI detailed exports are restricted to finished matches to avoid revealing live ranked answers.');
    report = await reportFor(env, row);
  } else report = await operatorReport(env, { days: Number(arg('days', '30')), difficulty: arg('difficulty', null) });
  if (!['json', 'csv'].includes(format)) throw Error('Use --format json or csv');
  const content = format === 'json' ? JSON.stringify(report, null, 2) + '\n' : matchId
    ? toCsv(report.jev.decisions, ['sequence', 'ms', 'source', 'model', 'kind', 'technique', 'candidates', 'confidence', 'entropyBits', 'topTwoMargin', 'inferenceMs', 'preprocessingMs', 'pacingWaitMs', 'branchDepth'])
    : toCsv(report.routeMetrics.map(r => ({ route: r.route, requests: r.requests, serverErrors: r.serverErrors, clientErrors: r.clientErrors, p50Ms: r.latencyMs.median, p95Ms: r.latencyMs.p95 })), ['route', 'requests', 'serverErrors', 'clientErrors', 'p50Ms', 'p95Ms']);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, content); console.log(`Wrote ${out}`); } else process.stdout.write(content);
} finally { env.DB.close(); }
