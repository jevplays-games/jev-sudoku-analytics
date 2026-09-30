import test from 'node:test';import assert from 'node:assert/strict';
import {createApp} from '../server/server.js';import {loadConfig} from '../server/config.js';import {openDb} from '../server/db.js';import {hash} from '../server/security.js';
const APP='123456789012345678',ACTIVITY=`https://${APP}.discordsays.com`;
function discordFetch(calls=[],failToken=false){
  return async(url,options)=>{
    calls.push({url:String(url),body:options?.body?String(options.body):null});
    if(String(url).endsWith('/oauth2/token'))return failToken?new Response('no',{status:400}):new Response(JSON.stringify({access_token:'fixture-access'}),{headers:{'Content-Type':'application/json'}});
    if(String(url).endsWith('/users/@me'))return new Response(JSON.stringify({id:'223344556677889900',username:'player',global_name:'Player One',avatar:null}),{headers:{'Content-Type':'application/json'}});
    throw new Error(`unexpected fetch ${url}`);
  };
}
async function setup(env={},fetchImpl=discordFetch()){
  const cfg={...loadConfig({LAUNCH_SIGNING_KEY:'b'.repeat(64),DISCORD_CLIENT_ID:APP,DISCORD_CLIENT_SECRET:'fixture-secret',...env}),port:0},app=createApp({config:cfg,db:openDb(':memory:'),autoTick:false,fetchImpl});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));cfg.origin=`http://127.0.0.1:${app.server.address().port}`;
  const send=(path,{method='GET',body,origin,headers={}}={})=>fetch(`${cfg.origin}${path}`,{method,headers:{...(origin?{Origin:origin}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const session=async(origin=ACTIVITY,code='sdk-code')=>send('/api/activity/session',{method:'POST',origin,body:{code}});
  return {...app,base:cfg.origin,send,session};
}
const bearer=s=>({Authorization:`Bearer ${s.token}`});

test('activity config exposes only the public client id and needs Discord configured',async()=>{
  const x=await setup();try{const r=await x.send('/api/activity/config');assert.equal(r.status,200);assert.deepEqual(await r.json(),{clientId:APP});}finally{await x.close();}
  const bare=await setup({DISCORD_CLIENT_ID:'',DISCORD_CLIENT_SECRET:''});try{assert.equal((await bare.send('/api/activity/config')).status,503);assert.equal((await bare.session()).status,503);}finally{await bare.close();}
});
test('an SDK code becomes a bearer session: exchanged without a redirect uri, raw token not stored',async()=>{
  const calls=[],x=await setup({},discordFetch(calls));
  try{
    const r=await x.session();assert.equal(r.status,200);assert.equal(r.headers.get('set-cookie'),null,'no cookie is set inside an Activity');
    const s=await r.json();assert.match(s.token,/^[A-Za-z0-9_-]{43}$/);assert.ok(s.csrf);assert.equal(s.accessToken,'fixture-access');assert.equal(s.user.display_name,'Player One');
    const exchange=new URLSearchParams(calls[0].body);assert.equal(exchange.get('grant_type'),'authorization_code');assert.equal(exchange.get('code'),'sdk-code');assert.equal(exchange.get('client_secret'),'fixture-secret');assert.equal(exchange.has('redirect_uri'),false);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM sessions WHERE hash=?').get(s.token).n,0,'the raw token must not be stored');
    const row=x.db.prepare('SELECT * FROM sessions WHERE hash=?').get(hash(s.token));assert.equal(row.user_id,'223344556677889900');assert.equal(row.csrf,s.csrf);assert.ok(row.expires_at-Date.now()<=86400000);
    assert.ok(!JSON.stringify(x.db.prepare('SELECT * FROM sessions').all()).includes('fixture-access'),'the Discord access token is never persisted');
  }finally{await x.close();}
});
test('the bearer session works for reads and for mutations from the activity origin',async()=>{
  const x=await setup();
  try{
    const s=await(await x.session()).json(),me=await(await x.send('/api/me',{headers:bearer(s)})).json();
    assert.equal(me.user.display_name,'Player One');assert.equal(me.csrfToken,s.csrf);
    const created=await x.send('/api/matches',{method:'POST',origin:ACTIVITY,headers:{...bearer(s),'X-CSRF-Token':s.csrf},body:{requestId:'activity-create-1',mode:'practice'}});assert.equal(created.status,201);
    const match=await created.json(),read=await x.send(`/api/matches/${match.id}`,{headers:bearer(s)});assert.equal(read.status,200);
    const stream=await fetch(`${x.base}/api/matches/${match.id}/events`,{headers:bearer(s),signal:AbortSignal.timeout(2000)});assert.equal(stream.status,200);await stream.body.cancel();
    const out=await x.send('/api/logout',{method:'POST',origin:ACTIVITY,headers:{...bearer(s),'X-CSRF-Token':s.csrf},body:{}});assert.equal(out.status,200);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM sessions WHERE hash=?').get(hash(s.token)).n,0);
  }finally{await x.close();}
});
test('the activity origin is accepted only together with a bearer session',async()=>{
  const x=await setup();
  try{
    const s=await(await x.session()).json(),first=await x.send('/api/me'),cookie=first.headers.get('set-cookie').split(';')[0],me=await first.json();
    const mutate=(origin,headers)=>x.send('/api/privacy',{method:'POST',origin,headers,body:{telemetryConsent:false}});
    assert.equal((await mutate(ACTIVITY,{Cookie:cookie,'X-CSRF-Token':me.csrfToken})).status,403,'a cookie session must not be usable from the discordsays origin');
    assert.equal((await mutate(x.base,{Cookie:cookie,'X-CSRF-Token':me.csrfToken})).status,200,'the normal browser flow is unchanged');
    assert.equal((await mutate('https://evil.example',{...bearer(s),'X-CSRF-Token':s.csrf})).status,403);
    assert.equal((await mutate('https://999999999999999999.discordsays.com',{...bearer(s),'X-CSRF-Token':s.csrf})).status,403,'another application\'s discordsays origin is not ours');
    assert.equal((await mutate(ACTIVITY,bearer(s))).status,403,'csrf is still required');
    assert.equal((await mutate(undefined,{...bearer(s),'X-CSRF-Token':s.csrf})).status,403,'origin is still required');
    assert.equal((await mutate(ACTIVITY,{...bearer(s),'X-CSRF-Token':s.csrf})).status,200);
    // A bearer that matches no session, or is malformed, never grants access.
    assert.equal((await mutate(ACTIVITY,{Authorization:`Bearer ${'A'.repeat(43)}`,'X-CSRF-Token':s.csrf})).status,401);
    assert.equal((await x.send('/api/me/export',{headers:{Authorization:'Bearer nothex'}})).status,401);
  }finally{await x.close();}
});
test('with no Discord client id the activity origin is never accepted',async()=>{
  const x=await setup({DISCORD_CLIENT_ID:'',DISCORD_CLIENT_SECRET:''});try{assert.equal(x.service.config.activityOrigin,null);assert.equal((await x.session('undefined.discordsays.com')).status,503);}finally{await x.close();}
});
test('session creation rejects foreign origins, missing codes and Discord failures',async()=>{
  const x=await setup();
  try{
    assert.equal((await x.session('https://evil.example')).status,403);
    assert.equal((await x.session('https://999999999999999999.discordsays.com')).status,403);
    assert.equal((await x.session(null)).status,403);
    assert.equal((await x.send('/api/activity/session',{method:'POST',origin:ACTIVITY,body:{}})).status,400);
    assert.equal((await x.session(ACTIVITY,'x'.repeat(5000))).status,400);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
  }finally{await x.close();}
  const failing=await setup({},discordFetch([],true));try{assert.equal((await failing.session()).status,502);assert.equal(failing.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);}finally{await failing.close();}
});
test('only a page loaded with frame_id may be framed, and only by Discord',async()=>{
  const x=await setup();
  try{
    const plain=await x.send('/'),framed=await x.send('/?frame_id=1&instance_id=2&platform=desktop');
    assert.equal(plain.headers.get('x-frame-options'),'DENY');assert.match(plain.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal(framed.headers.get('x-frame-options'),null);const csp=framed.headers.get('content-security-policy');
    assert.match(csp,/frame-ancestors https:\/\/discord\.com https:\/\/ptb\.discord\.com https:\/\/canary\.discord\.com(;|$)/);assert.ok(!csp.includes("frame-ancestors 'none'"));
    assert.match(csp,/script-src 'self'/,'the rest of the policy is unchanged');assert.match(csp,/connect-src 'self'/);
    const api=await x.send('/api/me?frame_id=1');assert.equal(api.headers.get('x-frame-options'),'DENY','API responses are never frameable');assert.match(api.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    for(const path of ['/activity.js','/vendor/discord-embedded-app-sdk.js']){const r=await x.send(path);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);await r.arrayBuffer();}
  }finally{await x.close();}
});
