# SMTP Email Microservice — PRD & Implementation Plan

## Problem Statement

Cold email outreach tools need a reliable backend for sending emails through **users' own SMTP servers**. Embedding SMTP logic directly into a frontend SaaS creates tight coupling, security risks, and makes provider swaps painful.

This microservice solves that by providing a **stateless, API-key-secured Express.js service** that any frontend can call via `fetch()`. It handles connection testing, single sends, async batch sends with rate limiting, and IMAP reply checking — all through the user's own email infrastructure.

### Multi-Account Design

A core use case is **multiple SMTP accounts per user**. Users connect several email accounts (e.g. 3 Gmail accounts) to work around provider daily send limits and increase total throughput. The main app manages an `smtp_accounts` table (one user → many accounts), handles account rotation logic, and calls this service once per account per batch. This service has no concept of users or accounts — it receives credentials and sends. That separation is intentional.

```
User
 ├── Account 1: work@gmail.com     (500/day)
 ├── Account 2: outreach@gmail.com (500/day)
 └── Account 3: sales@outlook.com  (2000/day)
                    │
                    ▼
       Main app splits campaign across accounts
       and calls POST /api/send-batch three times,
       once per account with its own credentials
```

The main app is responsible for:
- Storing and encrypting SMTP credentials
- Tracking daily send counts per account
- Rotating across accounts within a campaign
- Deciding which account sends which emails

---

## Architecture

```
┌──────────────────────┐         ┌───────────────────────────────┐
│   Main SaaS App      │         │   SMTP Microservice           │
│   (Next.js / any)    │         │   (Express.js on Railway)     │
│                      │         │                               │
│  fetch() ──────────────────►  POST /api/test-connection       │
│  fetch() ──────────────────►  POST /api/send                  │
│  fetch() ──────────────────►  POST /api/send-batch  (202)     │
│  fetch() ──────────────────►  GET  /api/batch-status/:jobId   │
│  fetch() ──────────────────►  POST /api/check-replies         │
│  fetch() ──────────────────►  GET  /api/health                │
│                      │         │                               │
│  x-api-key header    │         │  Nodemailer (SMTP)            │
│  for auth ──────────────────►  ImapFlow (IMAP)                │
└──────────────────────┘         └───────────────────────────────┘
```

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **State** | Stateless (no DB) | Credentials come per-request from the main app. No secrets stored here. |
| **Auth** | `x-api-key` header | Simple, proven service-to-service auth. The main app holds the key. |
| **SMTP lib** | Nodemailer | Battle-tested, 10M+ weekly downloads, supports every SMTP provider. |
| **IMAP lib** | ImapFlow | Modern, promise-based, actively maintained. Replaces the aging `node-imap`. |
| **Deployment** | Railway (paid Hobby tier) | Always-on (no cold starts), generous limits, one-click deploy. Free tier has a ~500hr/month credit ceiling — not suitable for production. |
| **Batch strategy** | `better-queue` in-process + 202/poll pattern | No Redis/Bull needed at this scale. Accepts batch immediately, returns job ID, processes async. Eliminates HTTP timeout risk. |
| **SSRF protection** | `request-filtering-agent` | Agent-level DNS validation — blocks private/metadata IPs before TCP connection. Avoids TOCTOU window of pre-connection hostname checks. Do NOT use `nossrf` — active CVE (CVE-2025-2691). |

---

## API Specification

### Authentication

Every request (except `GET /api/health`) must include:

```
x-api-key: <your-service-api-key>
```

The key is set via the `API_KEY` environment variable on the service. **Minimum 32 characters** — generate with `openssl rand -hex 32`. The middleware validates this at startup and crashes with a clear error if `API_KEY` is missing or too short.

---

### `GET /api/health`

**Purpose**: Uptime monitoring, Railway health checks.

**Response** `200`:
```json
{
  "status": "ok",
  "timestamp": "2026-04-01T20:00:00.000Z"
}
```

> Note: `uptime` is intentionally omitted to avoid timing disclosures.

---

### `POST /api/test-connection`

**Purpose**: Verify user-provided SMTP credentials before saving them in the main app.

**Request Body**:
```json
{
  "accountId": "acc_123",
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "user@gmail.com",
      "pass": "app-password-here"
    }
  }
}
```

> `accountId` is optional. When provided, it is echoed back in the response and included in logs so the main app can correlate results to a specific SMTP account. It is never used internally — purely a pass-through identifier.

**Response** `200`:
```json
{
  "success": true,
  "accountId": "acc_123",
  "message": "SMTP connection verified successfully"
}
```

**Response** `401`:
```json
{
  "success": false,
  "error": "AUTH_FAILED",
  "message": "Authentication failed. Check username and password."
}
```

**Response** `422`:
```json
{
  "success": false,
  "error": "CONNECTION_FAILED",
  "message": "Could not connect to the SMTP server. Check host and port."
}
```

> Note: The error message never echoes back the user-supplied host/port to prevent SSRF confirmation.

**Implementation**: Uses `nodemailer.createTransport(smtp).verify()` — establishes a real SMTP handshake without sending anything. Host is validated against private IP ranges via `request-filtering-agent` before any TCP connection is attempted. Transporter is closed in a `finally` block.

---

### `POST /api/send`

**Purpose**: Send a single email through the user's SMTP.

**Request Body**:
```json
{
  "accountId": "acc_123",
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "user@gmail.com",
      "pass": "app-password-here"
    }
  },
  "email": {
    "from": "\"John Doe\" <user@gmail.com>",
    "to": "prospect@company.com",
    "replyTo": "user@gmail.com",
    "subject": "Quick question about {{company}}",
    "text": "Hi {{firstName}},\n\nPlain text fallback...",
    "html": "<p>Hi {{firstName}},</p><p>HTML version...</p>",
    "headers": {
      "X-Campaign-ID": "camp_abc123"
    }
  }
}
```

> [!NOTE]
> Template variable interpolation (`{{firstName}}`) is NOT handled by this service. The main app resolves variables before calling `/api/send`. This service is a dumb pipe — it sends exactly what you give it.
>
> Custom `headers` are restricted to `X-` prefixed names with printable ASCII values only. Standard headers (`To`, `From`, `Cc`, `Bcc`, `Subject`, `Content-Type`, etc.) are blocked to prevent header injection.

**Response** `200`:
```json
{
  "success": true,
  "accountId": "acc_123",
  "messageId": "<abc123@gmail.com>",
  "accepted": ["prospect@company.com"],
  "rejected": [],
  "requestId": "uuid-v4"
}
```

**Response** `500`:
```json
{
  "success": false,
  "error": "SEND_FAILED",
  "message": "Sending failed. Check SMTP credentials and try again.",
  "requestId": "uuid-v4"
}
```

> Note: Raw SMTP error messages from Nodemailer are never forwarded. They are logged internally and mapped to sanitized responses.

**Implementation**: Creates a per-request Nodemailer transporter (no pool, since credentials change per-caller). Always calls `transporter.close()` in a `finally` block to prevent socket leaks.

---

### `POST /api/send-batch`

**Purpose**: Queue a batch of emails for async delivery with configurable delay between sends. Returns immediately with a job ID — does not block while sending.

**Request Body**:
```json
{
  "accountId": "acc_123",
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "auth": {
      "user": "user@gmail.com",
      "pass": "app-password-here"
    }
  },
  "emails": [
    {
      "to": "prospect1@company.com",
      "subject": "Quick question",
      "text": "Hi Alice...",
      "html": "<p>Hi Alice...</p>"
    },
    {
      "to": "prospect2@company.com",
      "subject": "Quick question",
      "text": "Hi Bob...",
      "html": "<p>Hi Bob...</p>"
    }
  ],
  "options": {
    "from": "\"John Doe\" <user@gmail.com>",
    "replyTo": "user@gmail.com",
    "delayMs": 3000
  }
}
```

| Option | Default | Constraints | Description |
|---|---|---|---|
| `delayMs` | `3000` | Min: 1000, Max: 30000 | Milliseconds between each send (anti-spam pacing). Enforced server-side — cannot be bypassed by caller. |
| `maxPerBatch` | `50` | Server-side constant | Hard cap per job. Not a request parameter — set via `MAX_PER_BATCH` env var. |

**Response** `202 Accepted`:
```json
{
  "success": true,
  "accountId": "acc_123",
  "jobId": "uuid-v4",
  "total": 2,
  "status": "queued"
}
```

**Response** `400` (batch too large):
```json
{
  "success": false,
  "error": "BATCH_TOO_LARGE",
  "message": "Batch exceeds the maximum of 50 recipients per job."
}
```

**Implementation**: Validates the request synchronously, assigns a UUID job ID, stores initial job state in an in-memory Map, pushes tasks onto a `better-queue` worker, and returns `202` immediately. The queue worker sends emails sequentially with `delayMs` pacing. Job state is updated after each send. A concurrent-job limit (`MAX_CONCURRENT_BATCHES`, default 5) rejects new batches when the service is at capacity.

> [!IMPORTANT]
> In-memory jobs do not survive process restarts. If Railway restarts the container mid-batch, that job is lost. The caller must treat batch delivery as at-most-once and implement retry logic on their end if needed. Job results are retained in memory for 1 hour after completion, then evicted.

---

### `GET /api/batch-status/:jobId`

**Purpose**: Poll for the status and results of a queued batch job.

**Response** `202` (still processing):
```json
{
  "success": true,
  "jobId": "uuid-v4",
  "status": "running",
  "total": 50,
  "sent": 12,
  "failed": 0
}
```

**Response** `200` (complete):
```json
{
  "success": true,
  "jobId": "uuid-v4",
  "status": "done",
  "total": 2,
  "sent": 2,
  "failed": 0,
  "results": [
    { "to": "prospect1@company.com", "messageId": "<...>", "status": "sent" },
    { "to": "prospect2@company.com", "messageId": "<...>", "status": "sent" }
  ],
  "completedAt": "2026-04-01T20:05:00.000Z"
}
```

**Response** `200` (partial failure):
```json
{
  "success": false,
  "jobId": "uuid-v4",
  "status": "done",
  "total": 2,
  "sent": 1,
  "failed": 1,
  "results": [
    { "to": "prospect1@company.com", "messageId": "<...>", "status": "sent" },
    { "to": "prospect2@company.com", "status": "failed", "error": "Mailbox not found" }
  ]
}
```

**Response** `404`:
```json
{
  "success": false,
  "error": "JOB_NOT_FOUND",
  "message": "Job not found or expired."
}
```

---

### `POST /api/check-replies`

**Purpose**: Connect to the user's IMAP inbox and check for replies to previously sent outreach emails.

**Request Body**:
```json
{
  "accountId": "acc_123",
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "auth": {
      "user": "user@gmail.com",
      "pass": "app-password-here"
    }
  },
  "options": {
    "folder": "INBOX",
    "since": "2026-03-25",
    "limit": 50,
    "filterSubjects": ["Re: Quick question"]
  }
}
```

| Option | Default | Description |
|---|---|---|
| `folder` | `"INBOX"` | IMAP folder to search. Restricted to alphanumeric + `_.-/` to prevent IMAP command injection. |
| `since` | 7 days ago | Only fetch emails after this date. Max lookback: 30 days. |
| `limit` | `50` | Max emails to return. Hard cap: 200. |
| `filterSubjects` | `[]` | If provided, only return emails matching these subject prefixes. Each entry validated for IMAP-safe characters. |

**Response** `200`:
```json
{
  "success": true,
  "total": 2,
  "replies": [
    {
      "from": "prospect1@company.com",
      "subject": "Re: Quick question",
      "date": "2026-03-28T14:30:00.000Z",
      "snippet": "Thanks for reaching out! I'd love to...",
      "messageId": "<reply123@company.com>",
      "inReplyTo": "<original456@gmail.com>"
    }
  ]
}
```

**Implementation**: Uses ImapFlow. IMAP host is validated against private IP ranges via `request-filtering-agent` before connection. Connection lifecycle is wrapped in `try/finally` — `client.logout()` is always called, even on error, to prevent connection leaks against providers that enforce per-account IMAP connection limits (Gmail: 15 max). SMTP/IMAP connection timeout: 10 seconds.

---

## Project Structure

```
EmailSTMP/
├── src/
│   ├── server.js              # Express app setup, middleware, listen
│   ├── routes/
│   │   ├── health.js          # GET /api/health
│   │   ├── testConnection.js  # POST /api/test-connection
│   │   ├── send.js            # POST /api/send
│   │   ├── sendBatch.js       # POST /api/send-batch + GET /api/batch-status/:jobId
│   │   └── checkReplies.js    # POST /api/check-replies
│   ├── middleware/
│   │   ├── apiKeyAuth.js      # x-api-key validation (constant-time, startup crash if missing/weak)
│   │   ├── validate.js        # Request body validation (Joi)
│   │   └── errorHandler.js    # Global error handler (sanitizes Nodemailer errors before response)
│   ├── services/
│   │   ├── smtpService.js     # Nodemailer transport factory + send logic (always closes transporter in finally)
│   │   ├── imapService.js     # ImapFlow connection + reply fetching (always logout in finally)
│   │   └── batchQueue.js      # better-queue worker + in-memory job Map + TTL eviction
│   └── utils/
│       ├── sleep.js           # Promisified delay for batch pacing
│       ├── validateHost.js    # SSRF protection via request-filtering-agent (wraps all outbound connections)
│       └── logger.js          # Pino with redact config (smtp.auth.pass, imap.auth.pass never logged)
├── .env.example               # Template env vars
├── .dockerignore              # Excludes .env, node_modules, *.log from build context
├── .gitignore
├── package.json
├── Dockerfile                 # Multi-stage build for Railway (non-root USER node)
├── railway.json               # Railway deployment config
└── README.md                  # API docs + deployment guide
```

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| `express` | ^4.21 | HTTP framework |
| `nodemailer` | ^6.9 | SMTP send + connection verification |
| `imapflow` | ^1.0 | IMAP reply checking |
| `better-queue` | ^3.8 | In-memory async job queue for batch sends (no Redis required, optional SQLite persistence) |
| `uuid` | ^11.0 | Job ID generation for batch status tracking |
| `joi` | ^17.13 | Request validation schemas |
| `helmet` | ^8.0 | Security headers |
| `cors` | ^2.8 | Cross-origin config |
| `pino` | ^9.0 | Structured JSON logging with credential redaction |
| `pino-pretty` | ^13.0 | Dev-only log formatting |
| `express-rate-limit` | ^7.5 | Rate limiting |
| `request-filtering-agent` | ^2.0 | SSRF protection — blocks private/metadata IPs at DNS resolution. **Do not substitute with `nossrf` (CVE-2025-2691).** |
| `dotenv` | ^16.4 | Env var loading |

**Dev dependencies**: `nodemon`

---

## Security Model

| Layer | Implementation |
|---|---|
| **Service auth** | `x-api-key` header checked against `API_KEY` env var (constant-time comparison via `crypto.timingSafeEqual`). Minimum 32 chars enforced at startup. |
| **Input validation** | Joi schemas on every endpoint — rejects malformed/missing fields before any SMTP call. Port 25 blocked. `delayMs` range enforced server-side (1000–30000ms). Custom headers restricted to `X-` prefix with CRLF-safe values. `folder` and `filterSubjects` restricted to IMAP-safe characters. |
| **SSRF prevention** | `request-filtering-agent` validates all user-supplied hosts before TCP connection. Blocks RFC 1918, loopback, link-local (169.254.x), and IPv6 private ranges. |
| **Rate limiting** | `express-rate-limit` — 100 req/15min per IP (defense-in-depth only; in-process, not shared across instances). Separate stricter limit on `/api/send-batch`: 10 req/15min per IP. |
| **Headers** | `helmet()` — sets CSP, X-Frame-Options, HSTS, etc. |
| **CORS** | Locked to specific origin(s) via `ALLOWED_ORIGINS` env var. Startup crash if unset. |
| **No credential storage** | Credentials are per-request. Nothing persists. Zero breach surface. |
| **Logging** | Pino with explicit `redact` config — `smtp.auth.pass` and `imap.auth.pass` paths are censored before any log output. Raw Nodemailer errors are never forwarded to API responses; they are logged internally and mapped to sanitized error codes. |
| **Request body limit** | `express.json({ limit: '512kb' })` — prevents memory pressure from oversized payloads. |
| **Transporter lifecycle** | Every Nodemailer transporter and ImapFlow client is closed/logged out in a `finally` block to prevent socket and connection leaks. |
| **Batch concurrent cap** | `MAX_CONCURRENT_BATCHES` (default 5) rejects new batch requests when the service is at capacity, preventing resource exhaustion. |

---

## Environment Variables

```env
# Service
PORT=3000
NODE_ENV=production

# Auth (generate with: openssl rand -hex 32)
API_KEY=your-64-char-hex-secret-here

# CORS (comma-separated for multiple origins)
ALLOWED_ORIGINS=https://your-saas-app.com

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100

# Batch
MAX_PER_BATCH=50
MAX_CONCURRENT_BATCHES=5
```

---

## Error Handling Strategy

All errors follow a consistent envelope:

```json
{
  "success": false,
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "requestId": "uuid-v4"
}
```

`requestId` is present on every response (success and error) for log correlation.

| Error Code | HTTP Status | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `VALIDATION_ERROR` | 400 | Request body fails Joi schema |
| `AUTH_FAILED` | 401 | SMTP/IMAP credentials rejected |
| `CONNECTION_FAILED` | 422 | Can't reach SMTP/IMAP host (message never echoes user-supplied host/port) |
| `SEND_FAILED` | 500 | SMTP accepted connection but send failed |
| `IMAP_ERROR` | 500 | IMAP search/fetch failed |
| `RATE_LIMITED` | 429 | Too many requests |
| `BATCH_TOO_LARGE` | 400 | Batch exceeds `MAX_PER_BATCH` limit |
| `BATCH_CAPACITY_EXCEEDED` | 503 | `MAX_CONCURRENT_BATCHES` limit reached |
| `JOB_NOT_FOUND` | 404 | Batch job ID unknown or expired (1hr TTL) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Deployment (Railway)

> [!IMPORTANT]
> Use the **Hobby paid plan ($5/month)** for production. The free tier has a ~500 container-hour/month credit ceiling and no SLA. The Hobby plan provides a genuine always-on guarantee suitable for a production API.

### `railway.json`
```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE" },
  "deploy": {
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 10,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

### `Dockerfile`

Multi-stage build: install production deps → copy source → run as non-root user. Final image ~180–220MB (Alpine + Node.js + npm packages). The `USER node` directive is required — Railway runs as root otherwise.

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-alpine AS production
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app .
USER appuser
EXPOSE 3000
CMD ["node", "src/server.js"]
```

### `.dockerignore`

```
.env
.env.*
node_modules
*.log
.git
```

### `PORT` env var

Railway injects `PORT` automatically. The Express server **must** read it:

```javascript
const PORT = process.env.PORT || 3000;
app.listen(PORT);
```

Hardcoding `3000` without this fallback causes Railway health checks to fail on first deploy.

### Startup validation

`server.js` validates required env vars at boot and calls `process.exit(1)` with a clear log message if any are missing or invalid. This makes the `ON_FAILURE` restart policy useful — the service fails fast rather than starting in a broken state.

---

## Batch Architecture Detail

```
POST /api/send-batch
       │
       ▼
  Validate request (Joi)
       │
       ▼
  Assign jobId (UUID)
  Store in jobMap: { status: 'queued', total, sent: 0, failed: 0, results: [] }
       │
       ▼
  Push tasks onto better-queue
       │
  Return 202 { jobId, status: 'queued' }  ◄── caller gets this immediately

  (async, in background)
       │
       ▼
  better-queue worker:
    for each email task:
      ├─ sendMail()
      ├─ update jobMap (sent++ or failed++)
      └─ await sleep(delayMs)
       │
       ▼
  Set jobMap status: 'done'
  Evict entry after 1hr TTL


GET /api/batch-status/:jobId
       │
       ▼
  Read jobMap
  Return 202 if running, 200 if done, 404 if expired/unknown
```

---

## Verification Plan

### Automated Testing (curl scripts)

After implementation, run these commands against the local server (`npm run dev`):

**1. Health check**:
```bash
curl http://localhost:3000/api/health
```
Expected: `200` with `{"status": "ok", ...}`

**2. Auth rejection**:
```bash
curl -X POST http://localhost:3000/api/test-connection
```
Expected: `401` with `{"error": "UNAUTHORIZED"}`

**3. Validation rejection**:
```bash
curl -X POST http://localhost:3000/api/test-connection \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{}'
```
Expected: `400` with `{"error": "VALIDATION_ERROR"}`

**4. SSRF rejection**:
```bash
curl -X POST http://localhost:3000/api/test-connection \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"smtp":{"host":"169.254.169.254","port":587,"secure":false,"auth":{"user":"x","pass":"y"}}}'
```
Expected: `422` with `{"error": "CONNECTION_FAILED"}` (SSRF blocked silently, not confirmed)

**5. Port 25 rejection**:
```bash
curl -X POST http://localhost:3000/api/test-connection \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"smtp":{"host":"smtp.gmail.com","port":25,"secure":false,"auth":{"user":"x","pass":"y"}}}'
```
Expected: `400` with `{"error": "VALIDATION_ERROR"}`

**6. SMTP connection test** (requires real SMTP credentials):
```bash
curl -X POST http://localhost:3000/api/test-connection \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"smtp":{"host":"smtp.gmail.com","port":587,"secure":false,"auth":{"user":"YOUR_EMAIL","pass":"YOUR_APP_PASSWORD"}}}'
```
Expected: `200` with `{"success": true}`

**7. Send single email** (requires real credentials):
```bash
curl -X POST http://localhost:3000/api/send \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"smtp":{...},"email":{"from":"you@gmail.com","to":"test@example.com","subject":"Test","text":"Hello"}}'
```
Expected: `200` with `messageId` in response

**8. Batch send + poll**:
```bash
# Submit batch
JOB=$(curl -s -X POST http://localhost:3000/api/send-batch \
  -H "x-api-key: test-key" \
  -H "Content-Type: application/json" \
  -d '{"smtp":{...},"emails":[{"to":"a@example.com","subject":"Test","text":"Hi"},{"to":"b@example.com","subject":"Test","text":"Hi"}],"options":{"from":"you@gmail.com","delayMs":1000}}')
echo $JOB  # Expect 202 with jobId

# Poll for completion
JOB_ID=$(echo $JOB | python3 -c "import sys,json; print(json.load(sys.stdin)['jobId'])")
curl http://localhost:3000/api/batch-status/$JOB_ID \
  -H "x-api-key: test-key"
```
Expected: `202` while running, then `200` with results when done.

### Manual Verification

> [!IMPORTANT]
> Tests 6 and 7 above require **real SMTP credentials** (e.g., a Gmail account with an App Password). The user should supply these at test time.

1. Start the server locally with `npm run dev`
2. Run curl tests 1–5 (no credentials needed) — verify correct status codes and error shapes
3. Provide a real Gmail + App Password for tests 6–7 — verify email arrives in inbox
4. Test batch sending with 3 recipients and a 1-second delay — confirm 202 returned immediately, poll to completion
5. Test IMAP reply check against the same Gmail inbox
