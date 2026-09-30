// Publishes ranked daily challenges (four per UTC day, one per difficulty). Ranked puzzles must stay secret until played, so they
// are never committed: publish them out of band.
//   npm run puzzles -- --date 2026-10-01 --days 7                 insert into the local database (npm start / tests)
//   npm run puzzles -- --date 2026-10-01 --days 7 --sql .data/challenges.sql
//     then: npx wrangler d1 execute jev-sudoku --remote --file .data/challenges.sql      (INSERT OR IGNORE: never overwrites)
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generatePuzzle } from './puzzle-lib.js';
import { openDatabase } from '../local/database.js';
const args = process.argv.slice(2), arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const date = arg('date', new Date().toISOString().slice(0, 10)), days = Number(arg('days', '7')), sqlOut = arg('sql', null), model = process.env.JEV_MODEL || 'jev-1.13.0';
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) || !Number.isInteger(days) || days < 1 || days > 366) throw Error('Use --date YYYY-MM-DD --days 1..366');
const sha = x => createHash('sha256').update(x).digest('hex');
const quote = v => `'${String(v).replaceAll("'", "''")}'`;
const dbPath = process.env.DATABASE_PATH || resolve('.data/sudoku.sqlite');
const db = sqlOut ? null : (mkdirSync(dirname(dbPath), { recursive: true }), openDatabase(dbPath));
const statements = []; let created = 0;
try {
  for (let day = 0; day < days; day++) for (const difficulty of ['easy', 'normal', 'hard', 'jev']) {
    const utcDate = new Date(Date.parse(date + 'T00:00:00Z') + day * 86400000).toISOString().slice(0, 10), id = `sudoku:${utcDate}:${difficulty}`;
    if (db && await db.prepare('SELECT 1 AS x FROM challenges WHERE utc_date=? AND difficulty=?').bind(utcDate, difficulty).first()) continue;
    const seed = randomBytes(32).toString('hex'), p = generatePuzzle(seed);
    const config = JSON.stringify({ difficulty, mode: 'ranked', model, pacingMs: 8000, timeLimitMs: 3600000, puzzleBand: 'standard-v1', generatorVersion: p.generatorVersion, policyVersion: 'sudoku-policy-v1' });
    if (db) await db.prepare('INSERT INTO challenges(id,utc_date,difficulty,givens,puzzle_hash,private_seed,config_json,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id, utcDate, difficulty, p.givens, sha(p.givens), seed, config, Date.now()).run();
    else statements.push(`INSERT OR IGNORE INTO challenges(id,utc_date,difficulty,givens,puzzle_hash,private_seed,config_json,created_at) VALUES(${[id, utcDate, difficulty, p.givens, sha(p.givens), seed, config].map(quote).join(',')},${Date.now()});`);
    created++; console.log(JSON.stringify({ event: 'challenge_prepared', id, clues: p.actualClues, model }));
  }
  if (sqlOut) { mkdirSync(dirname(resolve(sqlOut)), { recursive: true }); writeFileSync(sqlOut, statements.join('\n') + '\n'); console.log(`Wrote ${created} challenges to ${sqlOut}. Run: npx wrangler d1 execute jev-sudoku --remote --file ${sqlOut}`); }
  else console.log(`Published ${created} new challenges. Existing challenges were not overwritten.`);
} finally { db?.close(); }
