import { hash,token,httpError,prepareSession,sessionCookie,verifyLaunch,signLaunch,verifyDiscord } from './security.js';
import { one,run,stmt,batch,isConstraint } from './db.js';
import { operation } from './telemetry.js';
import { now,readBody,text } from './util.js';
const discordBase='https://discord.com/api/v10';
export async function startOAuth(env,config,session) {
  if(!config.discordClientId||!config.discordClientSecret)throw httpError(503,'discord_not_configured');
  const state=token();
  await run(env,'INSERT INTO security_tokens(hash,kind,session_hash,payload_json,expires_at) VALUES(?,?,?,?,?)',await hash(state),'oauth',session.hash,'{}',now(env)+600000);
  const url=new URL('https://discord.com/oauth2/authorize');
  url.search=new URLSearchParams({client_id:config.discordClientId,response_type:'code',redirect_uri:`${config.origin}/api/auth/discord/callback`,scope:'identify',state}).toString();
  await operation(env,'oauth_started',{});return url.toString();
}
export async function finishOAuth(env,config,session,params,fetchImpl=(...a)=>fetch(...a)) {
  const state=params.get('state'),code=params.get('code');
  if(!session||!state||state.length>100)throw httpError(403,'oauth_state_rejected');
  // Consuming the state is one conditional UPDATE: it succeeds for exactly one caller, only for the issuing session, only once, only unexpired.
  const consumed=await one(env,'UPDATE security_tokens SET used_at=? WHERE hash=? AND kind=? AND used_at IS NULL AND expires_at>? AND session_hash=? RETURNING hash',now(env),await hash(state),'oauth',now(env),session.hash);
  if(!consumed)throw httpError(403,'oauth_state_rejected');
  if(params.has('error'))throw httpError(400,'oauth_declined');
  if(!code||code.length>4096)throw httpError(400,'oauth_code_missing');
  const {user}=await discordIdentity(config,code,`${config.origin}/api/auth/discord/callback`,fetchImpl);
  const issued=await prepareSession(env,{userId:user.id,consent:session.telemetry_consent});
  await batch(env,[upsertUser(env,user),issued.insert,
    // Preserve ownership of guest games without converting their original identity or eligibility.
    stmt(env,'UPDATE matches SET owner_hash=? WHERE owner_hash=? AND user_id IS NULL',issued.row.hash,session.hash),
    stmt(env,'DELETE FROM sessions WHERE hash=?',session.hash)]);
  await operation(env,'oauth_succeeded',{});return issued;
}
// redirectUri is omitted for an Embedded App SDK authorization code, which Discord issues without one.
export async function discordIdentity(config,code,redirectUri,fetchImpl=(...a)=>fetch(...a)) {
  const form={client_id:config.discordClientId,client_secret:config.discordClientSecret,grant_type:'authorization_code',code};if(redirectUri)form.redirect_uri=redirectUri;
  const tokenResponse=await fetchImpl('https://discord.com/api/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form),signal:AbortSignal.timeout(10000)});
  if(!tokenResponse.ok)throw httpError(502,'discord_token_failed');
  const authorization=await tokenResponse.json();
  if(typeof authorization.access_token!=='string')throw httpError(502,'discord_token_invalid');
  const response=await fetchImpl(`${discordBase}/users/@me`,{headers:{Authorization:`Bearer ${authorization.access_token}`},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw httpError(502,'discord_identity_failed');
  const user=await response.json();if(typeof user.id!=='string'||!/^\d{5,25}$/.test(user.id))throw httpError(502,'discord_identity_invalid');
  // Access/refresh tokens are intentionally not persisted.
  return {user,accessToken:authorization.access_token};
}
function upsertUser(env,user) {
  const at=now(env),name=String(user.global_name||user.username||'Discord player').slice(0,80);
  const avatar=typeof user.avatar==='string'&&/^[a-zA-Z0-9_]{1,100}$/.test(user.avatar)?user.avatar:null;
  return stmt(env,'INSERT INTO users(id,display_name,avatar,created_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,avatar=excluded.avatar,last_seen_at=excluded.last_seen_at',user.id,name,avatar,at,at);
}
export function activityConfig(config) {
  if(!config.discordClientId||!config.discordClientSecret)throw httpError(503,'discord_not_configured');
  return {clientId:config.discordClientId};
}
// Discord Activity sign-in: an SDK authorization code becomes a bearer session. The raw token is returned once and only its hash is stored.
export async function activitySession(env,config,origin,code,fetchImpl=(...a)=>fetch(...a)) {
  if(!config.discordClientId||!config.discordClientSecret)throw httpError(503,'discord_not_configured');
  if(!origin||(origin!==config.origin&&origin!==config.activityOrigin))throw httpError(403,'origin_rejected');
  if(typeof code!=='string'||!code||code.length>4096)throw httpError(400,'oauth_code_missing');
  const {user,accessToken}=await discordIdentity(config,code,null,fetchImpl);
  const issued=await prepareSession(env,{userId:user.id,ttlMs:86400000});
  await batch(env,[upsertUser(env,user),issued.insert]);
  await operation(env,'activity_session_issued',{});
  return {token:issued.raw,csrf:issued.row.csrf,accessToken,user:{id:user.id,display_name:String(user.global_name||user.username||'Discord player').slice(0,80)}};
}
export async function redeemContext(env,config,session,value) {
  if(!session?.user_id)throw httpError(401,'discord_login_required');
  let payload;try{payload=await verifyLaunch(value,config.launchKey,now(env));}catch(e){await operation(env,'context_rejected',{reason:e.message});throw httpError(403,e.message);}
  if(payload.sub!==session.user_id)throw httpError(403,'launch_wrong_user');
  const at=now(env),context={guildId:payload.guild_id,channelId:payload.channel_id,userId:payload.sub,establishedAt:at,expiresAt:at+3600000,proofHash:await hash(value)};
  // One conditional UPDATE consumes the single-use launch token.
  const consumed=await one(env,"UPDATE security_tokens SET used_at=? WHERE hash=? AND kind='launch' AND used_at IS NULL AND expires_at>? AND user_id=? RETURNING hash",at,await hash(payload.jti),at,session.user_id);
  if(!consumed)throw httpError(403,'launch_already_used_or_expired');
  await run(env,'UPDATE sessions SET context_json=? WHERE hash=?',JSON.stringify(context),session.hash);
  await operation(env,'context_redeemed',{});return context;
}
export async function handleInteraction(env,config,request,raw) {
  if(!await verifyDiscord(raw,request.headers.get('x-signature-timestamp'),request.headers.get('x-signature-ed25519'),config.discordPublicKey,now(env)))throw httpError(401,'discord_signature_rejected');
  let input;try{input=JSON.parse(text(raw));}catch{throw httpError(400,'invalid_json');}
  if(input.type===1)return {type:1};
  if(input.type!==2||input.data?.name!=='jev'||input.data?.options?.[0]?.name!=='sudoku')throw httpError(400,'unsupported_command');
  if(input.application_id!==config.discordClientId)throw httpError(403,'wrong_application');
  const userId=input.member?.user?.id,guild=input.guild_id,channel=input.channel_id||input.channel?.id;
  if(![userId,guild,channel].every(s=>typeof s==='string'&&/^\d{5,25}$/.test(s)))return {type:4,data:{flags:64,content:'Run /jev sudoku inside a participating server channel.'}};
  const at=now(env),jti=token(),payload={v:1,aud:'jev-arcade',sub:userId,guild_id:guild,channel_id:channel,game:'sudoku',iat:at,exp:at+600000,jti};
  if(typeof input.id!=='string')throw httpError(409,'interaction_replayed');
  try{
    // The interaction id is the primary key of a token row, so a replay fails atomically instead of racing a read-then-write.
    await batch(env,[stmt(env,'INSERT INTO security_tokens(hash,kind,payload_json,expires_at) VALUES(?,?,?,?)',await hash(`interaction:${input.id}`),'interaction','{}',at+600000),
      stmt(env,'INSERT INTO security_tokens(hash,kind,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)',await hash(jti),'launch',userId,JSON.stringify(payload),payload.exp)]);
  }catch(e){if(isConstraint(e))throw httpError(409,'interaction_replayed');throw e;}
  const launch=await signLaunch(payload,config.launchKey);
  // Fragment never reaches HTTP access logs; browser redeems using a POST body.
  const url=`${config.origin}/#launch=${encodeURIComponent(launch)}`;
  await operation(env,'discord_launch_issued',{});
  return {type:4,data:{flags:64,content:'Race JEV on the same Sudoku puzzle. This personal link expires in 10 minutes.',components:[{type:1,components:[{type:2,style:5,label:'Play Sudoku vs JEV',url}]}]}};
}
export { sessionCookie,readBody };
