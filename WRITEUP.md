# Write-up

A JSON service that sells assigned seats. It never sells a seat twice, never lets a user go over their limit, and never books a retried request twice, even when thousands of people go for the same seats at once.

## The big picture

```
buyer ──► API (stateless) ──► Redis      "who gets to try for this seat?"   (fast, expires by itself)
                          └─► Postgres   "who really owns this seat?"       (the source of truth)
```

**Redis is a fast doorman. Postgres is the judge.**

Redis lets exactly one request per seat go through to the database and turns the others away quickly. Postgres then makes the final, safe decision. So even if Redis is empty, down or wrong, a seat can never be sold twice.

---

## 1. The atomic decision

"Atomic" means one step that cannot be interrupted halfway. If two people ask for seat A12 at the same moment, the winner must be picked in one step. It must never be "check if it's free, then take it" as two steps, because both people could see "free".

There are two layers, and each one is atomic on its own.

### Layer 1: Redis (keeps the load off the database)

A **Lua script** runs on Redis as one uninterrupted step. For the requested seats it does this:

1. If any seat is already held or sold by someone else, take **nothing** and report which seats are taken.
2. Otherwise, hold **all** the seats at once, with an expiry time.

The first request to run the script gets the hold. Everyone else is told "taken" immediately (HTTP 409) and never touches the database. In the "500 people, one seat" test, 1 request goes on to Postgres and 499 are declined by Redis.

### Layer 2: Postgres (the final decision)

The winner runs **one database transaction**. Either all the steps succeed or none do:

1. Claim the idempotency key (see section 2).
2. Check and take the user's seat quota (the per-user limit).
3. **Lock the seat rows:** `SELECT ... FROM seats WHERE label IN (...) ORDER BY label COLLATE "C" FOR UPDATE`.
4. If every seat is `available`, insert the reservation and run `UPDATE seats SET status='confirmed' ... WHERE status='available'`. Then check that exactly the expected number of rows changed.

### Why there is no race

- **`FOR UPDATE` locks the row.** Anyone else who wants the same seat waits until the first transaction ends. Then they read the new value (`confirmed`) and are declined. There is no gap between "check" and "take", because the check itself takes the lock.
- **The final `UPDATE` has its own guard** (`WHERE status='available'`) and we verify the row count. Even if the lock were skipped by mistake, the update could not overwrite a sold seat.
- **The schema backs it up.** A seat is either `available` with no owner or `confirmed` with an owner, and a database constraint enforces that. `(show_id, label)` is the primary key.
- **Redis never sells a seat.** It can only say "no" or "you may try". If Redis is flushed or down, requests simply reach Postgres, which still decides correctly. I tested this by flushing Redis in the middle of a storm: still exactly one winner per seat.

### Multi-seat requests and deadlocks

**Behaviour: all-or-nothing.** If someone asks for `["A12","A13"]` and A13 is taken, they get nothing. The answer is a 409 that names the unavailable seat, and A12 stays free for others. This holds under concurrency because the seats are locked together in one statement, and in Redis by the all-or-none script.

**A deadlock** is two requests that each hold a lock the other one needs, so both wait forever. For example, request 1 wants A1 then A2, while request 2 wants A2 then A1.

**How I avoid it:** every request sorts its seats the same way (`COLLATE "C"`, plain byte order) and locks them in that order. Across the whole transaction, the lock order is always the same: idempotency row, then the user's quota row, then the seat rows. Cancel uses the same order. If everyone queues in the same order, nobody can end up waiting in a circle. As a safety net, the transaction helper retries up to 5 times if Postgres ever reports a deadlock.

### The per-user limit

Each `(show, user)` has one small counter row (`user_show_holdings`). Two statements:

```sql
INSERT ... (show_id, user_id, 0) ON CONFLICT DO NOTHING;     -- make sure the row exists
UPDATE ... SET held_count = held_count + n
 WHERE ... AND held_count + n <= limit;                     -- check and take in one step
```

If the update changes 0 rows, the user is over the limit and gets a clean 409. The `UPDATE` locks the row, so one user's parallel requests go one after another and each sees the previous total. Ten parallel requests with a limit of 4 end with exactly 4.

**Why not just count the user's reservations?** Counting and then inserting is a race. Two requests both count 3, both pass a limit of 4, and the user ends up with 5. I also tried `SELECT ... FOR UPDATE` on the reservations table, and my concurrency test failed, because the row being added doesn't exist yet, so there is nothing to lock. A counter row always exists, so it can be locked.

---

## 2. Idempotency

**The problem:** a response gets lost on the network. The buyer's app can't tell if the booking happened, so it retries. We must not book twice, and we must not tell the buyer "taken" for a seat that is already theirs.

**How it works:** every reserve request carries an idempotency key (the `Idempotency-Key` header or a body field). Think of it as a receipt number for that attempt.

**Where the key is stored**
- **Postgres, table `idempotency_keys`**, primary key `(user_id, key)`. Keys belong to a user, so two users can never collide. The row also stores a **hash of the request** (show + sorted seats) and, once done, the `reservation_id`.
- **Redis, a small marker** (`idem:...`, kept 24 hours) that only says "this key already succeeded". It is a shortcut, not the source of truth.

**How exactly-once is enforced:** inserting the key is the **first** thing the transaction does, using `INSERT ... ON CONFLICT (user_id, key) DO NOTHING`.
- New key: the insert works, so this request is the only one that goes ahead.
- Same key arriving at the same time: the unique index makes it **wait** until the first transaction finishes. Then it sees the key exists and returns the stored result. Fifty parallel requests with one key produce exactly one reservation (tested).
- A declined attempt rolls back, including the key. So a declined request does not "use up" the key, and the buyer can try again later.

**What a retry returns (a "replay"):** the original reservation, with HTTP **200** and the header `Idempotent-Replayed: true`. Nothing new is booked. Without this, the retry would hit "seat taken" (the seat is now the buyer's own) and the buyer would wrongly think they failed.

**Same key, different body:** if the key is reused but the request hash differs (for example, different seats), that is a client bug. We answer **409 `idempotency_key_conflict`**. We never quietly return a reservation for different seats.

**How Redis fits in:** when Redis already knows a key succeeded, it steps aside ("bypass") so Postgres can return the replay. Otherwise Redis would decline the retry as "seat taken".

---

## 3. Holds and expiry

**The model: a time-boxed hold that lives only in Redis, plus an explicit cancel.**

- **A hold is a Redis lock with a time limit.** When a request wins a seat, it holds it for `SEAT_HOLD_SECONDS` (5 minutes). If the request dies, the hold **expires by itself** and the seat is free again. No cleanup job and no database write.
- **Postgres does not store "held".** There, a seat is only `available` or `confirmed`.
- **How "held" is shown:** Redis keeps a **sorted set** of held seats, scored by each seat's expiry time. When someone calls `GET /shows/{id}`, expired entries are dropped. A seat shows as `held` only if Postgres says it is `available` **and** it is in the set. So a sold seat can never show as held, and `available + held + confirmed = total` always adds up.
- **In practice holds are short.** There is no payment step, so the request confirms in Postgres right after winning. The hold only covers that small gap, and then it is released or turned into a "confirmed" marker.
- **Explicit release:** `POST /reservations/{id}/cancel`, owner only. It frees the seats and gives the quota back. It only frees seats that still belong to **that** reservation, so it can never free a seat now owned by someone else. Cancelling twice does nothing. A freed seat can be booked again straight away.

**Trade-off:** if a winner crashes after taking a hold but before releasing it, that seat is blocked for up to 5 minutes. Normal failure paths release it immediately.

---

## 4. Consistency vs availability under a partition

A "partition" means one part of the system can't reach another.

**I chose consistency for the database and availability for Redis.**

| What breaks | What happens | Why |
|---|---|---|
| **Postgres unreachable** | Reserve and show requests return **503**. `/health` (the default readiness probe) fails, so the load balancer stops sending traffic. `/health?probe=live` stays up so the platform doesn't restart-loop the app. | Better to refuse than to guess. We never sell a seat from a cache. |
| **Redis unreachable or flushed** | The service **keeps working**, just slower on hot seats. Calls time out fast (300 ms, no queue), so requests go straight to Postgres. `/health` stays healthy and reports `redis: down`. | Redis can only decline, never sell, so losing it can't cause a double-sale. Tested with 300 parallel requests on one seat while Redis was down: 1 winner, 299 clean 409s, zero 5xx. |

The worst thing Redis can do when it is wrong is **wrongly decline** someone for a short time (a stale "taken" marker lives at most 30 seconds). It can never cause a wrong sale.

The cost of this choice: if Postgres is down, the on-sale is down. With a replicated Postgres I would keep writes on the primary only, and could serve seat-map reads from a replica, because the reserve path re-checks everything anyway.

---

## 5. Observability (what would wake me at 2am)

**What the service exposes**
- `GET /health` is the one health endpoint. By default it is the readiness probe: it checks Postgres on its own small connection pool, so a busy burst can't make it look dead, and it fails closed with 503. `GET /health?probe=live` is the liveness probe (the process is up, no dependency checked).
- `GET /metrics` (Prometheus format):
  - `reservations_confirmed_total`
  - `reservations_declined_total{reason}` with reasons `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_key_conflict`, `unknown_seat`
  - `reservations_cancelled_total`
  - `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` and `seats_reconciliation_drift` per show, for every show (`METRICS_MAX_SHOWS` can cap it to the newest N)
  - HTTP request counts, latency and in-flight requests, Postgres pool state, and Redis counters (`seat_cache_declines_total`, `seat_cache_errors_total`)
- **Logs:** structured JSON, one line per request. Each line has two ids: a `request_id` (this one HTTP call) and a `correlation_id` (the whole flow, taken from the caller's `x-correlation-id` so it stays the same across services, or generated if absent). Both come back in response headers and in error bodies. `GET /logs?request_id=...` finds a buyer's failed request, and `GET /logs?correlation_id=...` finds every call of a flow. When `NEW_RELIC_LICENSE_KEY` is set, every log line and every metric is also shipped to New Relic (logs: batched, compressed, retried, bounded queue; metrics: counter increases every 15 seconds, nothing lost on a failed send; both flushed on shutdown), so they can be searched, charted and alerted on there and survive restarts. A New Relic outage never affects requests.

**How the numbers stay honest:** the seat gauges are not kept in memory. They are read from Postgres (plus Redis for held seats) when scraped, so they always match the API. The burst tool compares the counters with what it actually observed, and they match exactly.

**Page me (wake me up)**
- `seats_reconciliation_drift != 0`: the core invariant is broken. Stop sales.
- `/health` failing for more than 1 to 2 minutes.
- 5xx responses above about 1% of traffic.
- p99 latency of reserve above a few seconds for 5 minutes.

**Ticket, not page (look at it tomorrow)**
- `pg_pool_connections{state="waiting"}` stays above 0 (the connection pool is too small).
- `seat_cache_errors_total` rising, or `redis: down` (still correct, just slower).
- A sudden rise in `idempotency_key_conflict` (a buggy client).
- Lots of `seat_taken` is normal during an on-sale.

---

## 6. AI usage

**Short version: I did the analysis and the design. The AI built the infrastructure and typed out code to my design.**

### What I did: analysis and design

Everything that decides whether the service is correct came from me. Here is how I worked through it.

**1. I started from what breaks under load.**
I listed the three things the graders would hit: many people on one hot seat, one user firing parallel requests, and retried requests. For each one I asked "where does the decision have to happen, so that nobody can slip in between a check and a write?" I also asked what fails first at on-sale time. My answer was the database. If 500 requests line up on one row lock, each holds a connection, and the pool backs up for everyone, even people buying other seats.

**2. I chose the two-layer design (Redis doorman, Postgres judge).**
- The request that wins a seat's lock in Redis is the only one that goes on to the database. Everyone else is declined straight away, to protect the database.
- Redis is never trusted to sell. Postgres makes the final decision, so Redis can fail safely.

**3. I designed how "held" works.**
- "Held" lives **only in Redis**, with an expiry. Postgres only knows `available` and `confirmed`.
- I spotted that a plain Redis set would leave **ghost entries**: set members don't expire when the lock key does, so every abandoned checkout would show its seat as reserved forever. So I chose a **sorted set scored by expiry time**. A seat is "held" when Postgres says it is available and the set has an unexpired entry for it.
- I set the hold to 5 minutes.

**4. I designed the database locking.**
- Row locks (`SELECT ... FOR UPDATE`) are the real decision, taken in one fixed order, together with a guarded `UPDATE ... WHERE status='available'` and a row-count check.
- I worked out that the lock order must be the same in the app and in SQL, which is why seats are sorted with `COLLATE "C"`, and why the order across tables is always idempotency row, then quota row, then seat rows.
- I chose all-or-nothing for multi-seat requests and made sure it also holds in the Redis script.

**5. I designed the per-user limit.**
I reasoned that counting rows and then inserting is a race. I asked whether `SELECT ... FOR UPDATE` on the reservations table or an insert-on-conflict could replace a separate counter table. We tried the variants and my concurrency test showed the `FOR UPDATE` version let users go over the limit, so I kept the counter-row design.

**6. I designed idempotency.**
The key is claimed first, inside the transaction, and stored per user with a hash of the request. A retry returns the original reservation (200 with a replay header), a different body on the same key is a 409, and a declined attempt rolls back so it does not burn the key. I also decided Redis should step aside for known keys so a retry is not wrongly declined as "seat taken".

**7. I decided how failures behave.**
Redis down means fail open to Postgres (slower, still correct). Postgres down means fail closed with 503. Readiness uses its own small pool so a burst can't make the service look dead.

**8. I set the code quality rules.**
SQL lives in named constants, not inline. Repository and cache code is separate from services. Metrics are decoupled from business code through events. Infrastructure is organised in layered folders with clear function names, and everything has JSDoc.

**9. I decided the scale approach.**
- Only one request per seat ever reaches Postgres.
- Held seats expire on their own, with no cleanup job and no extra writes.
- The app holds no seat state in memory, so more instances can be added behind a load balancer.
- Redis calls have a short timeout and no queue, so a slow Redis can't stall requests.

### What the AI did

The AI wrote the infrastructure and the plumbing: the server setup, Dockerfile and compose files, the Render config, database migration setup, the logging (structured logs, request ids, the `/logs` endpoint), the metrics (Prometheus counters and gauges), the test harness and burst tool, and the docs. It also typed out application code that follows the design above and did mechanical refactors such as renames and moving files. It helped with debugging too, for example finding a test config that was being ignored and a retry case that could leave a stale Redis hold. I then reviewed that code against my design.

### How I checked it

I did not take correctness on trust. I ran concurrency tests (hot-seat storms, parallel requests from one user, many retries with one key), Redis-failure tests (flush and stop Redis in the middle of a storm), and expiry tests. A 20,000-request stampede on my laptop gave zero 5xx, with roughly three quarters of requests (all the "seat taken" ones) answered by Redis alone at about 5,000 requests per second.

**Honest note:** the first version was Postgres-only. I then added the Redis layer following my design. The numbers above are from local Docker runs, not from the deployed instance.

---

## 7. What I would do next

- **Deploy and run the burst against the public URL.** Keep the output and a screen recording of the live logs with the submission.
- **Get load numbers on a realistic instance.** Tune the database pool size (`PG_POOL_MAX`), and add **PgBouncer** (a connection pooler) if I run several app instances, because each instance's connections add up against Postgres's limit. Migrations would bypass it because they use a session-level lock.
- **Put alerts in the repo.** Check in a Prometheus config and alert rules for the "page me" list above, so they can be loaded and tested.
- **Per-show metrics at large scale.** Every show is reported now, which is fine for hundreds or a few thousand shows; past that, report only active shows (or roll old ones up) to keep the number of metric series, and the cost of the stats query, in check.
- **Add a payment step.** Split reserve into "hold" and a separate "confirm" call, so the 5-minute hold does real work for the buyer, with an "extend hold" option for slow payments.
- **Protect the front door for extreme on-sales** with a rate limiter or a virtual waiting room, and add live seat-map updates (server-sent events).
- **Harden Redis** by running it replicated or as a cluster. The keys already use `{showId}` hash tags for this.
- **Use real authentication.** The demo `/auth/token` hands a token to any user id and should be replaced by a real identity provider.