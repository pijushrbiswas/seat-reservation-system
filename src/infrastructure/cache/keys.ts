/**
 * Redis key builders. Every key for a show contains `{showId}`, so in Redis Cluster they hash to the same slot
 * and one Lua script can touch them together.
 */

/**
 * Key for one seat: holds `L|token` while a request is confirming it, then `C|reservationId` once it is confirmed.
 * @param show - Show id.
 * @param label - Seat label.
 */
export const seatLockKey = (show: string, label: string) => `seat:{${show}}:${label}`;

/**
 * Key remembering that a `(user, idempotency key)` pair has already succeeded.
 * @param show - Show id.
 * @param token - Hash of the user and idempotency key.
 */
export const idempotencyMarkerKey = (show: string, token: string) => `idem:{${show}}:${token}`;

/**
 * Sorted set of a show's held seats, scored by hold expiry in epoch milliseconds.
 * @param show - Show id.
 */
export const heldSeatsKey = (show: string) => `held:{${show}}`;
