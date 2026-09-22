import {analyzeMatch} from '../shared/analytics.js';
import{openDb,transaction,readMatch,readEvents,readTelemetry}from'../server/db.js';import{loadConfig}from'../server/config.js';import{mkdirSync,existsSync}from'node:fs';import{dirname,resolve}from'node:path';
const config=loadConfig(),db=openDb(config.database),args=process.argv.slice(2),now=Date.now();
try{
  if(args.includes('--backup')){const target=args[args.indexOf('--backup')+1];if(!target)throw Error('Provide a new backup file path');const absolute=resolve(target);if(existsSync(absolute))throw Error('Backup target already exists; refusing overwrite');mkdirSync(dirname(absolute),{recursive:true});db.prepare('VACUUM INTO ?').run(absolute);console.log(JSON.stringify({backup:absolute,createdAt:new Date().toISOString()}));}
  else if(args.includes('--purge')){
    const before=db.prepare('SELECT COUNT(*) n FROM telemetry').get().n;
    transaction(db,()=>{
      const cutoff=now-config.detailedRetentionDays*86400000;
      const affected=db.prepare("SELECT DISTINCT match_id FROM telemetry WHERE trust='client' AND created_at<? AND match_id IS NOT NULL").all(cutoff);
      // Provider request usage remains with durable match evidence so costs are not silently lost.
      db.prepare("DELETE FROM telemetry WHERE trust='client' AND created_at<?").run(cutoff);
      db.prepare('DELETE FROM operations WHERE created_at<?').run(now-config.operationRetentionDays*86400000);
      db.prepare('DELETE FROM security_tokens WHERE expires_at<?').run(now);
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
      // Recompute complete report shapes from the retained evidence, including partially expired sessions.
      for(const item of affected){
        const row=readMatch(db,item.match_id);
        if(!row||!db.prepare('SELECT 1 FROM results WHERE match_id=?').get(item.match_id))continue;
        const report=analyzeMatch(row.initial,readEvents(db,item.match_id),readTelemetry(db,item.match_id),{
          inputUsdPerMillion:config.inputUsdPerMillion,outputUsdPerMillion:config.outputUsdPerMillion});
        db.prepare('UPDATE results SET analytics_json=? WHERE match_id=?').run(JSON.stringify(report),item.match_id);
      }
    });console.log(JSON.stringify({purgedOptionalEvents:before-db.prepare('SELECT COUNT(*) n FROM telemetry').get().n,coreReplaysRetained:true}));
  }else if(args.includes('--integrity')){console.log(JSON.stringify({integrity:db.prepare('PRAGMA integrity_check').all(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()},null,2));}
  else console.log('Usage: npm run maintenance -- --backup backups/arcade.sqlite | --purge | --integrity');
}finally{db.close();}
