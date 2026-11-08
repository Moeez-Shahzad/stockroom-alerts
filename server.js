import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { openStore, addRequest, acceptEvent, adminOverview, manualRetry, closeStore } from './store.js';
import { startWorker } from './worker.js';
import { fetchCatalogue } from './provider.js';
import { normalizeEmail, normalizeSku } from './utils.js';

const basedir = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(basedir, '.env'))) process.loadEnvFile(join(basedir, '.env'));
const required = ['STOCK_API_URL', 'STOCK_API_KEY', 'RESEND_API_KEY', 'RESEND_BASE_URL', 'WEBHOOK_SECRET', 'ADMIN_PASSWORD'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) { console.error(`Missing environment variables: ${missing.join(', ')}`); process.exit(1); }
const config = Object.fromEntries(required.map(k => [k, process.env[k]]));
for (const key of ['STOCK_API_URL', 'RESEND_BASE_URL']) {
  try { const u = new URL(config[key]); if (!['http:', 'https:'].includes(u.protocol)) throw Error(); }
  catch { console.error(`Invalid ${key}`); process.exit(1); }
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('PORT must be 0–65535'); process.exit(1); }
const dataDir = process.env.DATA_DIR || join(basedir, 'data');
openStore(dataDir);
const worker = startWorker(config);
const blockedLogins = new Map();
const secret = createHash('sha256').update(`stockroom-auth:${config.ADMIN_PASSWORD}`).digest();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const assets = new Map([
  ['/embed', 'embed.html'], ['/admin', 'admin.html'], ['/admin/login', 'login.html'],
  ['/styles.css', 'styles.css'], ['/embed.js', 'embed.js'], ['/admin.js', 'admin.js'],
  ['/login.js', 'login.js'], ['/favicon.svg', 'favicon.svg']
]);
function respond(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}
function json(res, status, object) { respond(res, status, object); }
function redirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers }); res.end();
}
function secureEquals(a, b) {
  const x = createHash('sha256').update(String(a)).digest();
  const y = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(x, y);
}
function sessionCookie(req, token, maxAge = 7 * 86400) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `stockroom_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function newSession() {
  const timestamp = Date.now() + 7 * 86400000;
  const payload = `v1.${timestamp}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}
function loggedIn(req) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('stockroom_session='));
  if (!raw) return false;
  let token;
  try { token = decodeURIComponent(raw.split('=').slice(1).join('=')); } catch { return false; }
  const matched = /^v1\.(\d+)\.([a-f0-9]{64})$/.exec(token);
  if (!matched || Number(matched[1]) <= Date.now()) return false;
  const check = createHmac('sha256', secret).update(`v1.${matched[1]}`).digest('hex');
  return secureEquals(check, matched[2]);
}
async function parseBody(req, maxBytes = 12_000) {
  const chunks = [];
  let count = 0;
  for await (const c of req) {
    count += c.length;
    if (count > maxBytes) { const e = new Error('Request body too large'); e.status = 413; throw e; }
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { const e = new Error('Invalid JSON body'); e.status = 400; throw e; }
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function serveAsset(req, res, pathname) {
  const filename = assets.get(pathname);
  if (!filename) return false;
  const extension = filename.slice(filename.lastIndexOf('.'));
  let content = await readFile(join(basedir, 'public', filename));
  respond(res, 200, content, mime[extension] || 'application/octet-stream',
    pathname === '/embed' ? { 'Content-Security-Policy': "default-src 'self'; frame-ancestors *; object-src 'none'; base-uri 'none'" } : {});
  return true;
}
const server = http.createServer(async (req, res) => {
  // The embed is intentionally iframe-compatible; admin pages are not.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
    if (path === '/' && req.method === 'GET') return redirect(res, '/embed');
    if (path === '/api/requests' && req.method === 'POST') {
      const body = await parseBody(req);
      const email = normalizeEmail(body?.email);
      const sku = normalizeSku(body?.sku);
      if (!email || !sku) return json(res, 400, { error: 'Enter a valid email and product SKU.' });
      const result = addRequest(email, sku);
      return json(res, result.duplicate ? 200 : 201, {
        ok: true, duplicate: result.duplicate,
        message: result.duplicate ? 'You are already on the list for this item.' : 'You are on the list. We will email you when it is back.',
        request: { id: result.request.id, sku: result.request.sku, status: result.request.status }
      });
    }
    if (path === '/api/catalogue' && req.method === 'GET') {
      try { return json(res, 200, { products: await fetchCatalogue(config) }); }
      catch (e) { console.warn(`[catalogue] ${e.message}`); return json(res, 503, { error: 'Product catalogue temporarily unavailable.' }); }
    }
    if (path === '/webhooks/stock' && req.method === 'POST') {
      const supplied = req.headers['x-webhook-secret'];
      if (typeof supplied !== 'string' || !secureEquals(supplied, config.WEBHOOK_SECRET))
        return json(res, 401, { error: 'Unauthorized webhook' });
      const body = await parseBody(req);
      const eventId = typeof body?.event_id === 'string' ? body.event_id.trim() : '';
      const sku = normalizeSku(body?.sku);
      if (!sku || !eventId || eventId.length > 160) return json(res, 400, { error: 'Invalid event_id or SKU' });
      // Do not trust quantity, in_stock, or any other stock claim in the webhook.
      const accepted = acceptEvent(eventId, sku);
      if (accepted) worker.wake();
      return json(res, accepted ? 202 : 200, { ok: true, duplicate: !accepted });
    }
    if (path === '/admin/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      const ip = req.socket.remoteAddress || 'unknown';
      const entry = blockedLogins.get(ip);
      if (entry && entry.until > Date.now()) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const body = await parseBody(req);
      if (typeof body?.password !== 'string' || !secureEquals(body.password, config.ADMIN_PASSWORD)) {
        const failures = (entry?.failures || 0) + 1;
        blockedLogins.set(ip, { failures, until: failures >= 6 ? Date.now() + 300000 : 0 });
        return json(res, 401, { error: 'Incorrect password.' });
      }
      blockedLogins.delete(ip);
      res.setHeader('Set-Cookie', sessionCookie(req, newSession()));
      return json(res, 200, { ok: true });
    }
    if (path === '/admin/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return json(res, 200, { ok: true });
    }
    if (path === '/api/admin/overview' && req.method === 'GET') {
      if (!loggedIn(req)) return json(res, 401, { error: 'Not authenticated' });
      const filter = ['all', 'open', 'queued', 'notified'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'all';
      const q = (url.searchParams.get('q') || '').slice(0, 80);
      const page = Math.max(1, Math.min(1000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
      return json(res, 200, adminOverview({ filter, q, page }));
    }
    const retry = /^\/api\/admin\/retry\/([0-9a-f-]{36})$/.exec(path);
    if (retry && req.method === 'POST') {
      if (!loggedIn(req)) return json(res, 401, { error: 'Not authenticated' });
      if (!sameOrigin(req)) return json(res, 403, { error: 'Invalid origin' });
      const updated = manualRetry(retry[1]);
      if (updated) worker.wake();
      return json(res, updated ? 200 : 404, { ok: updated });
    }
    if (path === '/admin' && req.method === 'GET') {
      if (!loggedIn(req)) return redirect(res, '/admin/login');
      return void await serveAsset(req, res, '/admin');
    }
    if (path === '/admin/login' && req.method === 'GET') {
      if (loggedIn(req)) return redirect(res, '/admin');
      return void await serveAsset(req, res, path);
    }
    if (path === '/embed' && req.method === 'GET') {
      res.removeHeader('X-Frame-Options');
      return void await serveAsset(req, res, path);
    }
    if (req.method === 'GET' && assets.has(path)) return void await serveAsset(req, res, path);
    return json(res, 404, { error: 'Route not found' });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error('[server]', error);
    if (!res.headersSent) return json(res, status, { error: status >= 500 ? 'Internal server error' : error.message });
    res.end();
  }
});
server.listen(port, '0.0.0.0', () => console.log(`Stockroom listening on http://0.0.0.0:${server.address().port}`));
process.on('SIGTERM', () => { worker.stop(); server.close(() => { closeStore(); process.exit(0); }); });
process.on('SIGINT', () => { worker.stop(); server.close(() => { closeStore(); process.exit(0); }); });
