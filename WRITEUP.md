# Write-up

## The atomic decision

The decision lives in one Postgres transaction, in `src/services/reservations.ts`. Lock order is fixed:

1. **Idempotency row** - `INSERT INTO idempotency_keys ... ON CONFLICT (user_id, key) DO NOTHING`.
2. **Per-user quota row** - one conditional upsert on `user_show_holdings (show_id, user_id)`:
   `held_count = held_count + n ... WHERE held_count + n <= limit`. Zero rows returned means over limit.
3. **Seat rows** - `SELECT ... FROM seats WHERE show_id = $1 AND label = ANY($2) ORDER BY label COLLATE "C" FOR UPDATE`,
   then the status check, then `UPDATE seats SET status='confirmed' ... WHERE status='available'` and the reservation insert.

Why a seat cannot be sold twice: a seat is one row, and `FOR UPDATE` makes every concurrent request for it queue on that
row lock. The loser is released only after the winner commits, re-reads the *committed* row under READ COMMITTED, sees
`confirmed`, and declines with 409. The final `UPDATE` is also guarded by `AND status = 'available'`, and it asserts that
the row count equals the number of seats. The schema backs this up: `seats_owner_consistent` requires a non-available
seat to have an owner and reservation, and `(show_id, label)` is the primary key. There is no read-then-write gap,
because the read takes the lock.

**Multi-seat and deadlock.** A request is all-or-nothing. Seats are de-duplicated and locked in one statement in a
canonical byte order (`COLLATE "C"`), and every transaction takes locks in the same global order (idempotency, quota,
seats). Two requests over overlapping seats therefore cannot wait on each other in a cycle. Cancel takes
reservation, then quota, then seats (sorted), which is consistent with reserve. As a backstop, `withTx` retries
`40P01` (deadlock) and `40001` a few times with jitter, so an unforeseen cycle costs latency, not a 500. Tests cover
opposite-order and overlapping multi-seat storms and reserve/cancel churn.

**Per-user limit.** Checked and taken atomically in step 2. Concurrent reserves by one user serialise on their quota
row, so 10 parallel requests at limit 4 end with exactly 4. Declines roll the whole transaction back, so a failed
request never leaks quota or seats. Cancel decrements the counter inside its transaction.

## Idempotency

The key is stored in `idempotency_keys` with primary key `(user_id, key)` (keys are per user, so one user cannot
collide with or probe another's), a SHA-256 of the canonical request (show id + sorted, de-duplicated seats), and
the `reservation_id` once created.

- **Exactly once:** the insert in step 1 is the first lock taken. A concurrent request with the same key blocks on the
  unique index until the first transaction finishes. If it committed, the second takes the replay path and returns the
  stored reservation with 200. Fifty parallel requests with one key produce one reservation (tested).
- **Same key, different body:** the stored hash differs, so 409 `idempotency_key_conflict`.
- **Declines don't consume the key:** the key row is part of the transaction, so a decline (for example `seat_taken`)
  rolls it back and the client may retry with the same key. Trade-off: a retry of a declined request re-evaluates and
  may now succeed, which is the behaviour I'd want for a buyer whose seat has just been cancelled by someone else.
- Replays are counted as `reservations_declined_total{reason="idempotent_replay"}`, as the brief lists it with the
  decline reasons, and do not increment `confirmed`.

## Holds and expiry

I chose the explicit model: `POST /reservations/{id}/cancel`, owner only. Reserving confirms immediately, since there
is no payment step in this service. Cancel locks the reservation row, returns the quota, locks the seats *that still
point at this reservation*, and frees them. Because the release is keyed on `reservation_id`, a cancel can never
free a seat that now belongs to someone else, and a repeated cancel is a no-op returning 200. A released seat is
immediately re-bookable. `held` exists in the state model and the invariant but is always 0; a timed-hold model would
add a `held_until` column and treat `held AND held_until < now()` as available inside the same conditional statement
(no sweeper needed for correctness).

## Consistency vs availability under a partition

Postgres is the only source of truth, and I chose consistency. If the app cannot reach the database, writes and reads
fail with 503 (`database unavailable`), never with a guess from a cache. `/readyz` fails closed so a load balancer
drains the instance; `/healthz` stays up so the platform does not restart-loop the process. Nothing in the service
caches seat state, so there is no stale "available" that could lead to a wrongful sale. The cost is that a database
outage takes the whole on-sale down. With a replicated Postgres, I would keep writes on the primary only and, on
failover, rely on the same row-lock and constraint guarantees (no app-level state to reconcile). Serving seat-map
reads from a replica would be an availability win with stale reads, which is acceptable because the reserve path
re-decides atomically.

## Observability (what would page me at 2am)

- **Page:** `seats_reconciliation_drift != 0` for any show (an invariant breach, treat as a Sev-1 and stop sales);
  `/readyz` failing for more than 1-2 minutes; 5xx ratio above ~1% (`http_requests_total{status=~"5.."}`); p99 of
  `http_request_duration_seconds` on `/shows/:id/reserve` above a few seconds for 5 minutes.
- **Ticket, not page:** `pg_pool_connections{state="waiting"}` persistently > 0 (pool saturation / undersized), the
  `seat_taken` share of requests (normal during an on-sale, informative), a sudden `idempotency_key_conflict` spike
  (buggy client), `reservations_confirmed_total` flat while traffic is high (something is wrong upstream).
- Every log line carries `request_id`, which is also returned in the `x-request-id` header and in error bodies, so a
  customer's failed request can be found with `GET /logs?request_id=...`. The burst tool compares metric deltas to
  what it observed, so the counters are verified against reality, not just emitted.

## AI usage

> **TODO (yours to complete - the brief asks for honesty and specifics):** state which parts you directed and which
> the assistant decided. What I can say from the repo history: the code and tests were written with an AI coding
> assistant; the design points above (lock order, quota upsert, idempotency-row-first, declines-roll-back-the-key,
> cancel keyed on `reservation_id`) are the ones you should be able to defend and modify live. The burst tool was
> run against the local containerised stack; a deployed run is yours to do.

## What I'd do next

- Deploy and run the burst against the public URL, keep the output and a log screen recording with the submission.
- Time-boxed holds plus a payment step (hold -> confirm), with the expiry handled inside the conditional update.
- Load numbers on a realistic instance size; tune `PG_POOL_MAX` and consider PgBouncer. The hot-seat path is a
  queue on one row lock, which is correct and fast enough for one seat, but 20k connections should sit in front of a
  pooler.
- A rate limiter / virtual waiting room in front of `/reserve` for extreme on-sales (the design notes in
  `requirements.txt` cover this), and SSE for live seat-map updates.
- Prometheus + alert rules checked in, and per-show rather than global gauges beyond the newest 20 shows.
- Real authentication (the demo `/auth/token` mints a token for any user id).
