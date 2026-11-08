# Stockroom — Back-in-Stock Alerts

A complete, mobile-friendly, dependency-free implementation of the Back-in-Stock Alerts challenge.

**What it ships:** customer iframe widget, subscriber API, verified stock webhooks, durable email outbox, Resend-compatible HTML emails, and a password-protected admin dashboard.

## Stack

- Node.js 22.13+ built-in HTTP server and built-in `node:sqlite` (SQLite / WAL)
- HTML, CSS, and browser JavaScript — no build tooling or `npm install` needed
- Docker (single service, single port, persistent `/data` volume)

**Why no React/Express?** The challenge allows any stack. Eliminating frontend bundlers, native npm modules and runtime dependencies makes this small service easier to audit, deploy, and verify in the challenge's short timeframe. The UI is designed and styled manually.

## Run locally

1. Copy `.env.example` to `.env`.
2. Fill in all six credentials from your own test dashboard; set a strong `ADMIN_PASSWORD`.
3. Run `npm start` (Node.js >=22.13).
4. Open:
   - `http://localhost:3000/embed` — customer widget
   - `http://localhost:3000/admin` — dashboard
   - `http://localhost:3000/health` — readiness

No `npm install` is required. `PORT` defaults to `3000`. You may set `DATA_DIR` to change the local SQLite path (default `./data`).

## Docker

```bash
docker build -t stockroom-alerts .
docker volume create stockroom-data
docker run --name stockroom --restart unless-stopped \
  -p 3000:3000 --env-file .env -v stockroom-data:/data stockroom-alerts
```

The container uses `$PORT` (default `3000`) and binds to `0.0.0.0`. If you change PORT, update the host port mapping too (e.g. `-p 8080:8080 -e PORT=8080`). The only **mandatory environment variables** are the six supplied in the challenge. The image runs without installing dependencies on startup.

**Persistence:** Docker's `/data` is a volume. A named volume (`-v stockroom-data:/data`) preserves data even if you replace/recreate the container. Without an explicit mount, the Dockerfile's `VOLUME /data` creates an anonymous volume, which is retained by an ordinary `docker restart` but not automatically carried over to a new `docker run`.

## Environment variables

| Variable | Description |
| --- | --- |
| `STOCK_API_URL` | Stock API catalogue URL (e.g. `https://harness-production-e601.up.railway.app/api/stock`) |
| `STOCK_API_KEY` | Bearer token for catalogue and `/SKU` lookups |
| `RESEND_API_KEY` | Bearer token for simulated Resend API |
| `RESEND_BASE_URL` | **Test server origin**, *not* `api.resend.com` |
| `WEBHOOK_SECRET` | Value required in `X-Webhook-Secret` header |
| `ADMIN_PASSWORD` | Password for `/admin` |
| `PORT` | Optional listening port, default `3000` |
| `DATA_DIR` | Optional persistent SQLite directory; default `./data`, Docker `/data` |

Do not commit `.env` or real credentials. Example values only are supplied. This program does not use actual customer data or a production email provider.

## Endpoints

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/embed` | Responsive, iframe-compatible email + SKU form (optional `?sku=SKU`) |
| POST | `/api/requests` | `{ "email": "person@example.com", "sku": "TEE-ORG-WHT-M" }` |
| POST | `/webhooks/stock` | Validate `X-Webhook-Secret`, store `{event_id,sku,quantity}`, verify SKU with Stock API asynchronously |
| GET | `/admin` | Password-protected request list and notification timestamps |
| GET | `/admin/login` | Password form |
| GET | `/api/catalogue` | Proxy catalogue with API key on server |
| GET | `/health` | Health status |

Requests return HTTP 201 on a new subscription or HTTP 200 when the same active email+SKU already exists.

## How duplicate and missed emails are prevented

1. **Atomic subscription deduplication:** SQLite partial UNIQUE constraint on normalized email + SKU where request status is `open` or `queued`. Concurrency-safe even when identical requests arrive together.
2. **Authenticated, idempotent webhooks:** Every `event_id` has a SQLite primary key. Bad secrets return 401. Every *new* event is durably committed before responding 202, so event processing can resume after restart. Duplicate events return 200 without being reprocessed.
3. **Never trust the webhook quantity:** A background worker calls `GET STOCK_API_URL/{sku}` with `Authorization: Bearer STOCK_API_KEY`. Only a verified positive quantity can enqueue notifications. If the network/API fails, the event is retried with backoff.
4. **Transactional outbox:** Email jobs have a UNIQUE `request_id`. Jobs and request state transitions are written in the same SQLite transaction. A database-backed worker claims them using leases. In-progress jobs are automatically recovered after an unexpected restart (lease expires after 60 seconds).
5. **Provider-level idempotency:** Every email job has a persistent stable `Idempotency-Key` sent to `POST ${RESEND_BASE_URL}/emails`. The challenge harness explicitly honors this header. This covers the hard case where the provider accepted the email but the HTTP response was lost, so re-sending the job does not result in a second accepted email.
6. **Retry failures:** Transient HTTP 5xx, HTTP 429 and network errors are retried with exponential backoff (1s up to 60s). Terminal provider validation/auth errors are marked `failed`, visibly shown in the admin dashboard, and can be retried manually after the issue is corrected.
7. **Persistence:** Requests, events, jobs, timestamps and errors are stored on disk in SQLite/WAL and not in ephemeral memory.

**Exactly-once caveat:** Exactly-once physical delivery depends on the email provider honoring the persistent idempotency key. The challenge harness does. For other providers, this guarantee cannot be provided by an HTTP client alone, and real email delivery after provider acceptance is not independently guaranteed.

## Quick manual test with the challenge server

1. Run Stockroom locally, then expose port `3000` using `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` (unless you are running the harness yourself).
2. Paste the **public HTTPS URL** (just the origin, no `/webhooks/stock` suffix) into the test dashboard's **Your app** field and save.
3. In the test dashboard, locate an out-of-stock SKU and subscribe using `/embed` or POST `/api/requests`.
4. Use **Set stock by hand** to make its quantity positive, then **Send a webhook**.
5. Confirm a stock API lookup appears in the harness, and one accepted email appears in its inbox.
6. Re-send the same event ID: no additional accepted email should appear.
7. Set **Email failures** to `1`, subscribe a different email/SKU, restock it and webhook: you should see one failed attempt followed by one accepted email.
8. Restart the app and check `/admin`: requests and notifications should remain.

## Automated integration tests

```bash
npm test
npm run check
```

Tests use a local mock stock API and mock email receiver. They cover rejection of forged webhook secrets, stock verification despite a misleading webhook quantity, concurrent duplicate event submissions, idempotent subscription requests, email provider 500 followed by successful retry, authentication, SQLite persistence across restarts, replay protection after restart, and the catalogue proxy.

## AI disclosure / Upwork submission

- AI tool used for the implementation: **ChatGPT (GPT-6)**.
- Development time: **fill in your actual elapsed time before submitting**.
- Submission: push this repository to your own GitHub; ensure `.env` and `data/` are excluded; provide the GitHub repo link in your proposal. A public URL is optional.

## Notes

- The challenge **test server**, not real Resend, is configured in `RESEND_BASE_URL`.
- Admin login is a signed, HTTP-only, SameSite=Strict cookie; sessions survive restarts but rotate if the admin password changes. Failed login attempts are rate limited in process memory.
- App is intended to run as **one service instance** per SQLite database. For multi-region/high-volume scaling, move job dispatch to a dedicated process and use a centralized database.
- No container runtime is installed in the provided coding environment; local Node.js execution and automated integration tests were performed, but the Docker build was **not executed here**.
