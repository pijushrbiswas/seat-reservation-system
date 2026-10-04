# Seat Reservation at Scale

A JSON service that sells assigned seats. It makes three promises, even when thousands of buyers go for the same seats at once:

- A seat is never sold twice.
- A user can never go over their seat limit.
- A retried request never books twice.

It is built with Fastify and TypeScript on PostgreSQL. Redis sits in front to keep the load off the database. Postgres alone is still fully correct. The design is explained in [WRITEUP.md](WRITEUP.md).

**Live app:** https://seat-reservation-7wrl.onrender.com

| What | Where |
|---|---|
| Readiness (checks the database, fails closed) | `GET /health` |
| Liveness (process is up, touches nothing else) | `GET /health?probe=live` |
| Prometheus metrics | `GET /metrics` |
| Seat counts per show, readable | `GET /stats` |
| Structured logs | `GET /logs` |
| Design write-up | [WRITEUP.md](WRITEUP.md) |

> **Cold start:** the live app runs on Render's free plan, which sleeps after 15 minutes without traffic. The first request can take up to a minute. The app starts listening first and answers `/health` with 503 until the database is ready and migrations have run, so it comes up healthy on its own.

**Contents**

1. [Run it from a clean checkout](#1-run-it-from-a-clean-checkout)
2. [The design in one minute](#2-the-design-in-one-minute)
3. [API](#3-api)
4. [One-command burst](#4-one-command-burst)
5. [Health, metrics and logs (public access)](#5-health-metrics-and-logs-public-access)
6. [Deploy your own copy on Render](#6-Deploy-your-own-copy-on-Render)
7. [Make requests by hand](#7-Make-requests-by-hand)


---

## 1. Run it from a clean checkout

You need **Git**, **Docker** and **Node 20 or newer** (`node -v`). Node is only used for the tests and the burst tool.

```bash
git clone https://github.com/pijushrbiswas/seat-reservation-system.git
cd seat-reservation-system
make up
curl -s http://localhost:8080/health
```

Expect `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

| Command | What it does |
|---|---|
| `make up` | Starts Postgres, Redis, the app (http://localhost:8080) and the Grafana stack |
| `make test` | Starts Postgres and Redis, then runs the tests (includes concurrency and Redis-failure tests) |
| `make dev` | Runs the app with hot reload, using the Postgres and Redis from compose |
| `make install` | Installs the burst tool's dependencies (`npm ci`), needed once |
| `make burst` | Runs the on-sale stampede against a running app (see [section 5](#5-one-command-burst)) |
| `make pg-top` | Prints the ten statements that used the most database time |
| `make down` | Stops everything and **deletes the data** |

Database migrations run automatically at startup. A lock makes sure that several instances starting together don't clash.

---

## 2. The design in one minute

**Redis is a fast doorman. Postgres is the judge.**

- **Redis** lets exactly one request per seat go through to the database. Everyone else gets a quick 409 and never touches Postgres. Redis can only say "no" or "you may try". It never sells a seat, so if Redis is empty, down or wrong, nothing is sold twice.
- **Postgres** makes the final decision in one function call (`reserve_seats`, one round trip): it claims the idempotency key, takes the user's seat quota, locks the seat rows in a fixed order (`ORDER BY label COLLATE "C" ... FOR UPDATE`), and only if it got every seat confirms them and checks the row count.
- **Per-user limit:** one counter row per user and show, updated by a single conditional statement. The row lock makes one user's parallel requests go one at a time.
- **Idempotency:** the key is stored per user in Postgres, together with a hash of the request. A retry returns the original reservation. The same key with different seats is a 409.

The full reasoning is in [WRITEUP.md](WRITEUP.md).

---

## 3. API

All bodies are JSON. Money is in integer paise. Errors look like this:

```json
{"error": {"code": "...", "message": "...", "request_id": "...", "correlation_id": "..."}}
```

| Method | Path | Who can call | Notes |
|---|---|---|---|
| POST | `/auth/token` | anyone | Demo login: `{"user_id": "alice"}` gives `{"token": "..."}` (a JWT valid for 24h). Replace with a real login system. |
| POST | `/shows` | admin (`Authorization: Bearer $ADMIN_TOKEN`) | `{"name", "seats": [...], "price_paise", "per_user_limit"?}` returns 201 with the show, all seats `available` |
| GET | `/shows/{id}` | anyone | Per-seat status and counts. Add `?seats=false` for counts only. `reconciled` means `available+held+confirmed == total_seats`. |
| POST | `/shows/{id}/reserve` | logged-in user | `{"seats": ["A12"], "idempotency_key": "..."}`, or send an `Idempotency-Key` header |
| POST | `/reservations/{id}/cancel` | the owner only | Frees the seats and the owner's quota |
| GET | `/health` `/metrics` `/stats` `/logs` | anyone | See [section 4](#4-health-metrics-and-logs-public-access) |

### What `POST /shows/{id}/reserve` can answer

| Status | Meaning |
|---|---|
| 201 | Confirmed: `{reservation_id, show_id, user_id, seats, amount_paise, status: "confirmed"}` |
| 200 | A replay of an earlier success (header `Idempotent-Replayed: true`). Nothing changed. |
| 409 | A clean decline. `error.code` is `seat_taken`, `per_user_limit` or `idempotency_key_conflict` |
| 422 | `unknown_seat` |
| 400 / 401 / 404 | Bad body or missing key / bad token / unknown show |

### How it behaves

- **Who you are** comes only from the verified token. A `user_id` in the body is ignored, and you can only cancel your own reservations (anyone else gets 403).
- **Multi-seat requests are all-or-nothing.** If you ask for `["A12","A13"]` and A13 is taken, you get nothing, and the 409 lists the taken seats. A12 stays free. This holds under concurrency. Seat order and duplicates in the request don't matter, because they are cleaned up first.
- **Holds:** the request that wins a seat's lock in Redis holds it (for `SEAT_HOLD_SECONDS`, 5 minutes) and is the only one that goes on to Postgres to confirm. There is no payment step, so reserving confirms at once. The hold only covers the short gap, and expires by itself if the winner crashes.
- **Where "held" lives:** Postgres only stores `available` and `confirmed`. `held` in `GET /shows/{id}` comes from Redis (the seat is available in Postgres and its hold hasn't expired).
- **Release model:** explicit cancel. It frees a confirmed reservation, gives the quota back, and is safe to repeat: a second cancel returns 200 with the same body plus `Idempotent-Replayed: true` and releases nothing again. It never frees a seat that now belongs to someone else.
- **Idempotency keys** belong to one user. Only a *successful* reservation uses up a key, so a declined attempt can be retried with the same key. Replaying a key after cancelling returns the reservation, now marked `cancelled`.
- **Request ids:** every response carries `x-request-id` (this one HTTP call) and `x-correlation-id` (the whole flow across services). If the caller sends either one (short, using letters, digits and `._-`), it is used. Otherwise one is generated. Services that call other services should forward `x-correlation-id`.

---

## 4. One-command burst


**1.** Create a file named `.env` in the project folder with these two lines. The file is git-ignored, so the token is never committed.

For running burst against live server
```
BASE=https://seat-reservation-7wrl.onrender.com
ADMIN_TOKEN=a1hjUXa78khSYkE5VtkZq065X+bkK00eK+yWN0mYo14=
```
For local burst

```
BASE=http://localhost:8080
ADMIN_TOKEN=dev-admin-token
```

**2.** Load the two values into your terminal (do this once in every new terminal window), and check that the app is awake. The free plan sleeps when idle, so the first request can take up to a minute:

```bash
set -a
source .env
set +a
curl -s -m 120 $BASE/health
```

**3.** Run the full burst:

```bash
make burst 
```

It runs four phases, prints the outcome counts (confirmed, declined by reason, 5xx), latency percentiles and the final reconciliation, and ends with `all checks passed`. The exit code is non-zero if any check fails.

| Phase | What it does | What must hold |
|---|---|---|
| 1. Hot seat | 500 users all try seat A12 | Exactly one `confirmed`, 499 clean `seat_taken`, no 5xx |
| 2. On-sale stampede | 20,000 requests from 5,000 users over 5,000 seats, half aimed at 10 hot seats, about 10% retries with the same key and about 4% same key with different seats | No 5xx, no seat sold twice, nobody above their limit, the winners' seats equal the server's final state, `available + held + confirmed == total` during and after, and the `/metrics` counter changes match what the script observed |
| 3. Per-user limit | One user fires 10 parallel reserves (limit 4) | Exactly 4 succeed |
| 4. Identity and cancel | Spoofed user id, foreign cancel, cancel then re-book, repeated cancel | Each handled correctly, and a repeated cancel does not bring back a seat that was re-sold |

The metrics check is exact only if the burst is the only traffic and one instance serves `/metrics`. Otherwise it prints a warning instead of failing.


### Burst settings

Put settings in front of the command, for example `SCALE=0.1 make burst`. Every setting is optional.

| Setting | Default | Sample | What it controls |
|---|---|---|---|
| `SCALE` | `1` | `0.1` | A shortcut that shrinks or grows the four sizes marked * below. `0.1` is a tenth of the full load. It does not change `HOT_SEATS` or `CONCURRENCY`. |
| `HOT_USERS` * | `500` | `200` | Phase 1: how many users all try to book the **same single seat** (A12) at the same moment |
| `USERS` * | `5000` | `1000` | Phase 2: how many different users take part. The per-user limit of 4 seats is checked for each. |
| `REQUESTS` * | `20000` | `5000` | Phase 2: the total number of reserve requests, including retries and deliberately conflicting keys |
| `SEATS` * | `5000` | `1000` | Phase 2: how many seats the show has. Fewer seats means more competition and more `seat_taken`. |
| `HOT_SEATS` | `10` | `5` | Phase 2: how many seats are "popular". Half of all requests are aimed at these only. It can't be more than `SEATS`. |
| `CONCURRENCY` | `500` | `200` | The most requests the script keeps in flight at once. Lower it if the app is small or the network is slow (the free Render plan copes better with around `100` to `200`). |
| `BASE_URL` | `BASE`, else `http://localhost:8080` | `https://my-app.onrender.com` | Which app to test. `make burst` takes it from the `BASE` in your `.env`. |
| `ADMIN_TOKEN` | `dev-admin-token` | `<token>` | The admin password the script uses to create its test shows. On a deployed app this must be that app's real token. |

Things to know:

- Sizes you set yourself are used as given. `SCALE` only changes the defaults. With `SCALE=0.1 USERS=1000`, `USERS` is 1000 while `HOT_USERS`, `REQUESTS` and `SEATS` are a tenth of their defaults.
- Phase 3 and phase 4 don't change.
- Each request asks for 1 or 2 seats, and a user can hold at most 4 per show. If `USERS` is small compared with `SEATS`, some seats stay unsold because the users hit their limit first. That's expected.
- Every run creates new shows named `burst-...` (`burst-hot`, `burst-onsale`, `burst-limit`, `burst-id`), so repeated runs never clash. They stay in the database.


---


## 5. Health, metrics and logs (public access)

These work the same way on the live app and on your machine. Set the address once:

```bash
BASE=https://seat-reservation-7wrl.onrender.com     # or http://localhost:8080
```

### Health

- **Readiness: `GET /health`.** Runs `SELECT 1` on a small separate connection pool and answers **503** when the database can't be reached, so it fails closed. Because the pool is separate, a busy burst can't make it look unhealthy. It also reports `checks.redis` (`ok`, `down` or `disabled`). That is only information and never makes the check fail.
- **Liveness: `GET /health?probe=live`.** Answers 200 as long as the process is running, without touching any dependency. So a database outage stops traffic but never makes the platform restart a healthy process.

Render's health check uses `?probe=live`. Docker's uses the default.

### Metrics

```bash
curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total|reservations_cancelled_total)'
```

```
reservations_confirmed_total 1
reservations_declined_total{reason="seat_taken"} 1
```

What `/metrics` reports (Prometheus format):

- `reservations_confirmed_total`
- `reservations_declined_total{reason}` with the reasons `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_conflict`, `unknown_seat`
- `reservations_cancelled_total`
- Gauges `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` (with `show_id`), and `seats_reconciliation_drift{show_id}`, which **must be 0**. They are read from Postgres when scraped and cached for 1 second, so they always match the API.
- `seat_cache_declines_total` (declines answered by Redis, also counted in `reservations_declined_total`) and `seat_cache_errors_total` (Redis failures that fell through to Postgres)
- HTTP request count, latency and in-flight requests, and database pool gauges

Counters belong to one app instance and start at 0 when it starts.

### Seat counts

`GET /stats` shows the same seat numbers as the gauges, one line per show, newest first:

```bash
curl -s $BASE/stats
curl -s "$BASE/stats?format=json"
```

```
show="demo" id=7b296572-... total=3 available=2 held=0 confirmed=1 drift=0
```

To reconcile against the API, `available + held + confirmed` must equal `total_seats`:

```bash
curl -s "$BASE/shows/<show id>?seats=false"
```

### Logs

Logs are structured JSON, one line per request. Each line has `request_id`, `correlation_id`, `method`, `route`, `path`, `status`, `duration_ms`, `user_id` and `outcome` (`confirmed`, `seat_taken`, `idempotent_replay`, and so on). The same lines go to stdout.

`GET /logs` is public by default (if the service sets `LOGS_TOKEN`, add `-H "authorization: Bearer $LOGS_TOKEN"`):

```bash
curl -s "$BASE/logs?limit=20"
curl -s "$BASE/logs?limit=50000" > logs.ndjson
curl -s "$BASE/logs?level=warn"
curl -s "$BASE/logs?path=/reserve&limit=50"
curl -s "$BASE/logs?request_id=<id>"
curl -s "$BASE/logs?correlation_id=demo-flow-1"
```


Things to know:

- The `/logs` buffer belongs to one instance and is cleared when it restarts.
- On Render you can also open the service's **Logs** tab for a live view.
- Successful `/health` checks are not logged, to keep the log readable. A failing one is logged. They still count in `/metrics`.
- With several instances, `/metrics` and `/logs` answer for whichever instance got the request.

## 7. Deploy your own copy on Render
 
**Step 1. Get the code into your own GitHub account** (fork it, or clone it and push to a new repository):
 
```bash
git clone https://github.com/pijushrbiswas/seat-reservation-system.git
cd seat-reservation-system
git remote set-url origin https://github.com/<you>/seat-reservation-system.git
git push -u origin main
```
 
**Step 2. Create everything from the blueprint.** In the [Render dashboard](https://dashboard.render.com):
 
1. Click **New +**, then **Blueprint**.
2. Connect GitHub if asked, and choose your repository and the `main` branch.
3. Render reads `render.yaml` and lists three things to create: the web service `seat-reservation`, the Key Value store `seat-reservation-cache` (Redis-compatible) and the database `seat-reservation-db`. All use the free plan.
4. Click **Apply**.
Use **Blueprint**, not **Web Service**. A plain Web Service ignores `render.yaml`, so no database is created and the app stops with `DATABASE_URL is required`.
 
`JWT_SECRET` and `ADMIN_TOKEN` are generated for you, and the database and Redis addresses are filled in automatically.
 
**Step 3. Wait for the first deploy.** Open the service and its **Logs** tab. It takes a few minutes. It is ready when the status says **Live** and the logs show `database ready, migrations applied`.
 
**Step 4. Note your URL and admin token.**
 
- **URL:** at the top of the service page, for example `https://seat-reservation-xxxx.onrender.com`.
- **Admin token:** service, **Environment** tab, `ADMIN_TOKEN`, click the eye icon. Keep it out of the repo.
**Step 5. Check it works, then run the burst** as in [Run it against the live app](#4-one-command-burst), with your own `BASE` and `ADMIN_TOKEN` in `.env`:
 
```bash
curl -s -m 120 $BASE/health
SCALE=0.1 make burst
```

## 8. Make requests by hand

You can send a few requests yourself with any API tool, for example Postman, Insomnia, Bruno or the VS Code REST Client. Every address starts with `http://localhost:8080` or [Your BASE url]. For requests that have a body, choose JSON and set the header `Content-Type: application/json`.

The story: Alice books seat A1, then Bob tries to book the same seat and is told no.

**1. Get a login token for each user.** A token says who you are.

- Send a **POST** to `/auth/token` with the body `{"user_id": "alice"}`.
- The answer contains a `token`. Copy it. This is Alice's token.
- Do the same with `{"user_id": "bob"}` to get Bob's token.

**2. Create a show.** This is the admin's job, so it uses the admin token instead of a user token.

- Send a **POST** to `/shows` with the header `Authorization: Bearer dev-admin-token` or or `Authorization: Bearer [Your ADMIN_TOKEN]`.
- Body: `{"name": "demo", "seats": ["A1", "A2", "A3"], "price_paise": 25000}`.
- The answer contains the show's `id`. Copy it.

**3. Alice books seat A1.**

- Send a **POST** to `/shows/<the show id>/reserve` with the header `Authorization: Bearer <Alice's token>`.
- Optional header `x-correlation-id: demo-flow-1`. It tags every request of this story, so you can find them together in the logs.
- Body: `{"seats": ["A1"], "idempotency_key": "demo-1"}`.
- Expect **201** and `"status": "confirmed"`.

**4. Bob tries the same seat.**

- Send the same request, but with `Authorization: Bearer <Bob's token>` and a different key: `{"seats": ["A1"], "idempotency_key": "demo-2"}`.
- Expect **409** and `"code": "seat_taken"`.

**5. Look at the result.** Open a **GET** to `/shows/<the show id>`: seat A1 is `confirmed` and A2 and A3 are `available`. The counters and logs for these two requests are described in [section 5](#5-health-metrics-and-logs-public-access).

Good to know:

- The **idempotency key** is a label you choose for one booking attempt. Send the same key and the same seats again and you get the same booking back (**200**) instead of a second booking. Use a **new key for every new booking**. Reusing a key with different seats gives 409 `idempotency_key_conflict`.
- A user can hold at most 4 seats per show. A fifth gives 409 `per_user_limit`.
- To give a seat back, send a **POST** to `/reservations/<reservation id>/cancel` with the owner's token.
