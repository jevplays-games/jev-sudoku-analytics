// Web-API-only helpers shared by every server module. Nothing here touches Node built-ins, so the same code runs in
// Cloudflare Workers and in the local Node adapter (local/server.js).
import { canonical } from '../public/shared/sudoku.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
export class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
export function httpError(status, code) { return new HttpError(status, code); }
export const now = env => (typeof env?.NOW === 'function' ? env.NOW() : Date.now());
export const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
export const hexBytes = value => Uint8Array.from(value.match(/.{2}/g) ?? [], b => parseInt(b, 16));
export function b64url(bytes) {
  let text = ''; for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromB64url(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
export const utf8 = text => encoder.encode(text);
export const text = bytes => decoder.decode(bytes);
export async function sha256(value) { return hex(await crypto.subtle.digest('SHA-256', utf8(typeof value === 'string' ? value : canonical(value)))); }
/** Stable content hash used for state hashes, candidate-set hashes and session/token storage keys. */
export const hash = sha256;
export async function hmac(key, message) {
  const k = await crypto.subtle.importKey('raw', utf8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8(message)));
}
export const token = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
/** Constant-time string comparison. */
export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = utf8(a), y = utf8(b); let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
export async function readBody(request, limit = 65536) {
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  let size = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) { await reader.cancel(); throw httpError(413, 'request_too_large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}
export async function readJson(request, limit = 65536) {
  if (!String(request.headers.get('content-type') || '').startsWith('application/json')) throw httpError(415, 'json_required');
  try {
    const value = JSON.parse(text(await readBody(request, limit)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch (e) { if (e instanceof HttpError) throw e; throw httpError(400, 'invalid_json'); }
}
export const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
