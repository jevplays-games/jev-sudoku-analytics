/** Isolated CLI smoke: never opens or modifies the configured production database. */
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {openDb,readMatch} from '../server/db.js';
import {MatchService} from '../server/matches.js';
import {loadConfig} from '../server/config.js';
import {issueSession} from '../server/security.js';
import {track} from '../server/telemetry.js';
const directory=mkdtempSync(join(tmpdir(),'jev-maintenance-test-')),database=join(directory,'arcade.sqlite');
const env={...process.env,NODE_ENV:'development',APP_ORIGIN:'http://localhost:3000',DATABASE_PATH:database,
  LAUNCH_SIGNING_KEY:'isolated-maintenance-test-key-00000000000000',TYPESAFE_API_KEY:'',TELEMETRY_RETENTION_DAYS:'30',OPERATIONS_RETENTION_DAYS:'30'};
const checks=[];
const run=(file,args=[])=>execFileSync(process.execPath,[file,...args],{env,cwd:resolve('.'),encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
try{
  const db=openDb(database),service=new MatchService(db,loadConfig(env),{autoTick:false});
  const session=issueSession(db).row;
  const match=service.create(session,{requestId:'maintenance-fixture',mode:'practice',difficulty:'normal'});
  service.start(match.id,session);
  track(db,match.id,'note_added',{cell:0},'client','old-note-fixture',Date.now()-31*86400000);
  service.action(match.id,session,{requestId:'maintenance-forfeit',expectedHumanRevision:0,action:{kind:'forfeit'}});
  assert.equal(service.analytics(match.id,session).browser.notesAdded,1);
  service.close();db.close();
  const published=run('scripts/puzzles.js',['--date','2030-01-01','--days','1']);assert.ok(published.includes('Published 4 new challenges'));
  const again=run('scripts/puzzles.js',['--date','2030-01-01','--days','1']);assert.ok(again.includes('Published 0 new challenges'));
  checks.push('Four unique daily puzzles published; repeat publication does not overwrite');
  const reportPath=join(directory,'analytics.json');run('scripts/analytics.js',['--match',match.id,'--out',reportPath]);
  const report=JSON.parse(readFileSync(reportPath));assert.equal(report.schemaVersion,'analytics-v1');assert.equal(report.human.forfeits,1);
  const csv=run('scripts/analytics.js',['--match',match.id,'--format','csv']);assert.ok(csv.startsWith('"sequence","ms"'));
  const operator=JSON.parse(run('scripts/analytics.js',['--days','30']));assert.equal(operator.coverage.matches,1);
  checks.push('Finished-match JSON, decision CSV and operator JSON CLI exports');
  const purge=JSON.parse(run('scripts/maintenance.js',['--purge']));assert.equal(purge.purgedOptionalEvents,1);
  const after=openDb(database);const cached=JSON.parse(after.prepare('SELECT analytics_json FROM results WHERE match_id=?').get(match.id).analytics_json);
  assert.equal(cached.browser.notesAdded,0);assert.equal(cached.browser.focusDwellMsByCell.length,81);assert.ok(readMatch(after,match.id));after.close();
  checks.push('Expired optional telemetry purged; complete analytics schema recomputed; core game retained');
  const backupPath=join(directory,'backup.sqlite');run('scripts/maintenance.js',['--backup',backupPath]);
  const backup=openDb(backupPath);assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM results').get().n,1);backup.close();
  assert.throws(()=>run('scripts/maintenance.js',['--backup',backupPath]));
  checks.push('Consistent backup reopened and checked; overwrite refused');
  const integrity=JSON.parse(run('scripts/maintenance.js',['--integrity']));assert.equal(integrity.integrity[0].integrity_check,'ok');assert.equal(integrity.foreignKeys.length,0);
  checks.push('Live test database integrity and foreign-key checks pass');
  const result={suite:'Isolated CLI and SQLite maintenance smoke',generatedAt:new Date().toISOString(),passed:checks.length,failed:0,checks,
    limitations:'Temporary local fixture database only. Docker volumes, external backup storage, operator schedules and live production restoration were not exercised.'};
  mkdirSync('reports',{recursive:true});writeFileSync('reports/maintenance-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{rmSync(directory,{recursive:true,force:true});}
