import { hash,token,httpError,issueSession,sessionCookie,verifyLaunch,signLaunch,verifyDiscord } from './security.js';
import { transaction } from './db.js';
import { operation } from './telemetry.js';
const discordBase='https://discord.com/api/v10';
export function startOAuth(db,config,session) {
  if(!config.discordClientId||!config.discordClientSecret)throw httpError(503,'discord_not_configured');
  const state=token(),now=Date.now();
  db.prepare('INSERT INTO security_tokens(hash,kind,session_hash,payload_json,expires_at) VALUES(?,?,?,?,?)').run(hash(state),'oauth',session.hash,'{}',now+600000);
  const url=new URL('https://discord.com/oauth2/authorize');
  url.search=new URLSearchParams({client_id:config.discordClientId,response_type:'code',redirect_uri:`${config.origin}/api/auth/discord/callback`,scope:'identify',state}).toString();
  operation(db,'oauth_started',{});return url.toString();
}
export async function finishOAuth(db,config,session,params,fetchImpl=fetch) {
  const state=params.get('state'),code=params.get('code');
  if(!session||!state||state.length>100)throw httpError(403,'oauth_state_rejected');
  transaction(db,()=>{
    const row=db.prepare('SELECT * FROM security_tokens WHERE hash=? AND kind=?').get(hash(state),'oauth');
    if(!row||row.used_at||row.expires_at<=Date.now()||row.session_hash!==session.hash)throw httpError(403,'oauth_state_rejected');
    db.prepare('UPDATE security_tokens SET used_at=? WHERE hash=?').run(Date.now(),row.hash);
  });
  if(params.has('error'))throw httpError(400,'oauth_declined');
  if(!code||code.length>4096)throw httpError(400,'oauth_code_missing');
  const tokenResponse=await fetchImpl('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:config.discordClientId,client_secret:config.discordClientSecret,grant_type:'authorization_code',code,redirect_uri:`${config.origin}/api/auth/discord/callback`}),signal:AbortSignal.timeout(10000)});
  if(!tokenResponse.ok)throw httpError(502,'discord_token_failed');
  const authorization=await tokenResponse.json();
  if(typeof authorization.access_token!=='string')throw httpError(502,'discord_token_invalid');
  const response=await fetchImpl(`${discordBase}/users/@me`,{headers:{Authorization:`Bearer ${authorization.access_token}`},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw httpError(502,'discord_identity_failed');
  const user=await response.json();if(typeof user.id!=='string'||!/^\d{5,25}$/.test(user.id))throw httpError(502,'discord_identity_invalid');
  // Access/refresh tokens are intentionally not persisted.
  return transaction(db,()=>{
    const now=Date.now(),name=String(user.global_name||user.username||'Discord player').slice(0,80);
    const avatar=typeof user.avatar==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(user.avatar)?user.avatar:null;
    db.prepare('INSERT INTO users(id,display_name,avatar,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,last_seen_at=excluded.last_seen_at').run(user.id,name,avatar,now,now);
    const issued=issueSession(db,{userId:user.id,consent:session.telemetry_consent});
    // Preserve ownership of guest games without converting their original identity or eligibility.
    db.prepare('UPDATE matches SET owner_hash=? WHERE owner_hash=? AND user_id IS NULL').run(issued.row.hash,session.hash);
    db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);
    operation(db,'oauth_succeeded',{});return issued;
  });
}
export function redeemContext(db,config,session,value) {
  if(!session?.user_id)throw httpError(401,'discord_login_required');
  let payload;try{payload=verifyLaunch(value,config.launchKey);}catch(e){operation(db,'context_rejected',{reason:e.message});throw httpError(403,e.message);}
  if(payload.sub!==session.user_id)throw httpError(403,'launch_wrong_user');
  const context={guildId:payload.guild_id,channelId:payload.channel_id,userId:payload.sub,establishedAt:Date.now(),expiresAt:Date.now()+3600000,proofHash:hash(value)};
  transaction(db,()=>{
    const t=db.prepare('SELECT * FROM security_tokens WHERE hash=? AND kind=?').get(hash(payload.jti),'launch');
    if(!t||t.used_at||t.expires_at<=Date.now()||t.user_id!==session.user_id)throw httpError(403,'launch_already_used_or_expired');
    db.prepare('UPDATE security_tokens SET used_at=? WHERE hash=?').run(Date.now(),t.hash);
    db.prepare('UPDATE sessions SET context_json=? WHERE hash=?').run(JSON.stringify(context),session.hash);
  });operation(db,'context_redeemed',{});return context;
}
export function handleInteraction(db,config,req,raw) {
  if(!verifyDiscord(raw,req.headers['x-signature-timestamp'],req.headers['x-signature-ed25519'],config.discordPublicKey))throw httpError(401,'discord_signature_rejected');
  let input;try{input=JSON.parse(raw.toString());}catch{throw httpError(400,'invalid_json');}
  if(input.type===1)return {type:1};
  if(input.type!==2||input.data?.name!=='jev'||input.data?.options?.[0]?.name!=='sudoku')throw httpError(400,'unsupported_command');
  if(input.application_id!==config.discordClientId)throw httpError(403,'wrong_application');
  const userId=input.member?.user?.id,guild=input.guild_id,channel=input.channel_id||input.channel?.id;
  if(![userId,guild,channel].every(s=>typeof s==='string'&&/^\d{5,25}$/.test(s)))return {type:4,data:{flags:64,content:'Run /jev sudoku inside a participating server channel.'}};
  const now=Date.now(),jti=token(),payload={v:1,aud:'jev-arcade',sub:userId,guild_id:guild,channel_id:channel,game:'sudoku',iat:now,exp:now+600000,jti};
  transaction(db,()=>{
    if(typeof input.id!=='string'||db.prepare('SELECT 1 FROM security_tokens WHERE hash=?').get(hash(`interaction:${input.id}`)))throw httpError(409,'interaction_replayed');
    db.prepare('INSERT INTO security_tokens(hash,kind,payload_json,expires_at) VALUES(?,?,?,?)').run(hash(`interaction:${input.id}`),'interaction','{}',now+600000);
    db.prepare('INSERT INTO security_tokens(hash,kind,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)').run(hash(jti),'launch',userId,JSON.stringify(payload),payload.exp);
  });
  const launch=signLaunch(payload,config.launchKey);
  // Fragment never reaches HTTP access logs; browser redeems using a POST body.
  const url=`${config.origin}/#launch=${encodeURIComponent(launch)}`;
  operation(db,'discord_launch_issued',{});
  return {type:4,data:{flags:64,content:'Race JEV on the same Sudoku puzzle. This personal link expires in 10 minutes.',components:[{type:1,components:[{type:2,style:5,label:'Play Sudoku vs JEV',url}]}]}};
}
export { sessionCookie };
