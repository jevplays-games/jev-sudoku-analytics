// Configuration is read from the Worker `env` (vars + secrets) and cached per env object. No Node built-ins.
const cache = new WeakMap();
const randomKey = () => [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
export function loadConfig(env) {
  if (env && typeof env === 'object' && cache.has(env)) return cache.get(env);
  const config = buildConfig(env || {});
  if (env && typeof env === 'object') cache.set(env, config);
  return config;
}
function buildConfig(env) {
  const int = (key, def, min = 0, max = 1e9) => { const n = env[key] === undefined || env[key] === '' ? def : Number(env[key]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`); return n; };
  const price = key => { if (!env[key]) return null; const n = Number(env[key]); if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${key}`); return n; };
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:3000').origin, originUrl = new URL(origin);
  const loopback = /^(localhost|127\.|\[::1\]$|0\.0\.0\.0$)/.test(originUrl.hostname) || originUrl.hostname.endsWith('.localhost');
  // A public HTTPS origin means production; a loopback origin is local development. There is no NODE_ENV on Workers.
  const production = env.NODE_ENV === 'production' || (originUrl.protocol === 'https:' && !loopback);
  if (production && !origin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production');
  if (production && (!env.LAUNCH_SIGNING_KEY || env.LAUNCH_SIGNING_KEY.length < 32)) throw new Error('Set a random LAUNCH_SIGNING_KEY of at least 32 characters');
  const discordClientId = env.DISCORD_CLIENT_ID || '';
  return {
    production, origin, activityOrigin: /^\d{5,25}$/.test(discordClientId) ? `https://${discordClientId}.discordsays.com` : null,
    launchKey: env.LAUNCH_SIGNING_KEY || randomKey(), discordClientId, discordClientSecret: env.DISCORD_CLIENT_SECRET || '',
    discordPublicKey: env.DISCORD_PUBLIC_KEY || '', jevKey: env.TYPESAFE_API_KEY || '', jevModel: env.JEV_MODEL || 'jev-1.13.0',
    jevEndpoint: 'https://api.typesafe.ai/v1/systemone', pacingMs: int('PRACTICE_PACING_MS', 8000, 250, 60000),
    maxActive: int('MAX_ACTIVE_MATCHES', 20, 1, 200),
    // Provider-call quota reservations (D1 backed, shared by every isolate). Each attempt, including a retry, reserves one call.
    jevCallsPerDay: int('MAX_JEV_CALLS_PER_DAY', 5000, 0, 1e7), jevCallsPerHour: int('JEV_CALLS_PER_HOUR', 600, 0, 1e6),
    maxRequestsPerMatch: int('MAX_JEV_REQUESTS_PER_MATCH', 600, 1, 10000), maxMatchEvents: int('MAX_MATCH_EVENTS', 12000, 100, 20000),
    timeoutMs: int('JEV_TIMEOUT_MS', 2000, 100, 5000), admins: (env.ADMIN_DISCORD_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
    analyticsToken: env.ADMIN_ANALYTICS_TOKEN || '', inputUsdPerMillion: price('JEV_INPUT_USD_PER_MILLION'), outputUsdPerMillion: price('JEV_OUTPUT_USD_PER_MILLION'),
    detailedRetentionDays: int('TELEMETRY_RETENTION_DAYS', 30, 1, 3650), operationRetentionDays: int('OPERATIONS_RETENTION_DAYS', 30, 1, 3650),
    // No process stays alive between requests, so a player who stops calling the API cannot be raced fairly forever: a running
    // attempt with no request for this long is voided the next time it (or the lazy sweep) is touched.
    abandonedAfterMs: int('ABANDONED_AFTER_MS', 600000, 60000, 3600000),
    // Upper bound on opponent steps applied inside one request, per profile (keeps each request inside the 10 ms Workers Free CPU budget).
    stepBudget: { easy: 6, normal: 3, hard: 1, jev: 1 }, modelStepBudget: 3
  };
}
