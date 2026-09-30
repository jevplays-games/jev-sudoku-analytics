import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadConfig } from './config.js';
import { openDb,readEvents,readTelemetry,readMatch,transaction } from './db.js';
import { MatchService } from './matches.js';
import { getSession,issueSession,sessionCookie,requireCsrf,RateLimiter,httpError,hash,same } from './security.js';
import { startOAuth,finishOAuth,redeemContext,handleInteraction,activityConfig,activitySession } from './auth.js';
import { track,operation,validateClientEvent } from './telemetry.js';
import { leaderboard,personalReports,operatorReport } from './reports.js';
import { toCsv } from '../shared/analytics.js';
const staticFiles=new Map([
  ['/', ['public/index.html','text/html; charset=utf-8']],['/index.html',['public/index.html','text/html; charset=utf-8']],
  ['/activity.js',['public/activity.js','text/javascript; charset=utf-8']],['/vendor/discord-embedded-app-sdk.js',['public/vendor/discord-embedded-app-sdk.js','text/javascript; charset=utf-8']],
  ['/game.css',['public/game.css','text/css; charset=utf-8']],['/game.js',['public/game.js','text/javascript; charset=utf-8']],
  ['/analytics-ui.js',['public/analytics-ui.js','text/javascript; charset=utf-8']],
  ['/brand/brand.css',['public/brand/brand.css','text/css; charset=utf-8']],['/brand/brand.js',['public/brand/brand.js','text/javascript; charset=utf-8']],
  ['/brand/icon.svg',['public/brand/icon.svg','image/svg+xml']],['/brand/mark.svg',['public/brand/mark.svg','image/svg+xml']],
  ['/brand/inter-var.woff2',['public/brand/inter-var.woff2','font/woff2']],['/brand/OFL.txt',['public/brand/OFL.txt','text/plain; charset=utf-8']],
  ...['sudoku','sudoku-ai','match','replay','analytics'].map(n=>[`/shared/${n}.js`,[`shared/${n}.js`,'text/javascript; charset=utf-8']])
]);
// Discord shows an Activity inside its own iframe. Only a document loaded with Discord's frame_id may be framed, and only by Discord.
const ACTIVITY_FRAME_ANCESTORS='frame-ancestors https://discord.com https://ptb.discord.com https://canary.discord.com';
const isFramedDocument=req=>{try{const url=new URL(req.url,'http://x');return !url.pathname.startsWith('/api/')&&url.searchParams.has('frame_id');}catch{return false;}};
const normalizeRoute=path=>path.replace(/\/api\/matches\/[^/]+/,'/api/matches/:id');
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
async function readBody(req,limit=65536){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw httpError(413,'request_too_large');chunks.push(chunk);}return Buffer.concat(chunks);}
async function readJson(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))throw httpError(415,'json_required');
  try{const v=JSON.parse((await readBody(req)).toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch(e){if(e.status)throw e;throw httpError(400,'invalid_json');}}
export function createApp({config=loadConfig(),db=openDb(config.database),fetchImpl=fetch,autoTick=true}={}) {
  const service=new MatchService(db,config,{fetchImpl,autoTick}),rate=new RateLimiter();service.recover();
  const server=createServer(async(req,res)=>{
    const started=performance.now();let path='unknown';
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(isFramedDocument(req)){res.removeHeader('X-Frame-Options');res.setHeader('Content-Security-Policy',res.getHeader('Content-Security-Policy').replace("frame-ancestors 'none'",ACTIVITY_FRAME_ANCESTORS));}
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(config.production)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    res.on('finish',()=>{if(path.startsWith('/api/')&&!path.endsWith('/events')&&!service.closed)operation(db,'http_request',{route:normalizeRoute(path),method:req.method,status:res.statusCode,durationMs:performance.now()-started});});
    try{
      const url=new URL(req.url,config.origin);path=url.pathname;
      const remote=req.socket.remoteAddress||'unknown';
      // In-memory only. Reverse-proxy installations should also enforce edge limits.
      if(!rate.allow(`ip:${remote}`,1200,60000))throw httpError(429,'request_rate_limit');
      if(req.method==='GET'&&path==='/healthz'){json(res,200,{status:'ok',draining:service.draining});return;}
      if(req.method==='GET'&&staticFiles.has(path)){
        const [file,type]=staticFiles.get(path),bytes=await readFile(new URL(`../${file}`,import.meta.url));
        res.writeHead(200,{'Content-Type':type,'Cache-Control':path==='/'?'no-cache':'public, max-age=300'});res.end(bytes);return;
      }
      if(path==='/api/discord/interactions'&&req.method==='POST'){const raw=await readBody(req);json(res,200,handleInteraction(db,config,req,raw));return;}
      if(path==='/api/activity/config'&&req.method==='GET'){json(res,200,activityConfig(config));return;}
      if(path==='/api/activity/session'&&req.method==='POST'){
        if(!rate.allow(`activity-session:${remote}`,300,3600000))throw httpError(429,'session_rate_limit');
        json(res,200,await activitySession(db,config,req.headers.origin,(await readJson(req)).code,fetchImpl));return;
      }
      let session=getSession(db,req);
      if(path==='/api/me'&&req.method==='GET'){
        if(!session){const issued=issueSession(db);session=issued.row;res.setHeader('Set-Cookie',sessionCookie(issued.raw,config.production));}
        let context=session.context_json?JSON.parse(session.context_json):null;if(context?.expiresAt<=Date.now())context=null;
        const user=session.user_id?db.prepare('SELECT id,display_name FROM users WHERE id=?').get(session.user_id):null;
        const active=db.prepare("SELECT id,status FROM matches WHERE status!='finished' AND (owner_hash=? OR (user_id IS NOT NULL AND user_id=?)) ORDER BY created_at DESC LIMIT 1").get(session.hash,session.user_id)||null;
        json(res,200,{user,csrfToken:session.csrf,context:context?{guildId:context.guildId,channelId:context.channelId,expiresAt:context.expiresAt}:null,
          telemetryConsent:!!session.telemetry_consent,activeMatch:active,admin:!!user&&config.admins.includes(user.id),
          capabilities:{discord:!!config.discordClientId&&!!config.discordClientSecret,jev:!!config.jevKey,ranked:!!config.jevKey&&!!config.discordClientId},
          version:'1.0.0'});return;
      }
      if(path==='/api/auth/discord'&&req.method==='GET'){
        if(!session){const issued=issueSession(db);session=issued.row;res.setHeader('Set-Cookie',sessionCookie(issued.raw,config.production));}
        res.writeHead(302,{Location:startOAuth(db,config,session),'Cache-Control':'no-store'});res.end();return;
      }
      if(path==='/api/auth/discord/callback'&&req.method==='GET'){
        try{const issued=await finishOAuth(db,config,session,url.searchParams,fetchImpl);res.setHeader('Set-Cookie',sessionCookie(issued.raw,config.production));res.writeHead(302,{Location:'/#login=success'});res.end();}
        catch(e){operation(db,'oauth_failed',{reason:e.status?e.message:'provider_error'});res.writeHead(302,{Location:'/#login=failed'});res.end();}return;
      }
      if(path==='/api/leaderboard'&&req.method==='GET'){json(res,200,leaderboard(db,session,url.searchParams));return;}
      if(path==='/api/analytics/operator'&&req.method==='GET'){
        const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');
        const allowed=session?.user_id&&config.admins.includes(session.user_id)||config.analyticsToken&&same(bearer,config.analyticsToken);
        if(!allowed)throw httpError(403,'operator_access_required');
        if(!rate.allow(`operator:${session?.hash||remote}`,20,60000))throw httpError(429,'analytics_rate_limit');
        json(res,200,operatorReport(db,{days:Number(url.searchParams.get('days')||30),difficulty:url.searchParams.get('difficulty')}));return;
      }
      if(!session)throw httpError(401,'session_required');
      if(['POST','DELETE','PATCH'].includes(req.method))requireCsrf(req,session,config.origin,config.activityOrigin);
      if(path==='/api/logout'&&req.method==='POST'){db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);res.setHeader('Set-Cookie',sessionCookie('',config.production,0));json(res,200,{ok:true});return;}
      if(path==='/api/context'&&req.method==='POST'){json(res,200,redeemContext(db,config,session,(await readJson(req)).launch));return;}
      if(path==='/api/privacy'&&req.method==='POST'){
        const input=await readJson(req);if(typeof input.telemetryConsent!=='boolean')throw httpError(422,'invalid_consent');
        db.prepare('UPDATE sessions SET telemetry_consent=? WHERE hash=?').run(Number(input.telemetryConsent),session.hash);
        if(!input.telemetryConsent){
          db.prepare("DELETE FROM telemetry WHERE trust='client' AND match_id IN(SELECT id FROM matches WHERE owner_hash=? OR (user_id IS NOT NULL AND user_id=?))").run(session.hash,session.user_id);
          for(const {id} of db.prepare('SELECT m.id FROM matches m JOIN results r ON r.match_id=m.id WHERE m.owner_hash=? OR (m.user_id IS NOT NULL AND m.user_id=?)').all(session.hash,session.user_id))db.prepare('UPDATE results SET analytics_json=? WHERE match_id=?').run(JSON.stringify(service.report(readMatch(db,id))),id);
        }
        json(res,200,{telemetryConsent:input.telemetryConsent});return;
      }
      if(path==='/api/me/export'&&req.method==='GET'){
        const ids=db.prepare('SELECT id FROM matches WHERE owner_hash=? OR (user_id IS NOT NULL AND user_id=?) ORDER BY created_at').all(session.hash,session.user_id);
        const matches=ids.map(({id})=>{const row=readMatch(db,id);return {id,state:service.project(row),analytics:service.analytics(id,session),
          replay:row.state.phase==='finished'?service.replay(id,session):null};});
        res.setHeader('Content-Disposition','attachment; filename="jev-sudoku-my-data.json"');json(res,200,{exportVersion:1,generatedAt:new Date().toISOString(),matches});return;
      }
      if(path==='/api/me/data'&&req.method==='DELETE'){
        if((await readJson(req)).confirm!=='DELETE MY DATA')throw httpError(422,'deletion_confirmation_required');
        transaction(db,()=>{
          const ids=db.prepare('SELECT id FROM matches WHERE owner_hash=? OR (user_id IS NOT NULL AND user_id=?)').all(session.hash,session.user_id);
          for(const {id} of ids){service.pending.delete(id);const streams=service.streams.get(id);if(streams)for(const r of streams)r.end();service.streams.delete(id);db.prepare('DELETE FROM matches WHERE id=?').run(id);}
          if(session.user_id){db.prepare('DELETE FROM security_tokens WHERE user_id=?').run(session.user_id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(session.user_id);db.prepare('DELETE FROM users WHERE id=?').run(session.user_id);}
          else db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
        });res.setHeader('Set-Cookie',sessionCookie('',config.production,0));json(res,200,{deleted:true});return;
      }
      if(path==='/api/analytics/me'&&req.method==='GET'){
        if(!rate.allow(`personal:${session.hash}`,30,60000))throw httpError(429,'analytics_rate_limit');
        json(res,200,personalReports(db,service,session));return;
      }
      if(path==='/api/matches'&&req.method==='POST'){
        if(!rate.allow(`create:${session.hash}`,12,3600000)||!rate.allow(`create-ip:${remote}`,60,3600000))throw httpError(429,'new_game_rate_limit');
        json(res,201,service.create(session,await readJson(req)));return;
      }
      const match=path.match(/^\/api\/matches\/([a-zA-Z0-9-]{1,80})(?:\/(start|actions|events|analytics|replay|reveal|telemetry))?$/);
      if(match){const [,id,action]=match;const row=service.owned(id,session);
        if(!action&&req.method==='GET'){json(res,200,service.project(row));return;}
        if(action==='start'&&req.method==='POST'){await readJson(req);json(res,200,service.start(id,session));return;}
        if(action==='actions'&&req.method==='POST'){
          if(!rate.allow(`actions:${id}`,180,60000))throw httpError(429,'action_rate_limit');json(res,200,service.action(id,session,await readJson(req)));return;
        }
        if(action==='reveal'&&req.method==='POST'){await readJson(req);json(res,200,service.reveal(id,session));return;}
        if(action==='replay'&&req.method==='GET'){res.setHeader('Content-Disposition','attachment; filename="sudoku-replay.json"');json(res,200,service.replay(id,session));return;}
        if(action==='analytics'&&req.method==='GET'){
          if(!rate.allow(`analytics:${id}`,40,60000))throw httpError(429,'analytics_rate_limit');
          const report=service.analytics(id,session);
          if(url.searchParams.get('format')==='csv'){
            res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="sudoku-decisions.csv"','Cache-Control':'no-store'});
            res.end(toCsv(report.jev.decisions,['sequence','ms','source','model','kind','technique','candidates','confidence','entropyBits','topTwoMargin','inferenceMs','preprocessingMs','pacingWaitMs','branchDepth']));
          }else json(res,200,report);return;
        }
        if(action==='telemetry'&&req.method==='POST'){
          if(!session.telemetry_consent)throw httpError(403,'telemetry_consent_required');
          if(!rate.allow(`telemetry:${id}`,20,60000))throw httpError(429,'telemetry_rate_limit');
          const body=await readJson(req);if(!Array.isArray(body.events)||body.events.length>50)throw httpError(422,'invalid_telemetry_batch');
          let events;try{events=body.events.map(validateClientEvent);}catch(e){throw httpError(422,e.code||'invalid_telemetry');}transaction(db,()=>{for(const e of events)track(db,id,e.name,e.properties,'client',e.id);});json(res,200,{accepted:events.length});return;
        }
        if(action==='events'&&req.method==='GET'){
          const set=service.streams.get(id)||new Set();if(set.size>=4)throw httpError(429,'stream_limit');service.streams.set(id,set);set.add(res);
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          res.write(`event: state\nid: ${row.state.sequence}\ndata: ${JSON.stringify(service.project(row))}\n\n`);
          const heartbeat=setInterval(()=>{const current=getSession(db,req);if(!current){res.end();return;}res.write(': heartbeat\n\n');},15000);heartbeat.unref();
          res.on('close',()=>{clearInterval(heartbeat);set.delete(res);if(!set.size)service.streams.delete(id);});return;
        }
      }
      throw httpError(404,'not_found');
    }catch(error){
      const status=error.status||500;
      if([401,403,429].includes(status))operation(db,'security_rejected',{route:normalizeRoute(path),status,reason:error.message});
      if(status>=500)operation(db,'request_error',{route:normalizeRoute(path),reason:error.status?error.message:'internal_error'});
      if(!res.headersSent)json(res,status,{error:error.status?error.message:'internal_error'});else res.end();
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return {server,db,service,close:async()=>{service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const app=createApp(),config=app.service.config;
  app.server.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'server_started',origin:config.origin,bind:config.host,port:app.server.address().port,
    opponent:config.jevKey?'JEV':'local_heuristic',discordConfigured:!!config.discordClientId})));
  let stopping=false;const stop=()=>{if(stopping){app.close().then(()=>process.exit(0));return;}stopping=true;app.service.draining=true;
    console.log(JSON.stringify({event:'draining',note:'No new matches accepted. A second signal exits immediately; active attempts become void on recovery.'}));
    const graceMs=Number(process.env.SHUTDOWN_GRACE_MS);if(Number.isInteger(graceMs)&&graceMs>0)setTimeout(()=>{console.log(JSON.stringify({event:'drain_grace_expired',graceMs}));app.close().then(()=>process.exit(0));},graceMs).unref();
    const drain=setInterval(()=>{const n=app.db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status IN('running','settling')").get().n;
      if(!n){clearInterval(drain);app.close().then(()=>process.exit(0));}},500);};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
