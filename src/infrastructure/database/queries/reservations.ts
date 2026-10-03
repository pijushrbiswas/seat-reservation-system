/**
 * SQL for reserving, cancelling and replaying reservations.
 *
 * Lock order inside the reserve transaction is fixed: idempotency row, the user's quota row, then seat rows (sorted).
 * Cancel takes its reservation row, the quota row, then seat rows (sorted). Consistent orders prevent deadlocks.
 */

/**
 * Claims an idempotency key. $1 user, $2 key, $3 show, $4 request hash.
 * Zero rows inserted means the key was already used (go to the replay path).
 */
export const CLAIM_IDEMPOTENCY_KEY = `
  INSERT INTO idempotency_keys (user_id, key, show_id, request_hash)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (user_id, key) DO NOTHING`;

/** Records which reservation an idempotency key produced. $1 user, $2 key, $3 reservation id. */
export const ATTACH_RESERVATION_TO_KEY = `
  UPDATE idempotency_keys
     SET reservation_id = $3
   WHERE user_id = $1 AND key = $2`;

/** Finds the original reservation behind an already-used key, plus the hash of the request that created it. $1 user, $2 key. */
export const SELECT_ORIGINAL_RESERVATION_BY_KEY = `
  SELECT k.request_hash, r.id, r.show_id, r.user_id, r.seats, r.amount_paise, r.status
    FROM idempotency_keys k
    JOIN reservations r ON r.id = k.reservation_id
   WHERE k.user_id = $1 AND k.key = $2`;

/** Step 1 of the per-user limit: makes sure this `(show, user)` counter row exists; a no-op if it already does. $1 show id, $2 user id. */
export const ENSURE_USER_QUOTA_ROW = `
  INSERT INTO user_show_holdings (show_id, user_id, held_count)
  VALUES ($1, $2, 0)
  ON CONFLICT (show_id, user_id) DO NOTHING`;

/**
 * Step 2: checks and takes the quota in one conditional update. The UPDATE locks the row, so one user's concurrent reserves run one after another
 * and the limit is re-checked against the latest committed count. Zero rows updated means the user would exceed the limit.
 * $1 show id, $2 user id, $3 seats wanted, $4 per-user limit.
 */
export const TAKE_USER_QUOTA = `
  UPDATE user_show_holdings
     SET held_count = held_count + $3
   WHERE show_id = $1 AND user_id = $2
     AND held_count + $3 <= $4`;

/** Gives seats back to the user's quota when a reservation is cancelled. $1 show id, $2 user id, $3 seat count. */
export const RELEASE_USER_QUOTA = `
  UPDATE user_show_holdings
     SET held_count = held_count - $3
   WHERE show_id = $1 AND user_id = $2`;

/**
 * The decision point: locks the requested seat rows in a fixed byte order, so concurrent requests queue on the row lock and cannot deadlock.
 * $1 show id, $2 seat labels.
 */
export const LOCK_REQUESTED_SEATS = `
  SELECT label, status, reservation_id
    FROM seats
   WHERE show_id = $1 AND label = ANY($2::text[])
   ORDER BY label COLLATE "C"
     FOR UPDATE`;

/** Creates a confirmed reservation. $1 id, $2 show, $3 user, $4 seats, $5 amount in paise. */
export const INSERT_RESERVATION = `
  INSERT INTO reservations (id, show_id, user_id, seats, amount_paise, status)
  VALUES ($1, $2, $3, $4, $5, 'confirmed')`;

/**
 * Flips the locked seats to confirmed. Also guarded on `status = 'available'` as a second line of defence behind the row lock.
 * $1 show id, $2 labels, $3 reservation id, $4 user id.
 */
export const MARK_SEATS_CONFIRMED = `
  UPDATE seats
     SET status = 'confirmed', reservation_id = $3, user_id = $4
   WHERE show_id = $1 AND label = ANY($2::text[]) AND status = 'available'`;

/** Loads and locks a reservation for cancelling. $1 reservation id. */
export const LOCK_RESERVATION_FOR_CANCEL = `
  SELECT id, show_id, user_id, seats, amount_paise, status
    FROM reservations
   WHERE id = $1
     FOR UPDATE`;

/** Locks only the seats that still point at this reservation, so a cancel can never free someone else's seat. $1 show id, $2 reservation id. */
export const LOCK_RESERVATION_SEATS = `
  SELECT label
    FROM seats
   WHERE show_id = $1 AND reservation_id = $2
   ORDER BY label COLLATE "C"
     FOR UPDATE`;

/** Returns a reservation's seats to available and clears their owner. $1 show id, $2 reservation id. */
export const MARK_SEATS_AVAILABLE = `
  UPDATE seats
     SET status = 'available', reservation_id = NULL, user_id = NULL
   WHERE show_id = $1 AND reservation_id = $2`;

/** Marks a reservation cancelled. $1 reservation id. */
export const MARK_RESERVATION_CANCELLED = `
  UPDATE reservations
     SET status = 'cancelled', cancelled_at = now()
   WHERE id = $1`;
