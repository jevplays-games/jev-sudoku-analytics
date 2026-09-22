import { DatabaseSync } from 'node:sqlite';
import { readFileSync,mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
export function openDb(path='data/arcade.sqlite') {
  if(path!==':memory:') mkdirSync(dirname(resolve(path)),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>1) {db.close();throw new Error('Database schema is newer than this application');}
  db.exec(readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8'));
  return db;
}
export function transaction(db,fn) {db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
export function readMatch(db,id) {
  const row=db.prepare('SELECT * FROM matches WHERE id=?').get(id);
  if(!row) return null;return {...row,initial:JSON.parse(row.initial_json),state:JSON.parse(row.state_json)};
}
export const readEvents=(db,id)=>db.prepare('SELECT event_json FROM match_events WHERE match_id=? ORDER BY sequence').all(id).map(x=>JSON.parse(x.event_json));
export const readTelemetry=(db,id)=>db.prepare('SELECT name,trust,properties_json,created_at FROM telemetry WHERE match_id=? ORDER BY id').all(id).map(t=>({...t,properties:JSON.parse(t.properties_json)}));
