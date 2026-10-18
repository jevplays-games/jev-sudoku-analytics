/** Upload a source zip to GoDaddy Node.js Hosting and publish it. Usage: node scripts/godaddy-deploy.js deploy.zip */
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename} from 'node:path';
const base = (process.env.GODADDY_API_BASE || 'https://api.godaddy.com/v1/hosting').replace(/\/$/, '');
const token = process.env.GODADDY_PAT, appId = process.env.GODADDY_APP_ID, zip = process.argv[2];
if (!token || !appId || !zip) { console.error('Set GODADDY_PAT and GODADDY_APP_ID, and pass the source zip path.'); process.exit(2); }
const app = `${base}/apps/${encodeURIComponent(appId)}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function call(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {...init, headers: {Authorization: 'Bearer ' + token, Accept: 'application/json', ...init.headers},
      signal: AbortSignal.timeout(120000)});
    // Idempotency keys make POST retries safe; back off on rate limits and transient outages.
    if ([429, 502, 503, 504].includes(response.status) && attempt < 6) {
      await pause(Math.min(60, Number(response.headers.get('retry-after')) || 5 * attempt) * 1000); continue;
    }
    const text = await response.text(), body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} -> HTTP ${response.status} (request ${response.headers.get('x-request-id') || '?'}): ${body.message || text}`);
    return body;
  }
}
async function settle(label, url, every, limitMs) {
  for (const start = Date.now(); Date.now() - start < limitMs; await pause(every)) {
    const op = await call(url);
    if (op.status === 'COMPLETED') return op;
    if (op.status === 'FAILED') {
      for (const line of op.logs || []) console.error(line);
      throw new Error(`${label} failed: ${op.error?.message || JSON.stringify(op.error)}`);
    }
    console.log(`${label}: ${op.status}`);
  }
  throw new Error(`${label} did not finish within ${limitMs / 60000} minutes.`);
}
const self = op => op.links?.find(l => l.rel === 'self')?.href;
try {
  const form = new FormData();
  form.append('file', new Blob([await readFile(zip)], {type: 'application/zip'}), basename(zip));
  const upload = await call(`${app}/imports`, {method: 'POST', body: form, headers: {'Idempotency-Key': randomUUID()}});
  console.log(`Import ${upload.importId} accepted.`);
  await settle('Import', self(upload) || `${app}/imports/${upload.importId}`, 2000, 10 * 60000);
  const deploy = await call(`${app}/deployments`, {method: 'POST', body: '{}',
    headers: {'Content-Type': 'application/json', 'Idempotency-Key': randomUUID()}});
  console.log(`Deployment ${deploy.deploymentId} accepted.`);
  const done = await settle('Deployment', self(deploy) || `${app}/deployments/${deploy.deploymentId}`, 5000, 20 * 60000);
  const {urls} = await call(app);
  console.log(JSON.stringify({deploymentId: done.deploymentId, gitHash: done.gitHash, publish: urls?.publish, preview: urls?.preview}, null, 2));
} catch (error) { console.error(error.message); process.exit(1); }
