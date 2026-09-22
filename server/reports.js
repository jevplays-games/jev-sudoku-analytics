import { distribution,aggregateReports } from '../shared/analytics.js';
import { httpError } from './security.js';
import { readMatch } from './db.js';
const day=ms=>new Date(ms).toISOString().slice(0,10);
export function leaderboard(db,session,params,now=Date.now()) {
  const scope=params.get('scope')||'world',date=params.get('date')||day(now),difficulty=params.get('difficulty')||'normal';
  if(!['world','server','channel'].includes(scope)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!['easy','normal','hard','jev'].includes(difficulty))throw httpError(422,'invalid_leaderboard_filter');
  let context=session?.context_json?JSON.parse(session.context_json):null;
  if(scope!=='world'&&(!session?.user_id||!context||context.expiresAt<=now||context.userId!==session.user_id))throw httpError(403,'fresh_discord_context_required');
  const challenge=db.prepare('SELECT id FROM challenges WHERE utc_date=? AND difficulty=?').get(date,difficulty);
  const requestedLimit=Number(params.get('limit')||50);if(!Number.isInteger(requestedLimit)||requestedLimit<1||requestedLimit>100)throw httpError(422,'invalid_limit');
  let offset=0;if(params.get('cursor')){try{const c=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());
    if(c.scope!==scope||c.date!==date||c.difficulty!==difficulty||!Number.isInteger(c.offset)||c.offset<0||c.offset>1000000)throw Error();offset=c.offset;
  }catch{throw httpError(422,'invalid_cursor');}}
  if(!challenge)return {scope,date,difficulty,entries:[],nextCursor:null,published:false};
  let conditions='m.challenge_id=? AND r.eligible=1 AND r.human_bucket IS NOT NULL AND m.user_id IS NOT NULL',values=[challenge.id];
  if(scope!=='world'){conditions+=' AND m.guild_id=?';values.push(context.guildId);}
  if(scope==='channel'){conditions+=' AND m.channel_id=?';values.push(context.channelId);}
  const entries=db.prepare(`SELECT * FROM (SELECT RANK() OVER(ORDER BY r.human_bucket) AS rank,m.id AS match_id,
    u.display_name,r.human_bucket AS seconds,r.winner FROM results r JOIN matches m ON m.id=r.match_id JOIN users u ON u.id=m.user_id
    WHERE ${conditions}) ORDER BY seconds,match_id LIMIT ? OFFSET ?`).all(...values,requestedLimit+1,offset);
  const hasMore=entries.length>requestedLimit;entries.splice(requestedLimit);
  return {scope,date,difficulty,published:true,entries,nextCursor:hasMore?Buffer.from(JSON.stringify({scope,date,difficulty,offset:offset+requestedLimit})).toString('base64url'):null};
}
export function personalReports(db,service,session,limit=200) {
  const where=session.user_id?'m.user_id=?':'m.owner_hash=?',value=session.user_id||session.hash;
  const total=db.prepare(`SELECT COUNT(*) AS n FROM matches m WHERE ${where}`).get(value).n;
  const rows=db.prepare(`SELECT m.id,m.created_at,m.status,r.analytics_json FROM matches m LEFT JOIN results r ON r.match_id=m.id WHERE ${where} ORDER BY m.created_at DESC LIMIT ?`).all(value,limit);
  const reports=rows.map(r=>r.analytics_json?JSON.parse(r.analytics_json):service.report(readMatch(db,r.id))).reverse();
  return {coverage:{returned:rows.length,total,limit,truncated:total>limit,order:'Most recent matches; streaks apply to this returned window.'},
    summary:aggregateReports(reports),history:rows.map(r=>{const report=r.analytics_json?JSON.parse(r.analytics_json):service.report(readMatch(db,r.id));
      return {id:r.id,createdAt:r.created_at,phase:r.status,difficulty:report.dimensions.difficulty,mode:report.dimensions.mode,
        eligibility:report.game.eligibility,outcome:report.game.outcome,humanTimeMs:report.game.humanFinishMs,jevTimeMs:report.game.jevFinishMs};})};
}
export function operatorReport(db,{days=30,now=Date.now(),difficulty=null}={}) {
  if(!Number.isInteger(days)||days<1||days>365)throw httpError(422,'invalid_days');
  const since=now-days*86400000;
  const clauses=['m.created_at>=?','m.created_at<=?'],params=[since,now];
  if(difficulty){if(!['easy','normal','hard','jev'].includes(difficulty))throw httpError(422,'invalid_difficulty');clauses.push('json_extract(m.initial_json,\'$.config.difficulty\')=?');params.push(difficulty);}
  const rows=db.prepare(`SELECT m.*,r.analytics_json FROM matches m LEFT JOIN results r ON m.id=r.match_id WHERE ${clauses.join(' AND ')} ORDER BY m.created_at`).all(...params);
  const resultReports=rows.filter(r=>r.analytics_json).map(r=>JSON.parse(r.analytics_json));
  const requests=db.prepare("SELECT properties_json FROM operations WHERE name='http_request' AND created_at BETWEEN ? AND ?").all(since,now).map(r=>JSON.parse(r.properties_json));
  const byRoute={};for(const r of requests){const key=`${r.method} ${r.route}`;(byRoute[key]||=[]).push(r);}
  const routeMetrics=Object.entries(byRoute).map(([route,rs])=>({route,requests:rs.length,serverErrors:rs.filter(r=>r.status>=500).length,
    clientErrors:rs.filter(r=>r.status>=400&&r.status<500).length,rateLimited:rs.filter(r=>r.status===429).length,latencyMs:distribution(rs.map(r=>r.durationMs))}));
  const activityRows=db.prepare("SELECT user_id,owner_hash,started_at FROM matches WHERE started_at BETWEEN ? AND ?"+(difficulty?" AND json_extract(initial_json,'$.config.difficulty')=?":'')).all(since,now,...(difficulty?[difficulty]:[]));
  const activeIds=window=>new Set(activityRows.filter(r=>r.started_at>=now-window&&r.user_id).map(r=>r.user_id)).size;
  const activeByDay={},funnel={reserved:rows.length,started:0,firstAction:0,finished:0,completed:0,rankedVerified:0};
  for(const r of rows){
    if(r.started_at)funnel.started++;
    const s=JSON.parse(r.state_json);if(s.human.revision>0)funnel.firstAction++;if(s.phase==='finished')funnel.finished++;if(s.human.finishMs!==null)funnel.completed++;
    if(r.analytics_json&&JSON.parse(r.analytics_json).game.eligibility==='ranked')funnel.rankedVerified++;
  }
  for(const r of activityRows){const key=day(r.started_at);(activeByDay[key]||=new Set());if(r.user_id)activeByDay[key].add(r.user_id);}
  const allActive=db.prepare('SELECT DISTINCT user_id,substr(datetime(started_at/1000,\'unixepoch\'),1,10) AS day FROM matches WHERE user_id IS NOT NULL AND started_at IS NOT NULL').all();
  const activity=new Map();for(const r of allActive){if(!activity.has(r.user_id))activity.set(r.user_id,new Set());activity.get(r.user_id).add(r.day);}
  const cohorts={};
  for(const [id,dates] of activity){const first=[...dates].sort()[0],firstMs=Date.parse(first+'T00:00:00Z');if(firstMs<since||firstMs>now)continue;
    const c=cohorts[first]||={cohortDate:first,players:0,d1Eligible:0,d1Returned:0,d7Eligible:0,d7Returned:0,d30Eligible:0,d30Returned:0};c.players++;
    for(const offset of [1,7,30]){const target=firstMs+offset*86400000;if(target+86400000<=now){c[`d${offset}Eligible`]++;if(dates.has(day(target)))c[`d${offset}Returned`]++;}}
  }
  const retention=Object.values(cohorts).map(c=>({...c,d1:c.d1Eligible?c.d1Returned/c.d1Eligible:null,d7:c.d7Eligible?c.d7Returned/c.d7Eligible:null,d30:c.d30Eligible?c.d30Returned/c.d30Eligible:null}));
  const totals=db.prepare('SELECT COUNT(*) AS events,MIN(created_at) AS firstAt,MAX(created_at) AS lastAt FROM operations WHERE created_at BETWEEN ? AND ?').get(since,now);
  const security=db.prepare("SELECT name,COUNT(*) AS count FROM operations WHERE created_at BETWEEN ? AND ? AND name IN('security_rejected','context_rejected','verification_failed','scheduler_error') GROUP BY name").all(since,now);
  return {schemaVersion:'operator-analytics-v1',coverage:{from:new Date(since).toISOString(),through:new Date(now).toISOString(),days,difficulty,
      matches:rows.length,completedReports:resultReports.length,httpMetrics:requests.length,operations:totals,liveMatchesExcludedFromCompletedSummary:true},
    summary:aggregateReports(resultReports),funnel,
    activity:{authenticatedDAU:days>=1?activeIds(86400000):null,authenticatedWAU:days>=7?activeIds(7*86400000):null,
      authenticatedMAU:days>=30?activeIds(30*86400000):null,guestSessions:new Set(activityRows.filter(r=>!r.user_id).map(r=>r.owner_hash)).size,
      byUtcDay:Object.entries(activeByDay).map(([date,ids])=>({date,authenticatedPlayers:ids.size}))},
    retention,routeMetrics,security,
    definitions:{active:'Authenticated user with a started match within the rolling window. Guests are separate sessions, not people.',
      retention:'Exact UTC-day return after first observed started match; only fully elapsed return days enter the denominator. All difficulties, independent of the difficulty filter.',
      funnel:'Reserved matches in the selected creation-time window, not unique people.',
      http:'Application handlers only; SSE connection lifetime is excluded from request latency.',
      samples:'Percentiles use linear interpolation; small sample sizes are shown, not suppressed or extrapolated.',
      window:'All returned observations are bounded by stored data. Retention/purges and account deletion affect historical counts.'}};
}
