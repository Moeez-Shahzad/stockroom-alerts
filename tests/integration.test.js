import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const readJson = async req => {
  let raw = ''; for await (const c of req) raw += c; return JSON.parse(raw || '{}');
};
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function eventually(check, message, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(120);
  }
  assert.fail(message);
}
async function call(url, method = 'GET', body, headers = {}) {
  return fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
function mockHarness(state) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname.startsWith('/api/stock')) {
      if (req.headers.authorization !== 'Bearer fake-stock-key') return send(401, { error: 'invalid key' });
      state.stockCalls++;
      const sku = decodeURIComponent(url.pathname.slice('/api/stock/'.length));
      if (url.pathname === '/api/stock') return send(200, { products: [{ sku: 'TEE-1', name: 'Everyday Tee', quantity: state.quantity }, { sku: 'BAG-1', name: 'Canvas Bag', quantity: 0 }] });
      if (sku !== 'TEE-1') return send(404, { error: 'not found' });
      return send(200, { sku, name: 'Everyday Tee', quantity: state.quantity, in_stock: state.quantity > 0 });
    }
    if (url.pathname === '/emails' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer fake-email-key') return send(401, { error: 'invalid key' });
      const email = await readJson(req);
      assert.match(email.html, /width="100%"/);
      assert.equal(email.from.includes('Stockroom'), true);
      state.attempts++;
      if (state.failNext > 0) { state.failNext--; return send(500, { message: 'injected provider outage' }); }
      const key = req.headers['idempotency-key'];
      assert.ok(key?.startsWith('restock-'));
      if (!state.ids.has(key)) { state.ids.add(key); state.emails.push(email); }
      if (state.delayNextResponseMs) {
        const ms = state.delayNextResponseMs; state.delayNextResponseMs = 0;
        await delay(ms); // simulate a provider acceptance followed by a lost HTTP response
      }
      return send(200, { id: `email-${state.ids.size}` });
    }
    return send(404, { error: 'unknown route' });
  });
}
function startApp(harnessPort, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, STOCK_API_URL: `http://127.0.0.1:${harnessPort}/api/stock`,
        STOCK_API_KEY: 'fake-stock-key', RESEND_API_KEY: 'fake-email-key',
        RESEND_BASE_URL: `http://127.0.0.1:${harnessPort}`, WEBHOOK_SECRET: 'fake-secret', ADMIN_PASSWORD: 'very-strong-admin-pass' }
    });
    let output = '';
    const timeout = setTimeout(() => reject(new Error('app did not start ' + output)), 6000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve({ child, base: `http://127.0.0.1:${match[1]}` }); }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`app exited early: ${code} ${output}`)); });
  });
}
async function stopApp(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3500).unref(); });
}
test('webhook security, verified stock, concurrent dedupe, retry, admin and restart durability', { timeout: 35000 }, async () => {
  const folder = mkdtempSync(join(os.tmpdir(), 'stockroom-test-'));
  const state = { quantity: 0, stockCalls: 0, attempts: 0, failNext: 1, ids: new Set(), emails: [] };
  const mock = mockHarness(state);
  const hp = await listen(mock);
  let app;
  try {
    app = await startApp(hp, folder);
    let { base } = app;
    let r = await call(base + '/health'); assert.equal(r.status, 200);
    r = await call(base + '/embed'); assert.equal(r.status, 200); assert.equal(r.headers.get('x-frame-options'), null);
    assert.match(await r.text(), /Notify me when available/);
    r = await call(base + '/admin'); assert.equal(r.status, 200); assert.match(r.url, /\/admin\/login$/);
    r = await call(base + '/api/admin/overview'); assert.equal(r.status, 401);
    r = await call(base + '/api/requests', 'POST', { email: 'TEST@Email.COM', sku: 'tee-1' }); assert.equal(r.status, 201);
    r = await call(base + '/api/requests', 'POST', { email: 'test@email.com', sku: 'TEE-1' }); assert.equal(r.status, 200); assert.equal((await r.json()).duplicate, true);
    r = await call(base + '/api/requests', 'POST', { email: 'oops', sku: 'TEE-1' }); assert.equal(r.status, 400);
    r = await call(base + '/webhooks/stock', 'POST', { event_id: 'event-1', sku: 'TEE-1', quantity: 500 }, { 'X-Webhook-Secret': 'wrong' }); assert.equal(r.status, 401);
    r = await call(base + '/webhooks/stock', 'POST', { event_id: 'event-1', sku: 'TEE-1', quantity: 500 }, { 'X-Webhook-Secret': 'fake-secret' }); assert.equal(r.status, 202);
    await eventually(() => state.stockCalls > 0, 'should query stock API');
    await delay(400);
    assert.equal(state.emails.length, 0, 'false webhook quantity must not send email');
    state.quantity = 4;
    const pair = await Promise.all([1, 2].map(() => call(base + '/webhooks/stock', 'POST', { event_id: 'event-2', sku: 'TEE-1', quantity: 1 }, { 'X-Webhook-Secret': 'fake-secret' })));
    assert.deepEqual(pair.map(r => r.status).sort(), [200, 202]);
    await eventually(() => state.emails.length === 1, 'must deliver after injected 500 and retry');
    assert.equal(state.emails[0].to[0], 'test@email.com');
    assert.equal(state.attempts, 2);
    await delay(400);
    assert.equal(state.emails.length, 1);
    r = await call(base + '/admin/login', 'POST', { password: 'wrong' }); assert.equal(r.status, 401);
    r = await call(base + '/admin/login', 'POST', { password: 'very-strong-admin-pass' }); assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    r = await call(base + '/api/admin/overview', 'GET', undefined, { Cookie: cookie }); assert.equal(r.status, 200);
    const overview = await r.json();
    assert.equal(overview.counts.total, 1);
    assert.equal(overview.counts.notified, 1);
    assert.ok(overview.rows[0].notified_at);
    r = await call(base + '/admin', 'GET', undefined, { Cookie: cookie }); assert.equal(r.status, 200); assert.match(await r.text(), /Stock alert requests/);
    await stopApp(app.child); app = await startApp(hp, folder); base = app.base;
    r = await call(base + '/admin/login', 'POST', { password: 'very-strong-admin-pass' }); assert.equal(r.status, 200);
    r = await call(base + '/api/admin/overview', 'GET', undefined, { Cookie: r.headers.get('set-cookie').split(';')[0] });
    assert.equal((await r.json()).counts.notified, 1, 'restart must preserve SQLite data');
    r = await call(base + '/webhooks/stock', 'POST', { event_id: 'event-2', sku: 'TEE-1', quantity: 100 }, { 'X-Webhook-Secret': 'fake-secret' });
    assert.equal((await r.json()).duplicate, true);
    await delay(1000);
    assert.equal(state.emails.length, 1, 'replayed event after restart must not redeliver');
    r = await call(base + '/api/catalogue'); assert.equal(r.status, 200); assert.equal((await r.json()).products.length, 2);
    // Crash after provider accepted an email but before its HTTP reply reaches us.
    // Resend's stable idempotency key prevents a second accepted email on recovery.
    state.delayNextResponseMs = 4000;
    r = await call(base + '/api/requests', 'POST', { email: 'second@example.com', sku: 'TEE-1' }); assert.equal(r.status, 201);
    r = await call(base + '/webhooks/stock', 'POST', { event_id: 'event-3', sku: 'TEE-1', quantity: 4 }, { 'X-Webhook-Secret': 'fake-secret' }); assert.equal(r.status, 202);
    await eventually(() => state.emails.length === 2, 'provider should accept second email before crash');
    await stopApp(app.child);
    app = await startApp(hp, folder); base = app.base;
    await eventually(async () => {
      const a = await call(base + '/admin/login', 'POST', { password: 'very-strong-admin-pass' });
      const b = await call(base + '/api/admin/overview', 'GET', undefined, { Cookie: a.headers.get('set-cookie').split(';')[0] });
      return (await b.json()).counts.notified === 2;
    }, 'accepted but unacknowledged email should recover after restart');
    assert.equal(state.emails.length, 2, 'provider idempotency must prevent double acceptance after crash');
  } finally {
    if (app) await stopApp(app.child);
    await new Promise(resolve => mock.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});
