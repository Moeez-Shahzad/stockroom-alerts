import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let db;
export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(join(dataDir, 'stockroom.sqlite'), { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      email_key TEXT NOT NULL,
      sku TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','queued','notified')) DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      notified_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS unique_active_request
      ON requests(email_key, sku) WHERE status IN ('open','queued');
    CREATE INDEX IF NOT EXISTS request_lookup ON requests(sku, status);
    CREATE INDEX IF NOT EXISTS request_date ON requests(created_at DESC);
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','processing','done')) DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      locked_until INTEGER,
      last_error TEXT,
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS event_ready ON webhook_events(status, next_attempt_at, locked_until);
    CREATE TABLE IF NOT EXISTS email_jobs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
      status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed')) DEFAULT 'pending',
      idempotency_key TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      locked_until INTEGER,
      last_error TEXT,
      provider_id TEXT,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS email_ready ON email_jobs(status, next_attempt_at, locked_until);
  `);
  // Single-process deployment: after a crash there cannot be a live worker.
  // Immediately reclaim unfinished jobs rather than waiting for lease expiry.
  db.exec("UPDATE webhook_events SET status='pending', locked_until=NULL WHERE status='processing';");
  db.exec("UPDATE email_jobs SET status='pending', locked_until=NULL WHERE status='sending';");
  return db;
}
function sql() { if (!db) throw new Error('database not initialized'); return db; }
function transaction(fn) {
  sql().exec('BEGIN IMMEDIATE');
  try { const result = fn(); sql().exec('COMMIT'); return result; }
  catch (err) { sql().exec('ROLLBACK'); throw err; }
}
export function closeStore() { db?.close(); db = undefined; }
export function addRequest(email, sku) {
  return transaction(() => {
    const now = Date.now();
    const existing = sql().prepare(`SELECT id, email, sku, status, created_at FROM requests
      WHERE email_key=? AND sku=? AND status IN ('open','queued')`).get(email.toLowerCase(), sku);
    if (existing) return { request: existing, duplicate: true };
    const req = { id: randomUUID(), email, sku, status: 'open', created_at: now };
    sql().prepare(`INSERT INTO requests (id,email,email_key,sku,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(req.id, email, email.toLowerCase(), sku, 'open', now, now);
    return { request: req, duplicate: false };
  });
}
export function acceptEvent(eventId, sku) {
  const now = Date.now();
  const result = sql().prepare(`INSERT OR IGNORE INTO webhook_events
    (event_id,sku,status,next_attempt_at,received_at) VALUES (?,?,'pending',?,?)`).run(eventId, sku, now, now);
  return result.changes > 0;
}
export function claimEvent() {
  return transaction(() => {
    const now = Date.now();
    const event = sql().prepare(`SELECT * FROM webhook_events WHERE
      next_attempt_at<=? AND (status='pending' OR (status='processing' AND locked_until<?))
      ORDER BY received_at LIMIT 1`).get(now, now);
    if (!event) return null;
    sql().prepare(`UPDATE webhook_events SET status='processing', attempts=attempts+1,
      locked_until=? WHERE event_id=?`).run(now + 60000, event.event_id);
    return { ...event, attempts: event.attempts + 1 };
  });
}
export function finishEvent(eventId, sku, inStock, createEmail) {
  return transaction(() => {
    let created = 0;
    if (inStock) {
      const requests = sql().prepare(`SELECT id,email,sku FROM requests WHERE sku=? AND status='open'`).all(sku);
      const now = Date.now();
      for (const r of requests) {
        const email = createEmail(r);
        const result = sql().prepare(`INSERT OR IGNORE INTO email_jobs
          (id,request_id,status,idempotency_key,subject,html,next_attempt_at,created_at)
          VALUES (?,?,'pending',?,?,?,?,?)`).run(randomUUID(), r.id, `restock-${r.id}`, email.subject, email.html, now, now);
        if (result.changes) created++;
        sql().prepare(`UPDATE requests SET status='queued', updated_at=? WHERE id=? AND status='open'`).run(now, r.id);
      }
    }
    sql().prepare(`UPDATE webhook_events SET status='done',locked_until=NULL,processed_at=?,last_error=NULL
      WHERE event_id=?`).run(Date.now(), eventId);
    return created;
  });
}
export function retryEvent(eventId, error, attempt) {
  const wait = Math.min(60000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
  sql().prepare(`UPDATE webhook_events SET status='pending',locked_until=NULL,
    next_attempt_at=?,last_error=? WHERE event_id=?`).run(Date.now() + wait, String(error).slice(0, 400), eventId);
}
export function claimEmail() {
  return transaction(() => {
    const now = Date.now();
    const job = sql().prepare(`SELECT j.*, r.email,r.sku FROM email_jobs j
      JOIN requests r ON r.id=j.request_id WHERE j.next_attempt_at<=?
      AND (j.status='pending' OR (j.status='sending' AND j.locked_until<?))
      ORDER BY j.created_at LIMIT 1`).get(now, now);
    if (!job) return null;
    sql().prepare(`UPDATE email_jobs SET status='sending',attempts=attempts+1,
      locked_until=? WHERE id=?`).run(now + 60000, job.id);
    return { ...job, attempts: job.attempts + 1 };
  });
}
export function finishEmail(jobId, requestId, providerId) {
  return transaction(() => {
    const now = Date.now();
    sql().prepare(`UPDATE email_jobs SET status='sent',sent_at=?,provider_id=?,last_error=NULL,locked_until=NULL
      WHERE id=?`).run(now, providerId ?? null, jobId);
    sql().prepare(`UPDATE requests SET status='notified',notified_at=?,updated_at=? WHERE id=?`).run(now, now, requestId);
  });
}
export function retryEmail(jobId, error, attempt, permanent = false) {
  const wait = Math.min(60000, 1000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
  sql().prepare(`UPDATE email_jobs SET status=?,locked_until=NULL,next_attempt_at=?,last_error=? WHERE id=?`)
    .run(permanent ? 'failed' : 'pending', Date.now() + wait, String(error).slice(0, 400), jobId);
}
export function manualRetry(jobId) {
  return transaction(() => {
    const row = sql().prepare(`SELECT id FROM email_jobs WHERE id=? AND status='failed'`).get(jobId);
    if (!row) return false;
    sql().prepare(`UPDATE email_jobs SET status='pending',next_attempt_at=?,last_error=NULL WHERE id=?`).run(Date.now(), jobId);
    return true;
  });
}
export function adminOverview({ filter = 'all', q = '', page = 1 } = {}) {
  const counts = sql().prepare(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='notified' THEN 1 ELSE 0 END) AS notified
    FROM requests`).get();
  const where = [`(?='all' OR r.status=?)`, `(r.email LIKE ? OR r.sku LIKE ?)`];
  const params = [filter, filter, `%${q}%`, `%${q}%`];
  const total = sql().prepare(`SELECT COUNT(*) AS count FROM requests r WHERE ${where.join(' AND ')}`).get(...params).count;
  const rows = sql().prepare(`SELECT r.id, r.email, r.sku, r.status, r.created_at, r.notified_at,
    j.id AS job_id,j.status AS email_status,j.attempts,j.last_error,j.sent_at
    FROM requests r LEFT JOIN email_jobs j ON j.request_id=r.id
    WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 50 OFFSET ?`)
    .all(...params, (page - 1) * 50);
  const failed = sql().prepare(`SELECT COUNT(*) AS count FROM email_jobs WHERE status='failed'`).get().count;
  const retries = sql().prepare(`SELECT COUNT(*) AS count FROM webhook_events WHERE status!='done'`).get().count;
  const activity = sql().prepare(`SELECT event_id,sku,status,attempts,last_error,received_at FROM webhook_events
     ORDER BY received_at DESC LIMIT 6`).all();
  return { counts: { ...counts, failed, retries }, rows, total, page, activity };
}
