// Maintenance for a LOCAL database file. On Cloudflare there are no cron triggers, so retention runs lazily inside the Worker
// (server/maintenance.js); back up D1 with `npx wrangler d1 export jev-sudoku --remote --output backup.sql`.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase } from '../local/database.js';
import { sweep } from '../server/maintenance.js';
const args = process.argv.slice(2), path = process.env.DATABASE_PATH || resolve('.data/sudoku.sqlite');
const env = { DB: openDatabase(path), APP_ORIGIN: process.env.APP_ORIGIN || 'http://localhost:3000',
  TELEMETRY_RETENTION_DAYS: process.env.TELEMETRY_RETENTION_DAYS, OPERATIONS_RETENTION_DAYS: process.env.OPERATIONS_RETENTION_DAYS, ABANDONED_AFTER_MS: process.env.ABANDONED_AFTER_MS };
try {
  if (args.includes('--backup')) {
    const target = args[args.indexOf('--backup') + 1]; if (!target) throw Error('Provide a new backup file path');
    const absolute = resolve(target); if (existsSync(absolute)) throw Error('Backup target already exists; refusing overwrite');
    mkdirSync(dirname(absolute), { recursive: true }); await env.DB.prepare('VACUUM INTO ?').bind(absolute).run();
    console.log(JSON.stringify({ backup: absolute, createdAt: new Date().toISOString() }));
  } else if (args.includes('--sweep') || args.includes('--purge')) {
    console.log(JSON.stringify({ sweep: await sweep(env), coreReplaysRetained: true }));
  } else if (args.includes('--integrity')) {
    console.log(JSON.stringify({ integrity: (await env.DB.prepare('PRAGMA integrity_check').all()).results, foreignKeys: (await env.DB.prepare('PRAGMA foreign_key_check').all()).results }, null, 2));
  } else console.log('Usage: npm run maintenance -- --backup backups/sudoku.sqlite | --sweep | --integrity');
} finally { env.DB.close(); }
