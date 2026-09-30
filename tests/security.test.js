import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { environment, insertMatch, user as userSession } from './helpers.js';
import { issueSession, hash, signLaunch, verifyLaunch, verifyDiscord, requireCsrf, RateLimiter } from '../server/security.js';
import { startOAuth, finishOAuth, redeemContext, handleInteraction } from '../server/auth.js';
import { same } from '../server/util.js';
const now = Date.now(), config = { origin: 'http://localhost:3000', discordClientId: '1234567890', discordClientSecret: 'secret', launchKey: 'a'.repeat(64), production: false };
const payload = { v: 1, aud: 'jev-arcade', sub: '9876543210', guild_id: '5555555555', channel_id: '6666666666', game: 'sudoku', iat: now, exp: now + 600000, jti: 'one-time-nonce' };
const enc = s => new TextEncoder().encode(s);
const publicKeyHex = keys => keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const csrfRequest = (origin, token) => new Request('http://localhost:3000/api/x', { method: 'POST', headers: { ...(origin ? { origin } : {}), ...(token ? { 'x-csrf-token': token } : {}) } });
test('signed launch rejects modification, expiration and wrong audience', async () => {
  const signed = await signLaunch(payload, config.launchKey);
  assert.equal((await verifyLaunch(signed, config.launchKey, now)).sub, payload.sub);
  await assert.rejects(verifyLaunch(signed.slice(0, -1) + '!', config.launchKey, now), /signature/);
  await assert.rejects(verifyLaunch(signed, config.launchKey, now + 600001), /expired/);
  await assert.rejects(verifyLaunch(await signLaunch({ ...payload, aud: 'wrong' }, config.launchKey), config.launchKey, now), /audience/);
  await assert.rejects(verifyLaunch(signed, 'b'.repeat(64), now), /signature/);
});
test('launch signature is byte-compatible with the container-era format (base64url body, HMAC-SHA256)', async () => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(await signLaunch(payload, config.launchKey), `${body}.${createHmac('sha256', config.launchKey).update(body).digest('base64url')}`);
});
test('Discord Ed25519 verification (Web Crypto) binds timestamp and raw request bytes', async () => {
  const keys = generateKeyPairSync('ed25519'), raw = enc('{"type":1}'), timestamp = String(Math.floor(now / 1000)), publicKey = publicKeyHex(keys);
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]), keys.privateKey).toString('hex');
  assert.equal(await verifyDiscord(raw, timestamp, signature, publicKey, now), true);
  assert.equal(await verifyDiscord(enc('changed'), timestamp, signature, publicKey, now), false);
  assert.equal(await verifyDiscord(raw, timestamp, signature, publicKey, now + 400000), false);
  assert.equal(await verifyDiscord(raw, timestamp, signature, 'not-a-key', now), false);
  assert.equal(await verifyDiscord(raw, timestamp, 'ab'.repeat(64), publicKey, now), false);
});
test('CSRF requires origin and session-bound token; the activity origin only counts for bearer sessions', () => {
  const session = { csrf: 'a'.repeat(32) };
  assert.doesNotThrow(() => requireCsrf(csrfRequest(config.origin, session.csrf), session, config.origin));
  assert.throws(() => requireCsrf(csrfRequest('https://evil.test', session.csrf), session, config.origin), /csrf/);
  assert.throws(() => requireCsrf(csrfRequest(config.origin, 'wrong'), session, config.origin), /csrf/);
  assert.throws(() => requireCsrf(csrfRequest(undefined, session.csrf), session, config.origin), /csrf/);
  const activity = 'https://123456789012345678.discordsays.com';
  assert.throws(() => requireCsrf(csrfRequest(activity, session.csrf), session, config.origin, activity), /csrf/);
  assert.doesNotThrow(() => requireCsrf(csrfRequest(activity, session.csrf), { ...session, via: 'bearer' }, config.origin, activity));
});
test('constant-time comparison rejects length differences and non-strings', () => {
  assert.equal(same('abc', 'abc'), true);
  assert.equal(same('abc', 'abd'), false);
  assert.equal(same('abc', 'abcd'), false);
  assert.equal(same(undefined, 'abc'), false);
});
test('rate limiter expires windows and bounds memory', () => {
  const r = new RateLimiter(3);
  assert.equal(r.allow('a', 1, 100, 0), true); assert.equal(r.allow('a', 1, 100, 1), false); assert.equal(r.allow('a', 1, 100, 101), true);
  for (let i = 0; i < 20; i++) r.allow('key' + i, 1, 100, 1);
  assert.ok(r.buckets.size <= 3);
});
test('OAuth state, successful identity, rotated session and no token persistence', async () => {
  const env = environment(), original = (await issueSession(env)).row;
  const url = new URL(await startOAuth(env, config, original)); assert.equal(url.searchParams.get('scope'), 'identify');
  const state = url.searchParams.get('state'); let calls = 0;
  const fakeFetch = async () => { calls++; return Response.json(calls === 1 ? { access_token: 'do-not-store', refresh_token: 'do-not-store-refresh' } : { id: '9876543210', username: 'name', global_name: 'Display <script>', avatar: null }); };
  const issued = await finishOAuth(env, config, original, new URLSearchParams({ state, code: 'code' }), fakeFetch);
  assert.notEqual(issued.row.hash, original.hash); assert.equal(issued.row.user_id, '9876543210');
  assert.equal(await env.DB.prepare('SELECT 1 AS x FROM sessions WHERE hash=?').bind(original.hash).first(), null);
  assert.equal(JSON.stringify((await env.DB.prepare('SELECT * FROM security_tokens').all()).results).includes('do-not-store'), false);
  await assert.rejects(finishOAuth(env, config, original, new URLSearchParams({ state, code: 'again' }), fakeFetch), /state_rejected/);
});
test('OAuth adoption keeps a guest match with the player without changing its eligibility', async () => {
  const env = environment(), original = (await issueSession(env)).row, id = await insertMatch(env, original);
  const state = new URL(await startOAuth(env, config, original)).searchParams.get('state');
  const fakeFetch = async u => Response.json(String(u).endsWith('/token') ? { access_token: 'x' } : { id: '9876543210', username: 'name' });
  const issued = await finishOAuth(env, config, original, new URLSearchParams({ state, code: 'code' }), fakeFetch);
  const row = await env.DB.prepare('SELECT owner_hash,user_id,official FROM matches WHERE id=?').bind(id).first();
  assert.equal(row.owner_hash, issued.row.hash); assert.equal(row.user_id, null); assert.equal(row.official, 0);
});
test('wrong-session or expired OAuth state is rejected before network access', async () => {
  const env = environment(), a = (await issueSession(env)).row, b = (await issueSession(env)).row;
  const params = new URLSearchParams({ state: new URL(await startOAuth(env, config, a)).searchParams.get('state'), code: 'test' });
  await assert.rejects(finishOAuth(env, config, b, params, () => { throw new Error('must not call'); }), /state/);
  await env.DB.prepare('UPDATE security_tokens SET expires_at=0').run();
  await assert.rejects(finishOAuth(env, config, a, params), /state/);
});
test('launch redemption is subject-bound, expiring and one-use', async () => {
  const env = environment(), s = await userSession(env), other = await userSession(env, '1111111111');
  await env.DB.prepare('INSERT INTO security_tokens(hash,kind,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)').bind(await hash(payload.jti), 'launch', payload.sub, '{}', payload.exp).run();
  const signed = await signLaunch(payload, config.launchKey);
  await assert.rejects(redeemContext(env, config, other, signed), /wrong_user/);
  const context = await redeemContext(env, config, s, signed);
  assert.equal(context.guildId, payload.guild_id); assert.equal(context.channelId, payload.channel_id);
  await assert.rejects(redeemContext(env, config, s, signed), /already_used/);
});
test('signed Discord command returns user-bound fragment link and rejects replay', async () => {
  const env = environment(), keys = generateKeyPairSync('ed25519'), cfg = { ...config, discordPublicKey: publicKeyHex(keys) };
  const input = { id: '123123123123', application_id: config.discordClientId, type: 2, data: { name: 'jev', options: [{ name: 'sudoku', type: 1 }] }, member: { user: { id: payload.sub } }, guild_id: payload.guild_id, channel_id: payload.channel_id };
  const raw = enc(JSON.stringify(input)), ts = String(Math.floor(Date.now() / 1000)), sig = sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(raw)]), keys.privateKey).toString('hex');
  const request = () => new Request('http://localhost:3000/api/discord/interactions', { method: 'POST', headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': sig } });
  const result = await handleInteraction(env, cfg, request(), raw);
  assert.equal(result.data.flags, 64);
  const url = new URL(result.data.components[0].components[0].url); assert.equal(url.search, '');
  const token = new URLSearchParams(url.hash.slice(1)).get('launch'); assert.equal((await verifyLaunch(token, cfg.launchKey)).sub, payload.sub);
  await assert.rejects(handleInteraction(env, cfg, request(), raw), /replayed/);
  await assert.rejects(handleInteraction(env, cfg, request(), enc('{"type":1}')), /signature/);
  const ping = enc('{"type":1}'), pingSig = sign(null, Buffer.concat([Buffer.from(ts), Buffer.from(ping)]), keys.privateKey).toString('hex');
  assert.deepEqual(await handleInteraction(env, cfg, new Request('http://x', { method: 'POST', headers: { 'x-signature-timestamp': ts, 'x-signature-ed25519': pingSig } }), ping), { type: 1 });
});
