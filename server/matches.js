import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createMatchState,advanceState,publicState } from '../shared/match.js';
import { getJevCandidates,PROFILES } from '../shared/sudoku-ai.js';
import { canonical } from '../shared/sudoku.js';
import { makeReplay,replayEvents } from '../shared/replay.js';
import { analyzeMatch,redactAnalytics } from '../shared/analytics.js';
import { generatePuzzle } from '../scripts/puzzle-lib.js';
import { transaction,readMatch,readEvents,readTelemetry } from './db.js';
import { hash,httpError } from './security.js';
import { track,operation } from './telemetry.js';
import { JevAdapter } from './jev.js';
const cleanAction=a=>{
  if(!a||typeof a!=='object'||Array.isArray(a)||!['set','clear','undo','forfeit'].includes(a.kind))throw httpError(422,'invalid_action');
  const allowed=a.kind==='set'?['kind','cell','digit']:a.kind==='clear'?['kind','cell']:['kind'];
  if(Object.keys(a).some(k=>!allowed.includes(k)))throw httpError(422,'unknown_action_field');
  return Object.fromEntries(allowed.map(k=>[k,a[k]]));
};
export class MatchService {
  constructor(db,config,{fetchImpl=fetch,now=()=>Date.now(),monotonic=()=>performance.now(),autoTick=true}={}) {
    this.db=db;this.config=config;this.now=now;this.monotonic=monotonic;this.anchors=new Map();this.pending=new Map();this.streams=new Map();this.draining=false;this.closed=false;
    this.adapter=new JevAdapter(config,{fetchImpl,onRequest:e=>{if(this.closed||!db.prepare('SELECT 1 FROM matches WHERE id=?').get(e.matchId))return;track(db,e.matchId,e.name,e.properties,'server',null,this.now());if(db.prepare('SELECT 1 FROM results WHERE match_id=?').get(e.matchId))db.prepare('UPDATE results SET analytics_json=? WHERE match_id=?').run(JSON.stringify(this.report(this.row(e.matchId))),e.matchId);}});
    if(autoTick){this.timer=setInterval(()=>{try{this.tick();}catch(e){operation(db,'scheduler_error',{reason:e.code||'internal_error'});}},200);this.timer.unref();}
  }
  row(id){const row=readMatch(this.db,id);if(!row)throw httpError(404,'match_not_found');return row;}
  owned(id,session){const row=this.row(id);if(!session||!(row.user_id?row.user_id===session.user_id:row.owner_hash===session.hash))throw httpError(403,'match_not_owned');return row;}
  elapsed(row){const anchor=this.anchors.get(row.id);return Math.max(row.state.elapsedMs,Math.floor(anchor?this.monotonic()-anchor.monotonic:this.now()-(row.started_at||this.now())));}
  create(session,input) {
    const requestId=input?.requestId;if(typeof requestId!=='string'||!/^[\w-]{8,80}$/.test(requestId))throw httpError(422,'invalid_request_id');
    const duplicate=this.db.prepare('SELECT id FROM matches WHERE owner_hash=? AND create_key=?').get(session.hash,requestId);if(duplicate)return this.project(this.row(duplicate.id));
    const difficulty=input.difficulty||'normal',mode=input.mode||'practice';if(!PROFILES[difficulty]||!['practice','ranked'].includes(mode))throw httpError(422,'invalid_configuration');
    if(Object.keys(input).some(k=>!['requestId','difficulty','mode'].includes(k)))throw httpError(422,'unknown_match_field');
    if(this.draining)throw httpError(503,'server_draining');
    this.expireReservations();
    if(this.db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status!='finished'").get().n>=this.config.maxActive)throw httpError(503,'active_match_limit');
    const active=this.db.prepare("SELECT id FROM matches WHERE status!='finished' AND (owner_hash=? OR (user_id IS NOT NULL AND user_id=?))").get(session.hash,session.user_id);
    if(active)throw httpError(409,`active_match_exists:${active.id}`);
    let challenge=null,generated=null,attemptKey=null;
    if(mode==='ranked'){
      if(!session.user_id)throw httpError(401,'discord_login_required');
      if(!this.config.jevKey)throw httpError(503,'ranked_requires_jev');
      const date=new Date(this.now()).toISOString().slice(0,10);
      challenge=this.db.prepare('SELECT * FROM challenges WHERE utc_date=? AND difficulty=?').get(date,difficulty);
      if(!challenge)throw httpError(503,'daily_challenge_not_published');
      attemptKey=createHmac('sha256',this.config.launchKey).update(`daily-attempt:${session.user_id}:${challenge.id}`).digest('hex');
      if(this.db.prepare('SELECT 1 FROM matches WHERE user_id=? AND challenge_id=? AND official=1').get(session.user_id,challenge.id)||this.db.prepare("SELECT 1 FROM security_tokens WHERE hash=? AND kind='attempt' AND expires_at>?").get(attemptKey,this.now()))throw httpError(409,'official_attempt_already_used');
    }else generated=generatePuzzle(randomBytes(24).toString('hex'));
    const clues=challenge?.givens||generated.givens;
    const challengeConfig=challenge?JSON.parse(challenge.config_json):{};
    const gameConfig={difficulty,mode,pacingMs:mode==='ranked'?8000:this.config.pacingMs,timeLimitMs:3600000,puzzleBand:'standard-v1',model:this.config.jevModel,...challengeConfig};
    if(mode==='ranked'&&gameConfig.model!==this.config.jevModel)throw httpError(503,'challenge_model_mismatch');
    const state=createMatchState(clues,gameConfig),initial={givens:clues,config:state.config};
    // Initial downgrade is represented by an event after start for deterministic replay.
    const context=session.context_json?JSON.parse(session.context_json):null;
    const validContext=context&&context.expiresAt>this.now()&&context.userId===session.user_id?context:null;
    const id=randomUUID();transaction(this.db,()=>{this.db.prepare('INSERT INTO matches(id,owner_hash,user_id,challenge_id,guild_id,channel_id,official,create_key,initial_json,state_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,session.hash,session.user_id,challenge?.id||null,validContext?.guildId||null,validContext?.channelId||null,mode==='ranked'?1:0,requestId,JSON.stringify(initial),JSON.stringify(state),'ready',this.now());
      if(attemptKey)this.db.prepare('INSERT INTO security_tokens(hash,kind,payload_json,expires_at,used_at) VALUES(?,?,?,?,?)').run(attemptKey,'attempt','{}',Date.parse(`${challenge.utc_date}T00:00:00Z`)+86400000,this.now());
    });
    operation(this.db,'match_reserved',{mode,difficulty,authenticated:!!session.user_id,community:!!validContext});
    return this.project(this.row(id));
  }
  expireReservations(){
    const today=new Date(this.now()).toISOString().slice(0,10);
    for(const r of this.db.prepare("SELECT m.id,m.created_at,c.utc_date FROM matches m LEFT JOIN challenges c ON c.id=m.challenge_id WHERE m.status='ready'").all()){
      if(this.now()-r.created_at>=300000||r.utc_date&&r.utc_date!==today)this.append(r.id,{type:'void',ms:0,reason:'expired_reservation'},'expired-reservation');
    }
  }
  start(id,session){
    this.expireReservations();
    let row=this.owned(id,session);if(row.state.phase!=='ready')return this.project(row);
    if(row.challenge_id){const ch=this.db.prepare('SELECT utc_date FROM challenges WHERE id=?').get(row.challenge_id);if(ch.utc_date!==new Date(this.now()).toISOString().slice(0,10)){this.append(id,{type:'void',ms:0,reason:'expired_reservation'},'expired-reservation');throw httpError(409,'challenge_day_expired');}}
    const now=this.now();this.db.prepare('UPDATE matches SET started_at=?,deadline_at=? WHERE id=?').run(now,now+row.state.config.timeLimitMs,id);
    this.anchors.set(id,{monotonic:this.monotonic(),wall:now});
    row=this.append(id,{type:'start',ms:0},'start');
    if(!this.config.jevKey)row=this.append(id,{type:'eligibility',ms:0,reason:'local_opponent'},'local-opponent');
    track(this.db,id,'game_started',{mode:row.state.config.mode,difficulty:row.state.config.difficulty});
    this.schedule(row);return this.project(this.row(id));
  }
  append(id,event,requestId){
    let result;
    transaction(this.db,()=>{
      const row=this.row(id),previous=hash(row.state);const e={...event,sequence:row.state.sequence+1};
      const next=advanceState(row.state,e);
      this.db.prepare('INSERT INTO match_events(match_id,sequence,request_id,event_json,previous_hash,resulting_hash) VALUES(?,?,?,?,?,?)')
        .run(id,e.sequence,requestId,JSON.stringify(e),previous,hash(next));
      this.db.prepare('UPDATE matches SET state_json=?,status=? WHERE id=?').run(JSON.stringify(next),next.phase,id);
      result={...row,state:next,status:next.phase,state_json:JSON.stringify(next)};
    });
    if(result.state.phase==='finished'){this.pending.delete(id);this.finalize(result);}
    this.broadcast(id);return result;
  }
  action(id,session,input){
    let row=this.owned(id,session);
    if(typeof input?.requestId!=='string'||!/^[\w-]{8,80}$/.test(input.requestId))throw httpError(422,'invalid_request_id');
    if(this.db.prepare('SELECT 1 FROM match_events WHERE match_id=? AND request_id=?').get(id,input.requestId))return this.project(row);
    if(Object.keys(input).some(k=>!['requestId','expectedHumanRevision','action'].includes(k)))throw httpError(422,'unknown_request_field');
    const ms=this.elapsed(row);
    if(row.state.phase!=='ready'&&row.state.phase!=='finished'&&ms>=row.state.config.timeLimitMs){this.append(id,{type:'timeout',ms},`timeout`);throw httpError(409,'match_timed_out');}
    if(row.state.sequence>=this.config.maxMatchEvents){this.append(id,{type:'void',ms,reason:'event_limit'},'event-limit');throw httpError(429,'event_limit');}
    try{
      if(input.expectedHumanRevision!==row.state.human.revision)throw httpError(409,'stale_human_revision');
      row=this.append(id,{type:'human',ms,action:cleanAction(input.action)},input.requestId);
      if(row.state.human.finishMs!==null)track(this.db,id,'human_completed',{elapsedMs:row.state.human.finishMs});
      return this.project(row);
    }catch(e){track(this.db,id,'action_rejected',{reason:e.code||e.message});if(!e.status)e.status=422;throw e;}
  }
  schedule(row){
    const s=row.state;if(this.closed||this.pending.has(row.id)||!['running','settling'].includes(s.phase)||s.jev.finishMs!==null||s.jev.status==='stalled')return;
    const t=this.monotonic(),bundle=getJevCandidates(s.jev,s.config.difficulty),preprocessingMs=this.monotonic()-t;
    if(!bundle.candidates.length){this.append(row.id,{type:'jev_stalled',ms:this.elapsed(row)},`stall-${s.jev.revision}`);return;}
    const entry={revision:s.jev.revision,bundle,preprocessingMs,startedMs:this.elapsed(row),dueMs:s.jev.lastActionMs+s.config.pacingMs,decision:null};this.pending.set(row.id,entry);
    const requests=this.db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE match_id=? AND name='jev_request_finished'").get(row.id).n;
    let local=s.providerFallback||requests+2>this.config.maxRequestsPerMatch;
    if(requests+2>this.config.maxRequestsPerMatch&&!s.providerFallback)this.append(row.id,{type:'eligibility',ms:this.elapsed(row),reason:'request_budget'},'request-budget');
    this.adapter.choose({board:s.jev,givens:s.givens,bundle,matchId:row.id,forceLocal:local}).then(d=>{
      if(this.pending.get(row.id)!==entry||this.closed)return;
      entry.decision=d;entry.completedMs=this.elapsed(this.row(row.id));
      if(local&&s.ineligibleReason!=='local_opponent')entry.decision.source='heuristic_fallback';
    }).catch(()=>{
      if(this.pending.get(row.id)!==entry||this.closed)return;
      entry.decision={...bundle,source:'heuristic_fallback',reason:'adapter_error',actionId:bundle.candidates[0].id,boardRevision:s.jev.revision,model:null,candidateCount:bundle.candidates.length};entry.completedMs=this.elapsed(this.row(row.id));
    });
  }
  tick(){
    if(this.closed)return;
    this.expireReservations();
    const rows=this.db.prepare("SELECT id FROM matches WHERE status IN('running','settling')").all();
    for(const {id} of rows){
      let row=this.row(id),s=row.state,ms=this.elapsed(row),entry=this.pending.get(id);
      if(ms>=s.config.timeLimitMs){this.append(id,{type:'timeout',ms},'timeout');continue;}
      // Close the human's one-second tie bucket before any late-arriving JEV step.
      if(s.human.finishMs!==null&&ms>=(Math.floor(s.human.finishMs/1000)+1)*1000){this.append(id,{type:'settle',ms},'settle');continue;}
      if(entry?.decision&&ms>=entry.dueMs){
        this.pending.delete(id);const decision=entry.decision;
        if(decision.boardRevision!==s.jev.revision){track(this.db,id,'jev_stale',{revision:decision.boardRevision});this.schedule(row);continue;}
        if(decision.source==='heuristic_fallback'&&!s.providerFallback){
          row=this.append(id,{type:'eligibility',ms,reason:'provider_fallback'},`fallback-${s.jev.revision}`);s=row.state;
          track(this.db,id,'jev_fallback',{reason:decision.reason||'provider_unavailable'});
        }
        const action=entry.bundle.candidates.find(c=>c.id===decision.actionId);
        if(!action){row=this.append(id,{type:'void',ms,reason:'internal_invalid_decision'},`invalid-${s.jev.revision}`);continue;}
        const enriched={...decision,preprocessingMs:entry.preprocessingMs,pacingWaitMs:Math.max(0,ms-(entry.completedMs??ms))};
        row=this.append(id,{type:'jev',ms,action,decision:enriched},`jev-${s.jev.revision}`);this.schedule(row);
      }else this.schedule(row);
    }
    // Reservations are bounded; no disclosed ranked puzzle exists before start.
    for(const r of this.db.prepare("SELECT id FROM matches WHERE status='ready' AND created_at<?").all(this.now()-600000))this.db.prepare('DELETE FROM matches WHERE id=?').run(r.id);
  }
  reveal(id,session){let row=this.owned(id,session);if(row.state.phase==='ready')throw httpError(409,'match_not_started');
    if(row.state.phase!=='finished'&&row.state.eligibility==='ranked')row=this.append(id,{type:'eligibility',ms:this.elapsed(row),reason:'answers_revealed'},'reveal');return this.project(row);}
  report(row){return analyzeMatch(row.initial,readEvents(this.db,row.id),readTelemetry(this.db,row.id),{elapsedMs:row.state.phase==='finished'?row.state.elapsedMs:row.state.phase==='ready'?0:this.elapsed(row),inputUsdPerMillion:this.config.inputUsdPerMillion,outputUsdPerMillion:this.config.outputUsdPerMillion});}
  analytics(id,session){const row=this.owned(id,session);return redactAnalytics(this.report(row),row.state.eligibility==='ranked'&&row.state.phase!=='finished');}
  replay(id,session){const row=this.owned(id,session);if(row.state.phase!=='finished')throw httpError(409,'replay_available_after_finish');return {...makeReplay(row.initial,readEvents(this.db,id),row.state),integrity:{replayHash:this.db.prepare('SELECT replay_hash FROM results WHERE match_id=?').get(id)?.replay_hash,authority:'server-recorded; downloaded copies are not official submissions'}};}
  finalize(row){
    if(this.db.prepare('SELECT 1 FROM results WHERE match_id=?').get(row.id))return;
    const events=readEvents(this.db,row.id),replay=makeReplay(row.initial,events,row.state);
    try{
      const reconstructed=replayEvents(replay);
      let previous=hash(createMatchState(row.initial.givens,row.initial.config));
      const stored=this.db.prepare('SELECT * FROM match_events WHERE match_id=? ORDER BY sequence').all(row.id);
      let verifying=createMatchState(row.initial.givens,row.initial.config);
      for(let i=0;i<stored.length;i++){
        if(stored[i].previous_hash!==previous)throw new Error('broken_hash_chain');
        verifying=advanceState(verifying,events[i]);previous=hash(verifying);
        if(stored[i].resulting_hash!==previous)throw new Error('broken_state_hash');
        if(reconstructed.eligibility==='ranked'&&events[i].type==='jev'&&!['jev','forced'].includes(events[i].decision?.source))throw new Error('ranked_non_jev_opponent');
      }
      const report=this.report(row),eligible=Number(reconstructed.eligibility==='ranked'&&!!row.user_id&&!!row.challenge_id);
      this.db.prepare('INSERT INTO results(match_id,eligible,winner,human_ms,human_bucket,jev_ms,analytics_json,replay_hash,verified_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(row.id,eligible,reconstructed.outcome,reconstructed.human.finishMs,reconstructed.human.finishMs===null?null:Math.floor(reconstructed.human.finishMs/1000),reconstructed.jev.finishMs,JSON.stringify(report),hash(replay),this.now());
      operation(this.db,'score_verified',{eligible:!!eligible,outcome:reconstructed.outcome,difficulty:reconstructed.config.difficulty});
    }catch(e){operation(this.db,'verification_failed',{reason:e.code||e.message});throw e;}
  }
  project(row){
    const p=publicState(row.state);let decision=null;
    const last=this.db.prepare("SELECT event_json FROM match_events WHERE match_id=? AND json_extract(event_json,'$.type')='jev' ORDER BY sequence DESC LIMIT 1").get(row.id);
    if(last){const e=JSON.parse(last.event_json);decision={source:e.decision?.source,confidence:e.decision?.confidence??null,candidateCount:e.decision?.candidateCount??null,latencyMs:e.decision?.latencyMs??null,technique:e.action.proof.technique};
      if(row.state.eligibility!=='ranked'||row.state.phase==='finished')decision.action=e.action;}
    if(p.jev&&this.pending.get(row.id)?.decision)p.jev.status='ready';
    return {id:row.id,challengeId:row.challenge_id,hasCommunity:!!row.guild_id,serverNow:this.now(),startedAt:row.started_at,
      ...p,elapsedMs:row.state.phase==='ready'?0:row.state.phase==='finished'?row.state.elapsedMs:this.elapsed(row),decision,
      opponent:!this.config.jevKey?'Local heuristic':row.state.providerFallback?'Heuristic fallback':'JEV',
      verified:!!this.db.prepare('SELECT 1 FROM results WHERE match_id=?').get(row.id)};
  }
  broadcast(id){const set=this.streams.get(id);if(!set?.size)return;const p=this.project(this.row(id));for(const res of set){if(!res.destroyed)res.write(`event: state\nid: ${p.sequence}\ndata: ${JSON.stringify(p)}\n\n`);}}
  recover(){for(const {id} of this.db.prepare("SELECT id FROM matches WHERE status IN('running','settling')").all()){
    const row=this.row(id);this.append(id,{type:'void',ms:this.elapsed(row),reason:'server_interrupted'},'server-interrupted');
  }for(const {id} of this.db.prepare("SELECT m.id FROM matches m LEFT JOIN results r ON m.id=r.match_id WHERE m.status='finished' AND r.match_id IS NULL").all())this.finalize(this.row(id));}
  close(){this.closed=true;clearInterval(this.timer);this.pending.clear();for(const set of this.streams.values())for(const res of set)res.end();this.streams.clear();}
}
