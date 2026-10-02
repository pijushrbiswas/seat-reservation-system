# Seat Reservation at Scale

A small JSON HTTP service that sells assigned seats for a show. It never sells a seat twice, never lets a
user exceed their limit, and never double-books a retried request, even when thousands of buyers hit the
same seats at once. Fastify + TypeScript on PostgreSQL. Design notes are in [WRITEUP.md](WRITEUP.md).

**Live URL:** `<fill in after deploy>`  ·  metrics: `<url>/metrics`  ·  logs: `<url>/logs`

## Run it

```bash
make up                 # Postgres + the app in containers, on http://localhost:8080
make test               # starts Postgres, runs the test suite (Node >= 20)
make dev                # app with hot reload against the compose Postgres
make down
```

Config is environment-only (see `.env.example`): `DATABASE_URL`, `JWT_SECRET`, `ADMIN_TOKEN` are required;
`PG_POOL_MAX` (20), `PG_SSL`, `LOG_LEVEL`, `LOGS_TOKEN` (protects `/logs` when set), `DEFAULT_PER_USER_LIMIT` (4).
Migrations run automatically at startup (guarded by an advisory lock, so several instances can boot together).

## One-command burst

```bash
make burst BASE_URL=https://<your-app> ADMIN_TOKEN=<admin token>
# or: npm run burst -- https://<your-app>
```

Against the local stack just `make burst` (uses `http://localhost:8080` and the dev admin token).
Knobs: `SCALE=0.1` for a smoke run, or `HOT_USERS`, `USERS`, `REQUESTS`, `SEATS`, `HOT_SEATS`, `CONCURRENCY`.

It runs four phases and prints the outcome distribution (confirmed / declined by reason / 5xx), latency
percentiles, and PASS/FAIL checks; exit code is non-zero if any check fails:

1. **Hot-seat storm** - 500 users, one seat: exactly one 201, 499 x 409 `seat_taken`.
2. **On-sale stampede** - 20,000 requests from 5,000 users over 5,000 seats, half aimed at 10 hot seats, ~10% retries
   with the same key and ~4% same-key-different-seats. Checks: zero 5xx, no seat won twice, nobody above the limit,
   the winners' seats equal the server's final state, `available + held + confirmed == total` sampled *during* the
   burst and at the end, and `/metrics` counter deltas equal the observed outcomes.
3. **Per-user limit** - one user, 10 parallel reserves, limit 4: exactly 4 win.
4. **Identity / cancel** - spoofed body user id ignored, foreign cancel rejected, cancel then re-book, repeated cancel
   does not resurrect a re-sold seat.

(The metrics-delta check is exact only if the burst is the sole traffic and one instance serves `/metrics`;
otherwise it prints a warning rather than failing.)

## API

All bodies are JSON; money is integer paise. Errors look like `{"error": {"code", "message", "request_id", ...}}`.
Every response carries `x-request-id` (a caller-supplied `x-request-id` is honoured).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/token` | none | Demo login: `{"user_id": "alice"}` -> `{"token": "..."}` (JWT, 24h). Replace with a real IdP. |
| POST | `/shows` | admin (`Authorization: Bearer $ADMIN_TOKEN`) | `{"name", "seats": [...], "price_paise", "per_user_limit"?}` -> 201 show, all seats `available` |
| GET | `/shows/{id}` | none | per-seat status + counts; `?seats=false` for counts only. `reconciled` is `available+held+confirmed == total_seats` |
| POST | `/shows/{id}/reserve` | user | `{"seats": ["A12"], "idempotency_key": "..."}` or an `Idempotency-Key` header |
| POST | `/reservations/{id}/cancel` | user (owner only) | releases the seats and the owner's quota |
| GET | `/healthz` `/readyz` `/metrics` `/logs` | none | see below |

`POST /shows/{id}/reserve` outcomes:

| Status | Meaning |
|---|---|
| 201 | Confirmed: `{reservation_id, show_id, user_id, seats, amount_paise, status: "confirmed"}` |
| 200 | Idempotent replay of an earlier success (`Idempotent-Replayed: true`); nothing moved |
| 409 | Clean decline. `error.code` is `seat_taken`, `per_user_limit` or `idempotency_key_conflict` |
| 422 | `unknown_seat` |
| 400 / 401 / 404 | malformed body or missing key / bad token / unknown show |

Behaviour worth knowing:

- **Identity** comes only from the verified JWT. A `user_id` in the body is ignored.
- **Multi-seat is all-or-nothing.** If any requested seat is taken, nothing is reserved and the 409 lists the taken seats.
  Seat order and duplicates in the request don't matter (they are normalised before hashing/locking).
- **Model:** reserving confirms immediately (no payment step), and an explicit cancel releases. There are no timed holds,
  so `held` is always 0 but is part of the state model and the invariant.
- **Idempotency:** keys are scoped per user. Only a *successful* reservation consumes a key; a declined attempt can be
  retried with the same key. Replaying a key after cancelling returns the (now `cancelled`) reservation.
- Cancel is itself idempotent (200 again, no second release). Non-owner -> 403.

## Observability

- `GET /healthz` - liveness (process is up). `GET /readyz` - runs `SELECT 1` on a dedicated small pool; **503** when the
  database is unreachable (fails closed), independent of main-pool saturation during a burst.
- `GET /metrics` (Prometheus): `reservations_confirmed_total`, `reservations_declined_total{reason}` with reasons
  `seat_taken | per_user_limit | idempotent_replay | idempotency_key_conflict | unknown_seat`, `reservations_cancelled_total`,
  gauges `seats_available|held|confirmed|total{show_id}` and `seats_reconciliation_drift{show_id}` (must be 0) for the 20 newest shows
  (read from Postgres at scrape time, cached for 1s), plus HTTP request/latency/in-flight and pg pool gauges.
- `GET /logs?limit=200&level=warn&request_id=...&path=...` - last 5,000 structured JSON log lines of that instance (NDJSON).
  Public by default; set `LOGS_TOKEN` to require a bearer token. The same lines go to stdout for the platform's log viewer.
  Each request line has `request_id, method, route, status, duration_ms, user_id, outcome`.

## Deploy

`render.yaml` is a Render blueprint (Docker web service + Postgres): New > Blueprint > select this repo. `JWT_SECRET` and
`ADMIN_TOKEN` are generated; read `ADMIN_TOKEN` from the service's environment tab to run the burst. For an external
database (Neon, Supabase, ...) set `DATABASE_URL` and `PG_SSL=true`. The container listens first and reports `/readyz` 503
until the database answers and migrations finish, so a cold start comes up healthy on its own.
Run a single instance for the fast path described in the write-up; more instances are safe (all decisions live in Postgres)
but `/metrics` and `/logs` are per instance.

## Layout

```
src/app.ts            Fastify wiring, request ids, error mapping
src/services/         shows.ts, reservations.ts (the atomic decisions)
src/routes/           HTTP handlers
src/burst/burst.ts    the burst/verification tool
migrations/           plain SQL, applied at startup
tests/                vitest against a real Postgres (concurrency tests included)
```
