import { hash, hmac, b64url, fromB64url, utf8, text, hexBytes, same, token, httpError, now } from './util.js';
import { invariant } from '../public/shared/sudoku.js';
import { one } from './db.js';
export { same, token, hash, httpError };
export async function signLaunch(payload, key) {
  const body = b64url(utf8(JSON.stringify(payload)));
  return `${body}.${b64url(await hmac(key, body))}`;
}
export async function verifyLaunch(value, key, at = Date.now()) {
  invariant(typeof value === 'string' && value.length < 4096, 'invalid_launch');
  const [body, sig, extra] = value.split('.'); invariant(!extra && body && sig, 'invalid_launch');
  invariant(same(sig, b64url(await hmac(key, body))), 'invalid_launch_signature');
  let p; try { p = JSON.parse(text(fromB64url(body))); } catch { throw new Error('invalid_launch'); }
  invariant(p.v === 1 && p.aud === 'jev-arcade' && p.game === 'sudoku', 'invalid_launch_audience');
  invariant(Number.isSafeInteger(p.exp) && Number.isSafeInteger(p.iat) && p.exp > at && p.iat <= at + 30000 && p.exp - p.iat <= 600000, 'launch_expired');
  invariant([p.sub, p.guild_id, p.channel_id].every(s => typeof s === 'string' && /^\d{5,25}$/.test(s)) && typeof p.jti === 'string', 'invalid_launch_context');
  return p;
}
/** Discord interaction signature: Ed25519 over timestamp + raw body, verified with Web Crypto. */
export async function verifyDiscord(raw, timestamp, signature, publicKey, at = Date.now()) {
  if (!/^\d{10,13}$/.test(timestamp || '') || Math.abs(at - Number(timestamp) * 1000) > 300000 || !/^[a-f\d]{128}$/i.test(signature || '') || !/^[a-f\d]{64}$/i.test(publicKey || '')) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    const prefix = utf8(timestamp), message = new Uint8Array(prefix.length + raw.length); message.set(prefix); message.set(raw, prefix.length);
    return await crypto.subtle.verify('Ed25519', key, hexBytes(signature), message);
  } catch { return false; }
}
export function cookies(header = '') {
  const out = {}; for (const part of header.split(';')) { const index = part.indexOf('='); if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim(); } return out;
}
export const sessionCookie = (raw, secure, maxAge = 604800) => `jev_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export async function prepareSession(env, { userId = null, context = null, consent = 0, ttlMs = 7 * 86400000, at = now(env) } = {}) {
  const raw = token(), row = { hash: await hash(raw), user_id: userId, csrf: token(), context_json: context ? JSON.stringify(context) : null, telemetry_consent: consent, created_at: at, expires_at: at + ttlMs };
  const insert = env.DB.prepare('INSERT INTO sessions(hash,user_id,csrf,context_json,telemetry_consent,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(row.hash, row.user_id, row.csrf, row.context_json, row.telemetry_consent, row.created_at, row.expires_at);
  return { raw, row, insert };
}
export async function issueSession(env, options) { const s = await prepareSession(env, options); await s.insert.run(); return { raw: s.raw, row: s.row }; }
// Inside a Discord Activity the browser will not send our SameSite cookie, so the game holds the session token in memory
// and presents it as a bearer credential. A bearer that matches no session falls through to the cookie path unchanged.
export async function getSession(env, request, at = now(env)) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '')?.[1];
  if (bearer) { const row = await one(env, 'SELECT * FROM sessions WHERE hash=? AND expires_at>?', await hash(bearer), at); if (row) return { ...row, via: 'bearer' }; }
  const raw = cookies(request.headers.get('cookie') || '').jev_session; if (!raw || raw.length > 100) return null;
  return (await one(env, 'SELECT * FROM sessions WHERE hash=? AND expires_at>?', await hash(raw), at)) || null;
}
export function requireCsrf(request, session, origin, activityOrigin = null) {
  // The Activity origin is honoured only for bearer sessions, never for cookie sessions.
  const requestOrigin = request.headers.get('origin');
  const allowed = requestOrigin === origin || (session?.via === 'bearer' && !!activityOrigin && requestOrigin === activityOrigin);
  if (!session || !allowed || !same(request.headers.get('x-csrf-token'), session.csrf)) throw httpError(403, 'csrf_rejected');
}
/**
 * Per-isolate, in-memory limiter. It is a best-effort brake on cheap reads only: an isolate can be evicted or duplicated at any
 * time. Anything that spends money or writes durable state uses the D1-backed reserve()/quota() in db.js instead.
 */
export class RateLimiter {
  constructor(maxKeys = 10000) { this.buckets = new Map(); this.maxKeys = maxKeys; }
  allow(key, limit, windowMs, at = Date.now()) {
    let b = this.buckets.get(key); if (!b || b.reset <= at) { b = { count: 0, reset: at + windowMs }; this.buckets.set(key, b); }
    b.count++;
    if (this.buckets.size > this.maxKeys) { for (const [k, v] of this.buckets) if (v.reset <= at) this.buckets.delete(k); if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value); }
    return b.count <= limit;
  }
}
