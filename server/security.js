import { createHash,createHmac,randomBytes,timingSafeEqual,createPublicKey,verify } from 'node:crypto';
import { canonical,invariant } from '../shared/sudoku.js';
export const token=()=>randomBytes(32).toString('base64url');
export const hash=x=>createHash('sha256').update(typeof x==='string'?x:canonical(x)).digest('hex');
export const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function httpError(status,code) {const e=new Error(code);e.status=status;return e;}
export function signLaunch(payload,key) {
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256',key).update(body).digest('base64url')}`;
}
export function verifyLaunch(value,key,now=Date.now()) {
  invariant(typeof value==='string'&&value.length<4096,'invalid_launch');
  const [body,sig,extra]=value.split('.');invariant(!extra&&body&&sig,'invalid_launch');
  invariant(same(sig,createHmac('sha256',key).update(body).digest('base64url')),'invalid_launch_signature');
  let p;try{p=JSON.parse(Buffer.from(body,'base64url').toString());}catch{throw new Error('invalid_launch');}
  invariant(p.v===1&&p.aud==='jev-arcade'&&p.game==='sudoku','invalid_launch_audience');
  invariant(Number.isSafeInteger(p.exp)&&Number.isSafeInteger(p.iat)&&p.exp>now&&p.iat<=now+30000&&p.exp-p.iat<=600000,'launch_expired');
  invariant([p.sub,p.guild_id,p.channel_id].every(s=>typeof s==='string'&&/^\d{5,25}$/.test(s))&&typeof p.jti==='string','invalid_launch_context');
  return p;
}
export function verifyDiscord(raw,timestamp,signature,publicKey,now=Date.now()) {
  if(!/^\d{10,13}$/.test(timestamp||'') || Math.abs(now-Number(timestamp)*1000)>300000 || !/^[a-f\d]{128}$/i.test(signature||'') || !/^[a-f\d]{64}$/i.test(publicKey||'')) return false;
  try {
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey,'hex')]),type:'spki',format:'der'});
    return verify(null,Buffer.concat([Buffer.from(timestamp),raw]),key,Buffer.from(signature,'hex'));
  } catch{return false;}
}
export function cookies(header='') {
  const out={};for(const part of header.split(';')) {const index=part.indexOf('=');if(index>0) out[part.slice(0,index).trim()]=part.slice(index+1).trim();}return out;
}
export function sessionCookie(raw,secure,maxAge=604800) {return `jev_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`;}
export function issueSession(db,{userId=null,context=null,consent=0,now=Date.now(),ttlMs=7*86400000}={}) {
  const raw=token(),row={hash:hash(raw),user_id:userId,csrf:token(),context_json:context?JSON.stringify(context):null,telemetry_consent:consent,created_at:now,expires_at:now+ttlMs};
  db.prepare('INSERT INTO sessions(hash,user_id,csrf,context_json,telemetry_consent,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(row.hash,row.user_id,row.csrf,row.context_json,row.telemetry_consent,row.created_at,row.expires_at);
  return {raw,row};
}
// Inside a Discord Activity the browser will not send our SameSite cookie, so the game holds the session token in memory
// and presents it as a bearer credential. A bearer that matches no session falls through to the cookie path unchanged.
export function getSession(db,req,now=Date.now()) {
  const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
  if(bearer){const row=db.prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?').get(hash(bearer),now);if(row)return {...row,via:'bearer'};}
  const raw=cookies(req.headers.cookie).jev_session;if(!raw||raw.length>100)return null;
  return db.prepare('SELECT * FROM sessions WHERE hash=? AND expires_at>?').get(hash(raw),now)||null;
}
export function requireCsrf(req,session,origin,activityOrigin=null) {
  // The Activity origin is honoured only for bearer sessions, never for cookie sessions.
  const allowed=req.headers.origin===origin||(session?.via==='bearer'&&!!activityOrigin&&req.headers.origin===activityOrigin);
  if(!session || !allowed || !same(req.headers['x-csrf-token'],session.csrf)) throw httpError(403,'csrf_rejected');
}
export class RateLimiter {
  constructor(maxKeys=10000){this.buckets=new Map();this.maxKeys=maxKeys;}
  allow(key,limit,windowMs,now=Date.now()) {
    let b=this.buckets.get(key);if(!b || b.reset<=now) {b={count:0,reset:now+windowMs};this.buckets.set(key,b);}
    b.count++;
    if(this.buckets.size>this.maxKeys) {for(const [k,v] of this.buckets)if(v.reset<=now)this.buckets.delete(k);if(this.buckets.size>this.maxKeys)this.buckets.delete(this.buckets.keys().next().value);}
    return b.count<=limit;
  }
}
