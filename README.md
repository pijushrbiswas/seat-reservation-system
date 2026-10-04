# Seat Reservation at Scale

A JSON service that sells assigned seats. It never sells a seat twice, never lets a user go over their limit, and never books a retried request twice, even when thousands of buyers hit the same seats at once. Fastify + TypeScript on PostgreSQL, with Redis in front to keep the load off the database. The design is explained in [WRITEUP.md](WRITEUP.md).

**Live app:** https://seat-reservation-7wrl.onrender.com

This guide covers four things, in order:

1. [Run the burst script against the deployed app](#1-run-the-burst-script-against-the-deployed-app)
2. [Deploy your own copy on Render](#2-deploy-your-own-copy-on-render)
3. [Watch metrics and logs locally](#3-watch-metrics-and-logs-locally)
4. [Watch metrics and logs in New Relic, and set up the dashboard](#4-new-relic-logs-metrics-and-dashboard)

---

## 1. Run the burst script against the deployed app

The burst script sends the on-sale stampede to a running service and checks that nothing broke. You need **Git** and **Node 20 or newer** (`node -v`).

**Step 1. Clone and install.**

```bash
git clone https://github.com/pijushrbiswas/seat-reservation-system.git
cd seat-reservation-system
make install
```

**Step 2. Tell the script where the app is and how to create shows.** Create a file named `.env` in the project folder with these two lines. The file is git-ignored, so the token is never committed.

```
BASE=https://seat-reservation-7wrl.onrender.com
ADMIN_TOKEN=<the ADMIN_TOKEN of the deployed service>
```

**Step 3. Load the two values into your terminal** (do this once in every new terminal window):

```bash
set -a
source .env
set +a
echo $BASE
```

`echo` should print the address.

**Step 4. Check the app is awake.** The free Render plan sleeps when idle, so the first request can take up to a minute:

```bash
curl -s -m 120 $BASE/health
```

Expect `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`.

**Step 5. Look at the live app before you start.** These three commands show the state you are starting from. They are plain `curl` calls to your deployed app (the address comes from `BASE` in your `.env`):

```bash
curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total|reservations_cancelled_total|seat_cache_declines_total)'
curl -s $BASE/stats
curl -s "$BASE/logs?limit=5"
```

- The first prints the counters. They count what the app has handled since it last started, so after a cold start, or after the free plan has slept and woken up, they are all `0`.
- The second prints one line per show. It says `no shows yet` on a fresh database.
- The third prints the last 5 log lines (JSON, one per line).

**Step 6. Run a small burst first, then the full one.**

```bash
SCALE=0.1 make burst
make burst
```

`SCALE=0.1` is a tenth of the full load. The full run sends 20,000 requests, which takes a few minutes on the free plan.

To watch the numbers move while it runs, open a **second terminal**, go to the project folder, load `.env` again (`set -a`, `source .env`, `set +a`) and run:

```bash
while true; do curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total\{reason="seat_taken"\})'; echo; sleep 2; done
```

Press `Ctrl+C` to stop it.

**Step 7. Look at the result on the live app.** Run these after the burst finishes.

Counters. Everything the burst sent is accounted for here, split by outcome:

```bash
curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total|reservations_cancelled_total|seat_cache_declines_total)'
```

For `SCALE=0.1` you should see numbers of this kind (yours vary a little because the load is random):

```
reservations_confirmed_total 398
reservations_declined_total{reason="seat_taken"} 1589
reservations_declined_total{reason="per_user_limit"} 8
reservations_declined_total{reason="idempotent_replay"} 48
reservations_declined_total{reason="idempotency_key_conflict"} 20
reservations_cancelled_total 1
seat_cache_declines_total 1589
```

`seat_cache_declines_total` is the number of `seat_taken` answers that Redis gave without the database being involved.

The shows the burst created, with their seat counts. `drift=0` on every line means `available + held + confirmed` equals `total`:

```bash
curl -s $BASE/stats | grep '^show="burst-'
```

```
show="burst-onsale-1fe2317c" id=0f095f6e-... total=500 available=87 held=0 confirmed=413 drift=0
show="burst-hot-1fe2317c" id=0a60bbfc-... total=100 available=99 held=0 confirmed=1 drift=0
```

Each burst run adds four shows (`burst-hot`, `burst-onsale`, `burst-limit`, `burst-id`), newest first. The numbers can lag by about a second.

Logs. The last lines, then the ones that matter:

```bash
curl -s "$BASE/logs?limit=20"
curl -s "$BASE/logs?limit=50000" | grep -c '"outcome":"seat_taken"'
curl -s "$BASE/logs?limit=50000" | grep -c '"status":5'
curl -s "$BASE/logs?level=warn&limit=50000"
curl -s "$BASE/logs?path=/reserve&limit=1" | python3 -m json.tool
```

In order: the last 20 lines; how many bookings were declined as `seat_taken`; how many 5xx responses there were (this should print `0`); any warnings or errors; and one reserve call shown in full. A log line looks like this:

```json
{"level":"info","time":"2026-10-04T06:21:50.520Z","service":"seat-reservation","request_id":"4977ae12-...","correlation_id":"b7f853be-...","method":"POST","route":"/shows/:id/reserve","path":"/shows/65651b4b-.../reserve","status":201,"duration_ms":1.65,"user_id":"id-1fe2317c-1","outcome":"confirmed","msg":"request completed"}
```

To find one specific call, use the `request_id` you see in a log line or in an error response:

```bash
curl -s "$BASE/logs?request_id=<the id>"
```

Notes for the live app:

- The log buffer holds the last 50,000 lines (`LOG_BUFFER_LINES`) and is emptied whenever Render restarts the app. For the full history, open the service's **Logs** tab in the Render dashboard, or use New Relic (section 4).
- Calls to `/health`, `/metrics` and `/logs` are not written to the log, so the logs show only real traffic.
- If the service runs more than one instance, `/metrics` and `/logs` answer for whichever instance received the request.

**What it does and what you should see.** The script runs four phases, prints the outcome counts and latency for each, and ends with `all checks passed`. The exit code is non-zero if any check fails.

| Phase | What it does | What must hold |
|---|---|---|
| 1. Hot seat | 500 users all try seat A12 | Exactly one `confirmed`, 499 clean `seat_taken`, no 5xx |
| 2. On-sale stampede | 20,000 requests, 5,000 users, half aimed at 10 hot seats, with retries and conflicting keys | No 5xx, no seat sold twice, nobody above their limit, `available + held + confirmed == total` during and after, metrics match what it observed |
| 3. Per-user limit | One user fires 10 parallel reserves (limit 4) | Exactly 4 succeed |
| 4. Identity and cancel | Spoofed user id, foreign cancel, cancel then re-book, repeated cancel | Each handled correctly |

### Burst settings

You can change how big the burst is by putting settings in front of the command, for example `SCALE=0.1 make burst`. Every setting is optional.

| Setting | Default | Sample | What it controls |
|---|---|---|---|
| `SCALE` | `1` | `0.1` | A shortcut that shrinks or grows the four sizes marked * below. `0.1` is a tenth of the full load, `0.5` is half. It does not change `HOT_SEATS` or `CONCURRENCY`. |
| `HOT_USERS` * | `500` | `200` | Phase 1: how many users all try to book the **same single seat** (A12) at the same moment. One must win, the rest must get a clean `seat_taken`. |
| `USERS` * | `5000` | `1000` | Phase 2: how many different users take part in the stampede. More users means more people competing, and the per-user limit of 4 seats is checked for each. |
| `REQUESTS` * | `20000` | `5000` | Phase 2: the total number of reserve requests sent. This includes retries with the same key and deliberately conflicting keys. |
| `SEATS` * | `5000` | `1000` | Phase 2: how many seats the show has. Fewer seats with the same requests means more competition and more `seat_taken`. |
| `HOT_SEATS` | `10` | `5` | Phase 2: how many of those seats are "popular". Half of all requests are aimed at these seats only, so a smaller number means a more intense fight over fewer seats. It can't be more than `SEATS`. |
| `CONCURRENCY` | `1000` | `200` | The most requests the script keeps in flight at once. Lower it if the app is small or the network is slow (the free Render plan copes better with around `100` to `200`). |
| `BASE_URL` | `BASE`, else `http://localhost:8080` | `https://my-app.onrender.com` | Which app to test. `make burst` takes it from the `BASE` in your `.env`. |
| `ADMIN_TOKEN` | `dev-admin-token` | `<your admin token>` | The admin password the script uses to create its test shows. On a deployed app this must be that app's real token. |

Things to know:

- **Sizes you set yourself are used as given.** `SCALE` only changes the defaults. With `SCALE=0.1 USERS=1000`, `USERS` is 1000 while `HOT_USERS`, `REQUESTS` and `SEATS` are a tenth of their defaults.
- **Phase 3 and phase 4 don't change.** Phase 3 always uses one user with 10 parallel reserves against a limit of 4, and phase 4 is a fixed set of checks.
- **Each request asks for 1 or 2 seats**, and a user can hold at most 4 per show. If `USERS` is small compared with `SEATS`, some seats stay unsold because the users hit their limit first. That's expected.
- **Every run creates new shows** named `burst-...`, so repeated runs never clash. They stay in the database.

Sample commands (set the variables in front, and leave out anything you don't want to change):

```bash
SCALE=0.1 make burst
```

A tenth of the full load: 50 users on one seat, then 2,000 requests from 500 users over 500 seats. A good first run against a deployed app.

```bash
SCALE=0.3 CONCURRENCY=200 make burst
```

About a third of the load, sent more gently, 200 at a time. Good for the free Render plan.

```bash
HOT_USERS=200 USERS=1000 REQUESTS=5000 SEATS=1000 HOT_SEATS=5 CONCURRENCY=200 make burst
```

Every size chosen by hand: 200 users on one seat, then 5,000 requests from 1,000 users over 1,000 seats, half of them aimed at just 5 seats.

```bash
SEATS=200 HOT_SEATS=2 USERS=500 REQUESTS=3000 HOT_USERS=100 make burst
```

A very contended run: 3,000 requests over only 200 seats, with half the traffic on 2 of them. Expect many `seat_taken` outcomes and most of the show selling out.

```bash
make burst
```

The full load: 500 users on one seat, then 20,000 requests from 5,000 users over 5,000 seats.

---

## 2. Deploy your own copy on Render

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
4. It asks for `NEW_RELIC_LICENSE_KEY`. Paste your key to send logs and metrics to New Relic (see [section 4](#4-new-relic-logs-metrics-and-dashboard)), or leave it empty.
5. Click **Apply**.

Use **Blueprint**, not **Web Service**. A plain Web Service ignores `render.yaml`, so no database is created and the app stops with `DATABASE_URL is required`.

`JWT_SECRET` and `ADMIN_TOKEN` are generated for you, and the database and Redis addresses are filled in automatically.

**Step 3. Wait for the first deploy.** Open the service and its **Logs** tab. It takes a few minutes. It is ready when the status says **Live** and the logs show `database ready, migrations applied`.

**Step 4. Note your URL and admin token.**

- **URL:** at the top of the service page, for example `https://seat-reservation-xxxx.onrender.com`.
- **Admin token:** service, **Environment** tab, `ADMIN_TOKEN`, click the eye icon.

**Step 5. Check it works, then run the burst** as in section 1, with your own `BASE` and `ADMIN_TOKEN` in `.env`:

```bash
curl -s -m 120 $BASE/health
SCALE=0.1 make burst
```

**If something fails:**

| Symptom | Fix |
|---|---|
| `DATABASE_URL is required` | The service was not created from the Blueprint. Delete it and create it again with **Blueprint**. |
| Deploy never goes Live, health check fails | In the service **Settings**, change the health check path from `/health?probe=live` to `/health`. |
| First request is slow | The free plan wakes up after idling. Wait up to a minute. |
| 401 or 403 when creating shows | Wrong `ADMIN_TOKEN`; copy it again from the Environment tab. |

The free Postgres database is deleted after 30 days, so recreate it (or use a paid plan) for anything longer.

---

## 3. Watch metrics and logs locally

This runs the whole stack on your machine and shows its endpoints with `curl`. You need **Docker**. Node 20 or newer is only needed if you also run the burst.

**Step 1. Start the stack.**

```bash
git clone https://github.com/pijushrbiswas/seat-reservation-system.git
cd seat-reservation-system
make up
```

This starts Postgres, Redis and the app on http://localhost:8080. Stop it with `make down`, which also deletes the data.

**Step 2. Point your terminal at it.** These two variables override anything loaded from `.env` earlier in the same terminal:

```bash
export BASE=http://localhost:8080
export ADMIN_TOKEN=dev-admin-token
```

**Step 3. Check health.**

```bash
curl -s $BASE/health
curl -s "$BASE/health?probe=live"
```

The first answers `{"status":"ready","checks":{"database":"ok","redis":"ok"}}` and turns into a 503 if the database is down. The second only says the process is alive.

**Step 4. Make some traffic.** Either run the burst:

```bash
make install
SCALE=0.1 make burst
```

or make a few requests by hand. This creates a show, books a seat for one user, and shows a second user losing the same seat:

```bash
RUN=$(date +%s)
tok() { curl -s -X POST $BASE/auth/token -H 'content-type: application/json' -d "{\"user_id\":\"$1\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
ALICE=$(tok alice)
BOB=$(tok bob)
SHOW=$(curl -s -X POST $BASE/shows -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"demo","seats":["A1","A2","A3"],"price_paise":25000}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X POST $BASE/shows/$SHOW/reserve -H "authorization: Bearer $ALICE" -H 'x-correlation-id: demo-flow-1' -H 'content-type: application/json' -d "{\"seats\":[\"A1\"],\"idempotency_key\":\"demo-$RUN-1\"}"
curl -s -X POST $BASE/shows/$SHOW/reserve -H "authorization: Bearer $BOB" -H 'x-correlation-id: demo-flow-1' -H 'content-type: application/json' -d "{\"seats\":[\"A1\"],\"idempotency_key\":\"demo-$RUN-2\"}"
```

The first reserve returns **201 `confirmed`** and the second **409 `seat_taken`**. Use a new `idempotency_key` for every new booking: reusing a key with different seats gives 409 `idempotency_key_conflict`.

### Metrics

Counters, in the Prometheus text format (one value per line):

```bash
curl -s $BASE/metrics | grep -E '^(reservations_confirmed_total|reservations_declined_total|reservations_cancelled_total)'
```

```
reservations_confirmed_total 1
reservations_declined_total{reason="seat_taken"} 1
```

The decline reasons are `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_conflict` and `unknown_seat`. Counters are per app instance and start at 0 when it starts.

Seats for your show (available, held, confirmed, total, and the drift, which must be 0):

```bash
curl -s $BASE/metrics | grep "show_id=\"$SHOW\""
```

The same seat numbers in a readable form, one line per show, newest first:

```bash
curl -s $BASE/stats
curl -s "$BASE/stats?format=json"
```

```
show="demo" id=7b296572-... total=3 available=2 held=0 confirmed=1 drift=0
```

Check the numbers against the API: `available + held + confirmed` must equal `total_seats`.

```bash
curl -s "$BASE/shows/$SHOW?seats=false"
```

### Logs

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

In order: the last 20 lines (the default is 200); everything the app still remembers, saved to a file; only warnings and errors; one route; one HTTP call (its id is in the `x-request-id` response header and in error bodies); every call of one flow; a line pretty-printed; and the live container output.

Each request line is JSON with `request_id`, `correlation_id`, `method`, `route`, `path`, `status`, `duration_ms`, `user_id` and `outcome` (`confirmed`, `seat_taken`, `idempotent_replay`, and so on). The app keeps the last 50,000 lines in memory (`LOG_BUFFER_LINES`). The buffer is cleared when the app restarts.

The same `curl` commands work on the deployed app: set `BASE` to its URL.

---

## 4. New Relic: logs, metrics and dashboard

When you give the app a New Relic key, it sends every log line and every metric there in the background. A slow or unreachable New Relic never affects requests.

### Step 1. Get the key

In New Relic, open the **API keys** page and create (or copy) a key of type **Ingest - License**. A user key (starting `NRAK`) does not work for sending data.

### Step 2. Give the app the key

**Locally.** Add it to the `.env` file (Docker Compose reads it), then restart:

```
NEW_RELIC_LICENSE_KEY=<your ingest license key>
```

```bash
make up
```

EU accounts also add `NEW_RELIC_REGION=eu`.

**On Render.** Open the service, go to **Environment**, add `NEW_RELIC_LICENSE_KEY`, and save. Render redeploys.

**Check it is on.** The app logs one line for each at startup:

```bash
curl -s "$BASE/logs?limit=200" | grep -i "new relic"
```

You should see `sending logs to New Relic` and `sending metrics to New Relic`. If not, the key was not picked up: check the spelling and restart. Now make some traffic (section 3, step 4) and wait a minute or two.

### Step 3. See the logs

1. Go to **one.newrelic.com** and open **Logs** in the left menu. Use the account that owns the key.
2. Set the time picker (top right) to **Last 30 minutes**.
3. Search for `service:seat-reservation`.

More searches:

| To find | Search |
|---|---|
| One HTTP call | `request_id:<id>` |
| One whole flow | `correlation_id:demo-flow-1` |
| Declined bookings | `outcome:seat_taken` |
| Server errors | `status:>=500` |
| Slow requests | `duration_ms:>500` |

### Step 4. See the metrics

Open **Query your data**, paste a query, and press **Run**. The metric names are the same as on `/metrics`.

| What you want | Query |
|---|---|
| Bookings confirmed | `FROM Metric SELECT sum(reservations_confirmed_total) TIMESERIES SINCE 1 hour ago` |
| Declines by reason | `FROM Metric SELECT sum(reservations_declined_total) FACET reason SINCE 1 hour ago` |
| Seats left per show | `FROM Metric SELECT latest(seats_available) FACET show_id SINCE 10 minutes ago LIMIT MAX` |
| The invariant (must be 0) | `FROM Metric SELECT max(seats_reconciliation_drift) SINCE 1 hour ago` |
| Declines answered by Redis | `FROM Metric SELECT sum(seat_cache_declines_total) TIMESERIES SINCE 1 hour ago` |
| Requests by status | `FROM Metric SELECT sum(http_requests_total) FACET status TIMESERIES SINCE 1 hour ago` |
| Average reserve latency (seconds) | `FROM Metric SELECT sum(http_request_duration_seconds_sum) / sum(http_request_duration_seconds_count) WHERE route = '/shows/:id/reserve' TIMESERIES SINCE 1 hour ago` |

Names ending in `_total` are counters, so use `sum(...)`. The seat values are current numbers, so use `latest(...)`.

### Step 5. Set up the dashboard

The repository has a ready-made dashboard in `observability/newrelic-dashboard.json`, with three pages: reservations, service health and logs.

**1. Find your New Relic account id.** It is a number, usually visible in the New Relic page address as `account=<number>`.

**2. Put it into the file and copy the result to the clipboard:**

```bash
ACCOUNT_ID=<your account id>
python3 -c "import json;d=json.load(open('observability/newrelic-dashboard.json'));[q.update(accountId=int('$ACCOUNT_ID')) for p in d['pages'] for w in p['widgets'] for q in w['rawConfiguration']['nrqlQueries']];print(json.dumps(d))" | pbcopy
```

`pbcopy` works on macOS. On Linux, send the output to a file instead (replace `| pbcopy` with `> dashboard.json`) and copy that file's contents.

**3. Import it.** In New Relic open **All capabilities**, then **Dashboards**, click **Import dashboard**, paste, choose your account, and click **Save**.

If a chart is empty, make some traffic and widen the time range. The seat table and the drift number need at least one show.

### Alerts (optional)

Open **Alerts**, then **Alert conditions**, then **New alert condition**, choose **Write your own query**, and use one of these:

| Alert | Query | Threshold |
|---|---|---|
| Seat invariant broken | `FROM Metric SELECT max(seats_reconciliation_drift)` | above 0 for 1 minute |
| Server errors | `FROM Metric SELECT sum(http_requests_total) WHERE status LIKE '5%'` | above 5 for 5 minutes |
| Redis trouble | `FROM Metric SELECT sum(seat_cache_errors_total)` | above 0 for 5 minutes |

### If nothing shows up in New Relic

- Make sure you are in the account that owns the key (use the account picker at the top).
- Run `FROM Log SELECT count(*) SINCE 1 hour ago` in **Query your data**. A number above 0 means logs arrive and only the Logs page filter is wrong.
- Check for rejections: `docker compose logs app | grep -i newrelic` locally, or the Render **Logs** tab. A line such as `New Relic rejected ... status 403` means the key is wrong or is not an Ingest - License key.
- EU accounts need `NEW_RELIC_REGION=eu`.
