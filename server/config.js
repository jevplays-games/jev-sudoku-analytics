import { randomBytes } from 'node:crypto';
export function loadConfig(env=process.env) {
  const int=(key,def,min=0,max=1e9)=>{const n=env[key]===undefined?def:Number(env[key]);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return n;};
  const price=key=>{if(!env[key])return null;const n=Number(env[key]);if(!Number.isFinite(n)||n<0)throw new Error(`Invalid ${key}`);return n;};
  const production=env.NODE_ENV==='production',origin=new URL(env.APP_ORIGIN||'http://localhost:3000').origin;
  if(production&&!origin.startsWith('https://'))throw new Error('APP_ORIGIN must use HTTPS in production');
  if(production&&(!env.LAUNCH_SIGNING_KEY||env.LAUNCH_SIGNING_KEY.length<32))throw new Error('Set a random LAUNCH_SIGNING_KEY of at least 32 characters');
  const discordClientId=env.DISCORD_CLIENT_ID||'';
  return {production,origin,activityOrigin:/^\d{5,25}$/.test(discordClientId)?`https://${discordClientId}.discordsays.com`:null,host:env.HOST||'127.0.0.1',port:int('PORT',3000,0,65535),database:env.DATABASE_PATH||'data/arcade.sqlite',
    launchKey:env.LAUNCH_SIGNING_KEY||randomBytes(32).toString('hex'),discordClientId,discordClientSecret:env.DISCORD_CLIENT_SECRET||'',
    discordPublicKey:env.DISCORD_PUBLIC_KEY||'',jevKey:env.TYPESAFE_API_KEY||'',jevModel:env.JEV_MODEL||'jev-1.13.0',
    jevEndpoint:'https://api.typesafe.ai/v1/systemone',pacingMs:int('PRACTICE_PACING_MS',8000,250,60000),
    maxActive:int('MAX_ACTIVE_MATCHES',20,1,200),maxJevConcurrent:int('MAX_OUTBOUND_JEV_REQUESTS',8,1,100),
    maxRequestsPerMatch:int('MAX_JEV_REQUESTS_PER_MATCH',600,1,10000),maxMatchEvents:int('MAX_MATCH_EVENTS',12000,100,20000),
    timeoutMs:int('JEV_TIMEOUT_MS',2000,100,5000),admins:(env.ADMIN_DISCORD_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),
    analyticsToken:env.ADMIN_ANALYTICS_TOKEN||'',inputUsdPerMillion:price('JEV_INPUT_USD_PER_MILLION'),outputUsdPerMillion:price('JEV_OUTPUT_USD_PER_MILLION'),
    detailedRetentionDays:int('TELEMETRY_RETENTION_DAYS',30,1,3650),operationRetentionDays:int('OPERATIONS_RETENTION_DAYS',30,1,3650)};
}
