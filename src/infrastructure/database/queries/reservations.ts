import { prepared } from "./statement.js";

/**
 * SQL for reserving, cancelling and replaying reservations.
 *
 * Lock order inside the reserve transaction is fixed: idempotency row, the user's quota row, then seat rows (sorted).
 * Cancel takes its reservation row, the quota row, then seat rows (sorted). Consistent orders prevent deadlocks.
 * Every statement is named so Postgres prepares it once per connection.
 */

/**
 * Claims an idempotency key. $1 user, $2 key, $3 show, $4 request hash.
 * Zero rows inserted means the key was already used (go to the replay path).
 */
export const CLAIM_IDEMPOTENCY_KEY = prepared(
  "claim_idempotency_key",
  `
  INSERT INTO idempotency_keys (user_id, key, show_id, request_hash)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (user_id, key) DO NOTHING`,
);

/** Finds the original reservation behind an already-used key, plus the hash of the request that created it. $1 user, $2 key. */
export const SELECT_ORIGINAL_RESERVATION_BY_KEY = prepared(
  "select_original_reservation_by_key",
  `
  SELECT k.request_hash, r.id, r.show_id, r.user_id, r.seats, r.amount_paise, r.status
    FROM idempotency_keys k
    JOIN reservations r ON r.id = k.reservation_id
   WHERE k.user_id = $1 AND k.key = $2`,
);

/**
 * Checks and takes the per-user quota in one statement: creates the `(show, user)` counter row if needed, otherwise adds to it.
 * The row lock taken by the conflict path makes one user's concurrent reserves run one after another, and the limit is re-checked
 * against the latest committed count. Zero rows affected means the user would exceed the limit.
 * $1 show id, $2 user id, $3 seats wanted, $4 per-user limit.
 */
export const TAKE_USER_QUOTA = prepared(
  "take_user_quota",
  `
  INSERT INTO user_show_holdings AS h (show_id, user_id, held_count)
  SELECT $1::uuid, $2::text, $3::int
   WHERE $3::int <= $4::int
  ON CONFLICT (show_id, user_id) DO UPDATE
     SET held_count = h.held_count + EXCLUDED.held_count
   WHERE h.held_count + EXCLUDED.held_count <= $4::int`,
);

/** Gives seats back to the user's quota when a reservation is cancelled. $1 show id, $2 user id, $3 seat count. */
export const RELEASE_USER_QUOTA = prepared(
  "release_user_quota",
  `
  UPDATE user_show_holdings
     SET held_count = held_count - $3
   WHERE show_id = $1 AND user_id = $2`,
);

/**
 * The decision point, in one statement. Locks the available requested seats in a fixed byte order (so concurrent requests queue on
 * the row lock and cannot deadlock). Only if every requested seat was locked does it flip them to confirmed, insert the reservation and
 * attach it to the idempotency key; otherwise it changes nothing. A seat that another transaction confirmed while we waited for its
 * lock is re-checked by Postgres and skipped. The foreign keys are checked at the end of the statement, so the inserts and updates
 * may appear in any order inside it.
 * Returns `created` (1 when the whole request was won) and `won`, the labels that were available and locked.
 * $1 show id, $2 sorted labels, $3 reservation id, $4 user id, $5 amount in paise, $6 idempotency key.
 */
export const RESERVE_SEATS = prepared(
  "reserve_seats",
  `
  WITH locked AS (
    SELECT label
      FROM seats
     WHERE show_id = $1::uuid AND label = ANY($2::text[]) AND status = 'available'
     ORDER BY label COLLATE "C"
       FOR UPDATE
  ), confirmed AS (
    UPDATE seats s
       SET status = 'confirmed', reservation_id = $3::uuid, user_id = $4::text
      FROM locked l
     WHERE s.show_id = $1::uuid AND s.label = l.label
       AND (SELECT count(*) FROM locked) = cardinality($2::text[])
    RETURNING s.label
  ), created AS (
    INSERT INTO reservations (id, show_id, user_id, seats, amount_paise, status)
    SELECT $3::uuid, $1::uuid, $4::text, $2::text[], $5::bigint, 'confirmed'
     WHERE (SELECT count(*) FROM confirmed) = cardinality($2::text[])
    RETURNING id
  ), keyed AS (
    UPDATE idempotency_keys
       SET reservation_id = $3::uuid
     WHERE user_id = $4::text AND key = $6::text AND EXISTS (SELECT 1 FROM created)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM created)::int AS created,
         ARRAY(SELECT label FROM locked) AS won`,
);

/**
 * Reads the current state of seats after a reserve was declined, to explain why (unknown label, or who holds it). No lock is taken.
 * $1 show id, $2 labels.
 */
export const SELECT_SEAT_STATES = prepared(
  "select_seat_states",
  `
  SELECT label, status, reservation_id
    FROM seats
   WHERE show_id = $1 AND label = ANY($2::text[])`,
);

/** Loads and locks a reservation for cancelling. $1 reservation id. */
export const LOCK_RESERVATION_FOR_CANCEL = prepared(
  "lock_reservation_for_cancel",
  `
  SELECT id, show_id, user_id, seats, amount_paise, status
    FROM reservations
   WHERE id = $1
     FOR UPDATE`,
);

/**
 * Locks the reservation's seats in sorted order and returns them to available in one statement. Only seats that still point at this
 * reservation are touched, so a cancel can never free someone else's seat. Looked up by primary key (show, label).
 * $1 show id, $2 reservation id, $3 the reservation's labels.
 */
export const RELEASE_RESERVATION_SEATS = prepared(
  "release_reservation_seats",
  `
  WITH locked AS (
    SELECT label
      FROM seats
     WHERE show_id = $1::uuid AND label = ANY($3::text[]) AND reservation_id = $2::uuid
     ORDER BY label COLLATE "C"
       FOR UPDATE
  )
  UPDATE seats s
     SET status = 'available', reservation_id = NULL, user_id = NULL
    FROM locked l
   WHERE s.show_id = $1::uuid AND s.label = l.label`,
);

/** Marks a reservation cancelled. $1 reservation id. */
export const MARK_RESERVATION_CANCELLED = prepared(
  "mark_reservation_cancelled",
  `
  UPDATE reservations
     SET status = 'cancelled', cancelled_at = now()
   WHERE id = $1`,
);
