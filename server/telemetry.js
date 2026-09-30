import { invariant } from '../public/shared/sudoku.js';
import { run } from './db.js';
import { now } from './util.js';
export const CLIENT_EVENTS=Object.freeze({
  cell_focus:{cell:['int',0,80],durationMs:['number',0,60000]},
  note_added:{cell:['int',0,80]},note_removed:{cell:['int',0,80]},
  visibility:{hiddenMs:['number',0,3600000]},input_method:{method:['enum','keyboard','touch','mouse']},
  action_rtt:{durationMs:['number',0,120000]},long_task:{durationMs:['number',0,120000]},
  reconnect:{},local_conflict:{cell:['int',0,80]},analysis_opened:{},rules_opened:{},
  replay_opened:{},export_requested:{format:['enum','json','csv']}
});
export function validateClientEvent(event) {
  invariant(event&&typeof event==='object'&&typeof event.id==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(event.id),'invalid_telemetry_id');
  invariant(Object.hasOwn(CLIENT_EVENTS,event.name),'unknown_telemetry_event');
  const schema=CLIENT_EVENTS[event.name],p=event.properties||{};invariant(typeof p==='object'&&!Array.isArray(p),'invalid_telemetry_properties');
  invariant(Object.keys(p).every(k=>Object.hasOwn(schema,k)),'unknown_telemetry_property');
  const properties={};
  for(const [key,rule] of Object.entries(schema)){
    const v=p[key];if(rule[0]==='enum')invariant(rule.slice(1).includes(v),'invalid_telemetry_value');
    else invariant(Number.isFinite(v)&&(rule[0]!=='int'||Number.isInteger(v))&&v>=rule[1]&&v<=rule[2],'invalid_telemetry_value');
    properties[key]=v;
  }
  return {id:event.id,name:event.name,properties};
}
export const trackStatement=(env,matchId,name,properties,trust='server',clientId=null,at=now(env))=>env.DB.prepare('INSERT OR IGNORE INTO telemetry(match_id,name,trust,properties_json,client_event_id,created_at) VALUES(?,?,?,?,?,?)').bind(matchId,name,trust,JSON.stringify(properties),clientId,at);
export const track=(env,matchId,name,properties,trust='server',clientId=null,at=now(env))=>trackStatement(env,matchId,name,properties,trust,clientId,at).run();
export const operation=(env,name,properties,at=now(env))=>run(env,'INSERT INTO operations(name,properties_json,created_at) VALUES(?,?,?)',name,JSON.stringify(properties),at);
