// Thin local adapter: Node's http server -> the Worker's handle(request, env, ctx), with env.DB from local/database.js (node:sqlite
// behind a D1-compatible interface) and env.ASSETS serving ./public. This is the same handler Cloudflare runs.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { handle } from '../server/worker.js';
import { loadConfig } from '../server/config.js';
const root = fileURLToPath(new URL('../', import.meta.url)), publicRoot = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
export function assetsBinding(dir = publicRoot) {
  return { async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    let pathname; try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Bad path', { status: 400 }); }
    const file = resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dir + sep)) return new Response('Not found', { status: 404 });
    try {
      if (!(await stat(file)).isFile()) return new Response('Not found', { status: 404 });
      return new Response(request.method === 'HEAD' ? null : await readFile(file), { headers: { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300' } });
    } catch { return new Response('Not found', { status: 404 }); }
  } };
}
export function createLocalApp(environment = process.env, { databasePath } = {}) {
  const port = Number(environment.PORT ?? 3000);
  const env = { ...environment, APP_ORIGIN: environment.APP_ORIGIN ?? `http://localhost:${port}`, ASSETS: assetsBinding() };
  const config = loadConfig(env); // fails fast on a production-shaped origin without LAUNCH_SIGNING_KEY
  const dbPath = databasePath ?? (environment.DATABASE_PATH || resolve(root, '.data/sudoku.sqlite'));
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  env.DB = openDatabase(dbPath);
  // Behind a trusted TLS-terminating proxy (TRUST_PROXY=1) the client IP is the last X-Forwarded-For hop, which the proxy itself appended.
  const trustProxy = environment.TRUST_PROXY === '1', pending = new Set();
  const ctx = { waitUntil(promise) { const p = Promise.resolve(promise).catch(() => {}); pending.add(p); p.finally(() => pending.delete(p)); } };
  const server = http.createServer(async (req, res) => {
    try {
      // Never trust forwarded headers in the loopback development server.
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !k.toLowerCase().startsWith('cf-') && !k.toLowerCase().startsWith('x-forwarded-')) headers.set(k, Array.isArray(v) ? v.join(',') : v);
      if (trustProxy) { const hop = String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim(); if (hop) headers.set('cf-connecting-ip', hop); }
      const request = new Request(new URL(req.url, config.origin), { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: req, duplex: 'half' } : {}) });
      const response = await handle(request, env, ctx);
      const out = {}; for (const [k, v] of response.headers) if (k !== 'set-cookie') out[k] = v;
      const cookies = response.headers.getSetCookie?.() ?? []; if (cookies.length) out['set-cookie'] = cookies;
      res.writeHead(response.status, out); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!res.headersSent) res.writeHead(500); res.end('Internal error'); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return { server, env, config, ctx, settle: () => Promise.all([...pending]),
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); await Promise.all([...pending]); env.DB.close(); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createLocalApp(), port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? (app.config.production ? '0.0.0.0' : '127.0.0.1');
  app.server.listen(port, host, () => console.log(JSON.stringify({ event: 'server_started', origin: app.config.origin, bind: host, port: app.server.address().port,
    opponent: app.config.jevKey ? 'JEV' : 'local_heuristic', discordConfigured: !!app.config.discordClientId, runtime: 'local-node-d1-shim' })));
  // There is no drain: matches live in the database, and any attempt still running when the process stops is recovered
  // lazily (or voided after ABANDONED_AFTER_MS) exactly as on Cloudflare.
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
}
