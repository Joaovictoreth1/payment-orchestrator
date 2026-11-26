# Payment Orchestrator

A Node.js 24 / TypeScript HTTP service for exercising safe payment routing. Its Stripe/Pagar.me-style routes are **simulators**: no live providers, settlement, PIX QR codes, or real card data. The process refuses any mode other than `simulation`. The API is server-to-server and has no browser dashboard.

## Run locally

Requires Docker with Compose v2, Node.js 24, Make and OpenSSL. From a fresh checkout:

```sh
umask 077
sed -e "s/^PAYMENT_API_KEY=$/PAYMENT_API_KEY=$(openssl rand -hex 32)/" \
    -e "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env.example > .env
make up
make smoke
```

The app binds to the host loopback interface. Compose applies the migration before starting the app, and leaves data in a named volume. `make down` stops services without deleting that volume. Keep the generated credentials for the lifetime of the stack.

## API

| Route                           | Purpose                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `GET /health`                   | Process liveness, no database query                                           |
| `GET /ready`                    | Readiness: migration exists, storage responds and the service is not draining |
| `POST /api/v1/payments/process` | Authenticated payment simulation                                              |

```sh
# Read the generated credential into this shell. Do not commit .env.
. ./.env
key="$(node -p "crypto.randomUUID()")"
curl -sS -D - "http://127.0.0.1:${PORT}/api/v1/payments/process" \
  -H "Authorization: Bearer ${PAYMENT_API_KEY}" \
  -H "Idempotency-Key: ${key}" \
  -H 'Content-Type: application/json' \
  -d '{"amountMinor":1250,"currency":"BRL","method":"CREDIT_CARD","paymentToken":"tok_sim_approved"}'
```

The JSON body limit is 16 KiB. `amountMinor` is an integer in `1–999999999`. Specify `BRL`, `USD` or `EUR` for card payments and `BRL` for PIX. Use an opaque `tok_` token for cards; do not send a token for PIX. Unknown fields, including legacy `amount` and raw `cardNumber`, are rejected. Reuse the same idempotency key (16–128 characters: letters, numbers, hyphens or underscores) **only** for retries of the same payment.

Use `tok_sim_approved`, `tok_sim_declined`, `tok_sim_fallback`, or `tok_sim_unknown` to simulate common card outcomes when the primary circuit is closed. PIX simulates an immediate approval. Successful responses contain `data.status`, `data.gateway`, `data.transactionId`, and `data.attempts`. API errors use `{"error":{"code":"…","message":"…"}}`.

| HTTP response                                                    | Meaning and client behavior                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `200 APPROVED`                                                   | Simulation approved; returned IDs start with `sim_`.                             |
| `402 DECLINED`                                                   | Terminal decline; no fallback.                                                   |
| `409 IDEMPOTENCY_CONFLICT`                                       | The key was already used for a different payment.                                |
| `409 PAYMENT_PENDING`                                            | Retry with the **same** key after `Retry-After`. Escalate if it remains pending. |
| `503 UNKNOWN`                                                    | A submission may have occurred. Reconcile; do not retry with a new key.          |
| `503 UNAVAILABLE`                                                | No gateway accepted submission. The result is sticky for that key.               |
| `503 SERVER_BUSY` / `STORAGE_UNAVAILABLE`, or `429 RATE_LIMITED` | Back off and resend with the same key.                                           |
| `400`, `401`, `404`, `405`, `413`, `415`                         | Fix the request or credential before retrying.                                   |

When a payment has a stored outcome, a matching retry gets its original status and body with `Idempotency-Replayed: true`. Request IDs are unique to each HTTP request.

## Architecture and operations

- The HTTP layer owns request validation, bearer authentication, body limits, and process-local rate and concurrency limits. It does not enable CORS. Logs include only route, timing, status and request ID; they exclude credentials, bodies, tokens and idempotency keys.
- The payment service normalizes the request and stores only a fingerprint and outcome. PostgreSQL's primary key establishes a single owner before any gateway is called, including across API replicas. The service persists the outcome before responding.
- The orchestrator falls back only if a gateway certifies it never submitted the payment or its circuit was already open. A decline, timeout, or unexpected provider error ends routing. After the cooldown the breaker admits one probe per gateway per process; completions from the previous circuit state cannot clear it.
- Pending rows do not expire or get reassigned automatically: a crash or a lost database acknowledgement can make a submission unknowable. Investigate long-pending records rather than deleting rows or submitting under a new key; for example, query `payment_idempotency` for `completed_at IS NULL` ordered by `created_at`. Without a separate reconciliation process, do not expire records: deleting one reopens its key for submission. Monitor table growth, back up the database, and test restores.
- The configured API key is one trusted service account with a shared idempotency namespace, not tenant isolation. Do not distribute it to browsers or unrelated merchants. Run behind a TLS ingress, keep probes private, set ingress-level distributed rate limits and request deadlines, and use the request ID to correlate failures. Liveness does not depend on PostgreSQL; startup and readiness do.

### Configuration

| Variable                      | Default                  | Purpose                                                                                                                                                               |
| ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_MODE`                | Required                 | Must be `simulation`.                                                                                                                                                 |
| `PAYMENT_API_KEY`             | Required                 | Random URL-safe bearer secret, 32–128 characters.                                                                                                                     |
| `DATABASE_URL`                | Required                 | PostgreSQL URL with host, database and explicit `sslmode`. Use `verify-full` remotely; `disable` is for an isolated local network only. Compose sets this internally. |
| `HOST`                        | `127.0.0.1`              | Listen address; Compose overrides it only inside the app container.                                                                                                   |
| `PORT`                        | `3000`                   | Listen port, or local published port with Compose.                                                                                                                    |
| `PAYMENT_REQUESTS_PER_SECOND` | `30`                     | Per-process token bucket rate and burst capacity.                                                                                                                     |
| `PAYMENT_MAX_INFLIGHT`        | `32`                     | Concurrent authenticated payment requests per process.                                                                                                                |
| `POSTGRES_PASSWORD`           | Required by Compose      | Random hex password for the disposable local database.                                                                                                                |
| `TEST_DATABASE_URL`           | Required by `make check` | Disposable database; test account needs permission to create and drop test schemas.                                                                                   |
| `SMOKE_URL`                   | Loopback on `PORT`       | Base URL override for the simulation smoke test.                                                                                                                      |

To deploy the **simulator** separately, build the non-root image with `docker build -t payment-orchestrator .`. Apply the migration with the database owner's credentials, for example `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/migrations/001_payment_idempotency.sql`. Grant the runtime role only database connectivity, schema usage, and `SELECT`, `INSERT`, `UPDATE` on `payment_idempotency`. Inject configuration through your secret manager; give the service a shutdown grace period of at least 30 seconds.

Do not use this service for live traffic. Live payment processing requires provider adapters with provider-side idempotency, merchant and authorization boundaries, reconciliation for ambiguous submissions, and a separate payments/compliance review.

## Verify locally

`make setup` installs the lockfile. `npm test` runs standalone tests and skips the PostgreSQL integration test if `TEST_DATABASE_URL` is unset. `TEST_DATABASE_URL=postgresql://… make check` requires a disposable PostgreSQL 17 database and runs formatting, lint, strict type-checking, unit and API tests, real database integration, dependency audit and the release build. CI runs the same gate and exercises the built image with `make smoke`.

The smoke command verifies readiness, approval, byte-for-byte replay and mismatched-key rejection against a running app. Tests cover terminal declines, ambiguous timeouts, safe fallback, circuit recovery and replay across two API instances and an API restart.
