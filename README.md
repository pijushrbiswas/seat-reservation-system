# Seat Reservation at Scale

A small JSON web service that sells assigned seats for a show.

It makes three promises, even when thousands of buyers go for the same seats at the same time:

- A seat is never sold twice.
- A user can never go over their seat limit.
- A retried request never books twice.

It is built with Fastify and TypeScript on PostgreSQL. Redis sits in front as an optional helper that takes pressure off the database. Postgres alone is still fully correct. The design reasoning is in [WRITEUP.md](WRITEUP.md).

**Live URL:** `<fill in after deploy>`

**Watch it run:** [New Relic dashboard](#option-1-new-relic-charts-and-searchable-logs) or the built-in [`/metrics`, `/stats` and `/logs`](#option-2-the-built-in-endpoints-no-account-needed) (`<url>/metrics`, `<url>/stats`, `<url>/logs`)

---

## Run it

```bash
make up
make test
make dev
make down
```

| Command | What it does |
|---|---|
| `make up` | Starts Postgres, Redis and the app in containers, at http://localhost:8080 |
| `make test` | Starts Postgres and Redis, then runs the tests (needs Node 20 or newer) |
| `make dev` | Runs the app with hot reload, using the Postgres and Redis from compose |
| `make down` | Stops everything and **deletes the data** |

### Settings

All settings are environment variables (see `.env.example`).

**Required:** `DATABASE_URL`, `JWT_SECRET`, `ADMIN_TOKEN`

**Optional:**

| Variable | Default | What it does |
|---|---|---|
| `PG_POOL_MAX` | 20 | Max database connections |
| `PG_SSL` | | Turn on SSL for the database |
| `LOG_LEVEL` | | How much to log |
| `LOG_BUFFER_LINES` | 50000 | How many log lines `/logs` remembers |
| `LOGS_TOKEN` | | If set, `/logs` needs this token |
| `DEFAULT_PER_USER_LIMIT` | 4 | Seats one user may hold per show |
| `REDIS_URL` | | If not set, Redis is off |
| `REDIS_ENABLED` | true | Switch Redis on or off |
| `SEAT_CACHE_TTL_SECONDS` | 30 | How long a "taken" marker lives |
| `SEAT_HOLD_SECONDS` | 300 | How long a seat hold lives in Redis (5 min) |
| `NEW_RELIC_LICENSE_KEY` | | If set, logs and metrics are also sent to New Relic |

Database migrations run by themselves when the app starts. A lock makes sure that several instances starting together don't clash.

---

## Observability:  Watch it run: logs and metrics

You have two ways to see what the service is doing. Pick the one you prefer. They don't exclude each other.

| | Option 1: New Relic | Option 2: built-in endpoints |
|---|---|---|
| What you get | Charts, a ready-made dashboard, searchable logs for all instances | Plain text from `/metrics`, `/stats`, `/logs` |
| What you need | A New Relic account and key | Nothing, just `curl` |
| Good for | Watching a burst live, sharing a link or screenshot | Quick checks, scripts, working offline |

### Step 0: make some traffic first

Whichever option you choose, there must be something to look at. The commands below work on your own machine and on the deployed app. Set the address once:

```bash
BASE=http://localhost:8080
```

For the deployed app, use its URL instead, for example `BASE=https://<your-app>.onrender.com`.

**On your machine, after cloning** (you need Docker; Node 20 or newer is only needed for the burst tool):

```bash
git clone <this repo>
cd seat-reservation-system
make up
curl $BASE/health
```

`make up` starts Postgres, Redis and the app. `/health` should answer:

```json
{"status":"ready","checks":{"database":"ok","redis":"ok"}}
```

**Then generate traffic.** You have two choices.

**(a) Run the load tool** (it uses the dev admin token `dev-admin-token`):

```bash
make install
SCALE=0.1 make burst
```

`make install` is needed only once (it runs `npm ci`). `SCALE=0.1` is a small smoke run. Leave it out to run the full 20,000-request stampede.

**(b) Make a few requests by hand.** One user books a seat, then a second user loses the same seat:

```bash
ADMIN=dev-admin-token
tok() { curl -s -X POST $BASE/auth/token -H 'content-type: application/json' -d "{\"user_id\":\"$1\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
ALICE=$(tok alice)
BOB=$(tok bob)
SHOW=$(curl -s -X POST $BASE/shows -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"name":"demo","seats":["A1","A2","A3"],"price_paise":25000}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST $BASE/shows/$SHOW/reserve -H "authorization: Bearer $ALICE" -H 'x-correlation-id: demo-flow-1' -H 'content-type: application/json' -d '{"seats":["A1"],"idempotency_key":"demo-1"}'
curl -s -X POST $BASE/shows/$SHOW/reserve -H "authorization: Bearer $BOB" -H 'x-correlation-id: demo-flow-1' -H 'content-type: application/json' -d '{"seats":["A1"],"idempotency_key":"demo-2"}'
```

The first reserve returns **201 `confirmed`**. The second returns **409 `seat_taken`**.

Use a new `idempotency_key` for every new booking. Reusing a key with different seats gives 409 `idempotency_key_conflict`.

---

### Option 1: New Relic (charts and searchable logs)

Choose this if you want to see logs and metrics in New Relic. You do three things: add the key, change the account id in the dashboard file, and import the dashboard.

#### 1. Add your New Relic key

You need an **Ingest - License** key from your New Relic account (the *API keys* page).

**On your machine:**

```bash
NEW_RELIC_LICENSE_KEY=<your key> make up
```

**On Render:** open the service, go to the **Environment** tab, add `NEW_RELIC_LICENSE_KEY` and save. The blueprint leaves this for you to fill in, and the key is never stored in the repo.

Other settings (all optional):

| Variable | Default | What it does |
|---|---|---|
| `NEW_RELIC_REGION` | `us` | Set to `eu` if your account is in the EU |
| `NEW_RELIC_LOG_ENDPOINT` | | Use for any other endpoint |
| `NEW_RELIC_APP_NAME` | `seat-reservation` | The `service` name you filter on in New Relic |
| `NEW_RELIC_METRICS_INTERVAL_SECONDS` | 15 | How often metrics are sent |
| `NEW_RELIC_METRICS_ENABLED` | true | Set to `false` to send logs only |

Once the key is set, the app starts sending both logs and metrics by itself. You don't have to create anything for the metrics. They appear in New Relic as soon as they are sent.

#### 2. Change the account id in the dashboard file

`observability/newrelic-dashboard.json` is a ready-made dashboard. It contains a placeholder `accountId` of `0`, so you must put your own account id in before importing.

**Find your account id.** It is a number. It is usually visible in the New Relic page address as `account=<number>`, and in the account or administration pages (menu names can change, so look under your account settings if you can't find it).

**Put it in the file.** This command writes the updated JSON to your clipboard (macOS):

```bash
ACCOUNT_ID=<your account id>
python3 -c "import json;d=json.load(open('observability/newrelic-dashboard.json'));[q.update(accountId=int('$ACCOUNT_ID')) for p in d['pages'] for w in p['widgets'] for q in w['rawConfiguration']['nrqlQueries']];print(json.dumps(d))" | pbcopy
```

On Linux, `pbcopy` doesn't exist. Send the output to a file instead, for example by replacing `| pbcopy` with `> observability/dashboard.local.json`.

Don't commit your changed copy. Files named `observability/*.local.json` are ignored by git.

#### 3. Import the dashboard

1. In New Relic, go to **Dashboards**.
2. Click **Import dashboard**.
3. Paste the JSON (or the contents of your file).
4. Choose your account.
5. Click **Save**.

The dashboard has three pages:

| Page | What it shows |
|---|---|
| Reservations | Confirmed, declined by reason, the drift check (must be 0), seats per show |
| Service health | Requests, latency, Redis, database pool |
| Logs | The service's log lines |

Run `make burst` while the dashboard is open to watch the numbers move.

#### 4. Look at logs and run your own queries

- **Logs:** in New Relic open **Logs** and search `service:seat-reservation`. Each line has `request_id`, `correlation_id`, `route`, `status`, `outcome` and `user_id` as searchable attributes.
- **Metrics:** open **Query your data** and run NRQL such as:

```
FROM Metric SELECT sum(reservations_confirmed_total) TIMESERIES SINCE 1 hour ago
FROM Metric SELECT sum(reservations_declined_total) FACET reason TIMESERIES
FROM Metric SELECT latest(seats_available) FACET show_id
FROM Metric SELECT max(seats_reconciliation_drift)
```

#### How the sending works

- **Logs** are grouped, compressed and sent every 2 seconds, in the background. If New Relic is slow or down, your requests are not affected. Failed batches are retried with waiting time in between. If more than 50,000 lines are waiting, the oldest are dropped. Any remaining lines are sent when the app shuts down.
- **Metrics** use the same names and labels as `/metrics`, so the Prometheus names work as they are. Counters are sent as the increase since the last successful send, gauges as values, and histograms as `_sum` and `_count`. Every point has `service` and `instance` attributes. A failed send loses nothing, because the next one carries everything since the last success.
- **Nothing else changes.** `/metrics`, `/logs` and stdout keep working exactly as before, so you can still use Option 2 at the same time.
- With several instances, New Relic shows all of them together. Use the `instance` attribute to look at one.

---

### Option 2: the built-in endpoints (no account needed)

Choose this if you don't want to use New Relic. The service serves its own metrics and logs. All four endpoints are public. If the service has `LOGS_TOKEN` set, add `-H "authorization: Bearer $LOGS_TOKEN"` to the `/logs` calls.

#### Metrics: `/metrics`

These are the counters the brief asks for (Prometheus format):

```bash
curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total|reservations_cancelled_total)'
```

```
reservations_confirmed_total 1
reservations_declined_total{reason="seat_taken"} 1
```

The decline reasons are `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_conflict` and `unknown_seat`.

**Seat numbers for one show** (available, held, confirmed, total, and the drift, which must be 0):

```bash
curl -s $BASE/metrics | grep "show_id=\"$SHOW\""
```

**Everything `/metrics` reports:**

- `reservations_confirmed_total`
- `reservations_declined_total{reason}`
- `reservations_cancelled_total`
- Gauges `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` (with `show_id`), and `seats_reconciliation_drift{show_id}`, which **must be 0**. They cover **every show**. Set `METRICS_MAX_SHOWS=N` to report only the newest N. They are read from Postgres when scraped and cached for 1 second.
- HTTP request count, latency and in-flight requests, and database pool gauges.
- `seat_cache_declines_total`: "seat taken" declines answered by Redis (also counted in `reservations_declined_total`)
- `seat_cache_errors_total`: Redis failures that fell through to Postgres

Counters belong to one app instance and start at 0 when it starts.

#### Stats: `/stats` (the readable version)

`/stats` shows the same seat numbers as the gauges, one line per show, newest first:

```bash
curl -s $BASE/stats
curl -s "$BASE/stats?format=json"
```

```
show="demo" id=7b296572-... total=3 available=2 held=0 confirmed=1 drift=0
```

**Check the numbers add up.** `available + held + confirmed` must equal `total_seats`:

```bash
curl -s "$BASE/shows/$SHOW?seats=false"
```

#### Logs: `/logs`

```bash
curl -s "$BASE/logs?limit=20"
curl -s "$BASE/logs?limit=50000" > logs.ndjson
curl -s "$BASE/logs?level=warn"
curl -s "$BASE/logs?path=/reserve&limit=50"
curl -s "$BASE/logs?request_id=<id>"
curl -s "$BASE/logs?correlation_id=demo-flow-1"
curl -s "$BASE/logs?limit=1" | python3 -m json.tool
docker compose logs -f app
```

What each line does, in order:

1. The last 20 lines. The default is 200, and the most you can ask for is `LOG_BUFFER_LINES`.
2. Everything the instance still remembers, saved to a file.
3. Only warnings and errors.
4. Only one route.
5. One HTTP call. Its id is in the `x-request-id` response header and in error bodies.
6. Every call that belongs to one flow across services.
7. One line, pretty-printed.
8. Local only: the container output, following live.

Each request line is JSON with `request_id`, `correlation_id`, `method`, `route`, `path`, `status`, `duration_ms`, `user_id` and `outcome` (`confirmed`, `seat_taken`, `idempotent_replay`, and so on).

Things to know:

- The log buffer belongs to one instance and is cleared when it restarts.
- The same lines also go to stdout, so the platform's log viewer shows them. On Render, open the service and its **Logs** tab for a live view.
- Successful `/health` checks (from Docker and the platform) are not logged, to keep the log readable. A failing one is logged. They still count in `/metrics`.

#### Health: `/health`

- **Default (readiness check):** runs `SELECT 1` on a small separate connection pool. It answers **503** if the database can't be reached, so it fails safely. Because the pool is separate, a busy burst can't make it look unhealthy. It also reports `checks.redis` (`ok`, `down` or `disabled`). That is only information and never makes the check fail.
- **`/health?probe=live` (liveness check):** answers 200 as long as the process is running, without touching any dependency. So a database outage stops traffic but never makes the platform restart a healthy process.

Render's health check uses `?probe=live`. Docker's uses the default.

#### Using Option 2 on the deployed app

- Use the same commands with `BASE` set to the live URL.
- Load it from your machine: `make burst BASE_URL=$BASE ADMIN_TOKEN=<the service's ADMIN_TOKEN>`. Read the token from the service's Environment tab on Render. To create a show by hand, use the same token as `ADMIN`.
- With several instances, `/metrics` and `/logs` answer for whichever instance got the request. For the full picture, use the platform logs or Option 1.

---

## One-command burst

```bash
make burst BASE_URL=https://<your-app> ADMIN_TOKEN=<admin token>
```

You can also run `npm run burst -- https://<your-app>`.

Against your local stack, just run `make burst`. It uses `http://localhost:8080` and the dev admin token.

**Knobs:** `SCALE=0.1` for a small run, or `HOT_USERS`, `USERS`, `REQUESTS`, `SEATS`, `HOT_SEATS`, `CONCURRENCY`.

It runs four phases. It prints how many requests were confirmed, declined (by reason) or failed with 5xx, plus latency percentiles and PASS/FAIL checks. The exit code is non-zero if any check fails.

1. **Hot-seat storm:** 500 users go for one seat. Expect exactly one 201 and 499 × 409 `seat_taken`.
2. **On-sale stampede:** 20,000 requests from 5,000 users over 5,000 seats. Half of them aim at 10 hot seats. About 10% are retries with the same key, and about 4% reuse a key with different seats. Checks:
   - zero 5xx
   - no seat won twice
   - nobody above the limit
   - the winners' seats match the server's final state
   - `available + held + confirmed == total`, checked *during* the burst and at the end
   - the `/metrics` counter changes match what the tool observed
3. **Per-user limit:** one user sends 10 parallel reserves with a limit of 4. Exactly 4 win.
4. **Identity and cancel:**
   - a fake user id in the body is ignored
   - cancelling someone else's reservation is rejected
   - cancel then re-book works
   - cancelling twice does not bring back a seat that was re-sold

The metrics check is exact only if the burst is the only traffic and one instance serves `/metrics`. Otherwise it prints a warning instead of failing.

---

## API

All bodies are JSON. Money is in integer paise. Errors look like this:

```json
{"error": {"code": "...", "message": "...", "request_id": "...", "correlation_id": "..."}}
```

Every response carries two ids:

- `x-request-id` identifies this one HTTP call.
- `x-correlation-id` identifies the whole flow across services.

If the caller sends either one (short, using letters, digits and `._-`), it is used. Otherwise one is generated. A service that calls other services should forward `x-correlation-id`, so every service logs the same value.

| Method | Path | Who can call | Notes |
|---|---|---|---|
| POST | `/auth/token` | anyone | Demo login: `{"user_id": "alice"}` gives `{"token": "..."}` (a JWT valid for 24h). Replace with a real login system. |
| POST | `/shows` | admin (`Authorization: Bearer $ADMIN_TOKEN`) | `{"name", "seats": [...], "price_paise", "per_user_limit"?}` returns 201 with the show, all seats `available` |
| GET | `/shows/{id}` | anyone | Per-seat status and counts. Add `?seats=false` for counts only. `reconciled` means `available+held+confirmed == total_seats`. |
| POST | `/shows/{id}/reserve` | logged-in user | `{"seats": ["A12"], "idempotency_key": "..."}`, or send an `Idempotency-Key` header |
| POST | `/reservations/{id}/cancel` | the owner only | Frees the seats and the owner's quota |
| GET | `/health` `/metrics` `/stats` `/logs` | anyone | See [Option 2](#option-2-the-built-in-endpoints-no-account-needed) |

### What `POST /shows/{id}/reserve` can answer

| Status | Meaning |
|---|---|
| 201 | Confirmed: `{reservation_id, show_id, user_id, seats, amount_paise, status: "confirmed"}` |
| 200 | A replay of an earlier success (header `Idempotent-Replayed: true`). Nothing changed. |
| 409 | A clean decline. `error.code` is `seat_taken`, `per_user_limit` or `idempotency_key_conflict` |
| 422 | `unknown_seat` |
| 400 / 401 / 404 | Bad body or missing key / bad token / unknown show |

### How it behaves

- **Who you are** comes only from the verified token. A `user_id` in the body is ignored.
- **Multi-seat requests are all-or-nothing.** If any seat is taken, nothing is reserved and the 409 lists the taken seats. The order of seats and duplicates in the request don't matter, because they are cleaned up first.
- **Holds:** the request that wins a seat's lock in Redis holds it (for `SEAT_HOLD_SECONDS`, 5 minutes). It is the only one that goes on to Postgres to confirm. Everyone else gets a 409 straight away.
- **No payment step.** Reserving confirms at once. The hold only covers the short gap, or expires by itself if the winner crashes.
- **Where "held" lives:** Postgres only stores `available` and `confirmed`. `held` in `GET /shows/{id}` and `seats_held` comes from Redis (the seat is available in Postgres and its hold hasn't expired).
- **Cancel** releases a confirmed reservation. It is safe to repeat: a second cancel returns 200 with the same body plus `Idempotent-Replayed: true`, and releases nothing again. Someone who isn't the owner gets 403.
- **Idempotency keys** belong to one user. Only a *successful* reservation uses up a key, so a declined attempt can be retried with the same key. Replaying a key after cancelling returns the reservation, now marked `cancelled`.

---

## Deploy

`render.yaml` is a Render blueprint. It sets up a Docker web service, a Postgres database and a free Redis (Key Value) instance. In Render, choose **New > Blueprint** and select this repo.

- `JWT_SECRET` and `ADMIN_TOKEN` are generated for you. Read `ADMIN_TOKEN` from the service's Environment tab to run the burst.
- To see logs and metrics in New Relic, add `NEW_RELIC_LICENSE_KEY` in the same Environment tab (see [Option 1](#option-1-new-relic-charts-and-searchable-logs)).
- To use an outside database (Neon, Supabase and so on), set `DATABASE_URL` and `PG_SSL=true`.
- The container starts listening first and reports `/health` 503 until the database answers and migrations finish. So a cold start comes up healthy by itself.
- Running more than one instance is safe, because every decision is made in Postgres and Redis is shared. But `/metrics` and `/logs` are per instance.

---

## Project layout

```
src/bootstrap/        server.ts (entry point), app.ts (Fastify setup, request ids, error mapping), context.ts
src/config/           config.ts: settings from environment variables
src/common/           errors.ts: error types shared by every layer
src/security/         auth.ts: user tokens and the admin check
src/routes/           HTTP handlers
src/services/         shows.ts, reservations.ts: business flow only, no SQL and no Redis commands
src/infrastructure/
  database/           connection.ts (pools, transactions, migrations), repositories/ (every DB call), queries/ (the SQL text)
  cache/              the Redis layer: seatCache.ts, Lua scripts (seatScripts.ts), key builders (keys.ts)
  events/             eventBus.ts: a typed bus the services publish outcomes to
  logging/            logger.ts: structured logs and the in-memory buffer served by /logs
  metrics/            metrics.ts (Prometheus registry), metricsListener.ts (events become counters)
  newrelic/           logShipper.ts and metricsShipper.ts: background senders to New Relic
src/burst/burst.ts    the burst and verification tool
observability/        newrelic-dashboard.json: dashboard you can import
migrations/           plain SQL, applied at startup
tests/                vitest against a real Postgres and Redis (includes concurrency and Redis-failure tests)
```