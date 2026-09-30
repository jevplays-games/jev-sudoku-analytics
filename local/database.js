import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
/**
 * D1-compatible interface over Node's built-in SQLite: prepare().bind().first()/all()/run(), batch() and exec().
 * Tests and `npm start` run against real SQLite through it, never a SQL mock. Migrations in migrations/*.sql are applied in
 * order on open (the same files `wrangler d1 migrations apply` runs on Cloudflare), each at most once per database.
 */
export function openDatabase(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  // A file written by the pre-Cloudflare container build has the same table names with a different shape; refuse it rather than corrupt it.
  if (sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get() && !sqlite.prepare('SELECT 1 FROM d1_migrations LIMIT 1').get()) {
    sqlite.close();
    throw new Error(`${path} was created by the earlier container build and uses a different schema. Set DATABASE_PATH to a new file (default .data/sudoku.sqlite) or delete it.`);
  }
  for (const name of readdirSync(migrationsDir).filter(n => n.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(name)) continue;
    sqlite.exec('BEGIN');
    try { sqlite.exec(readFileSync(join(migrationsDir, name), 'utf8')); sqlite.prepare('INSERT INTO d1_migrations(name,applied_at) VALUES(?,?)').run(name, Date.now()); sqlite.exec('COMMIT'); }
    catch (e) { sqlite.exec('ROLLBACK'); throw new Error(`Migration ${name} failed: ${e.message}`); }
  }
  function wrap(sql, params = []) {
    const execute = kind => {
      const statement = sqlite.prepare(sql);
      if (kind === 'first') return statement.get(...params) ?? null;
      if (kind === 'all') return { success: true, results: statement.all(...params) };
      const result = statement.run(...params);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    };
    return {
      bind(...values) { return wrap(sql, values); },
      async first(column) { const row = execute('first'); return column ? row?.[column] ?? null : row; },
      async all() { return execute('all'); },
      async run() { return execute('run'); },
      _execute: () => execute('run')
    };
  }
  return {
    prepare: wrap,
    // D1 semantics: the statements of a batch commit or roll back together.
    async batch(statements) { sqlite.exec('BEGIN IMMEDIATE'); try { const result = statements.map(s => s._execute()); sqlite.exec('COMMIT'); return result; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
    async exec(sql) { sqlite.exec(sql); },
    close() { sqlite.close(); }
  };
}
