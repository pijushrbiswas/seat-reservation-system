/**
 * An error with an HTTP status and a stable machine-readable code; the error handler turns it into the JSON error body.
 * @param statusCode - HTTP status to respond with.
 * @param code - Stable error code, for example `seat_taken`.
 * @param message - Human-readable description.
 * @param details - Extra fields merged into the response's `error` object.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Domain outcomes where a request is refused cleanly (a 4xx, never a 5xx). */
export type DeclineReason =
  | "seat_taken"
  | "per_user_limit"
  | "idempotency_key_conflict"
  | "unknown_seat";

/**
 * A clean decline of a reserve request: `seat_taken`, `per_user_limit`, `idempotency_key_conflict` (409) or `unknown_seat` (422).
 * Also drives the `reservations_declined_total{reason}` metric.
 */
export class DeclineError extends AppError {
  /** Seat label to the reservation id of its current holder. Internal only (used to prime Redis); never sent to clients. */
  holders?: Record<string, string>;

  constructor(
    public readonly reason: DeclineReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(reason === "unknown_seat" ? 422 : 409, reason, message, details);
    this.name = "DeclineError";
  }
}

/**
 * 404 for a missing resource.
 * @param what - Name of the resource, for example `show`.
 */
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
/**
 * 400 for a malformed request.
 * @param msg - What is wrong with it.
 */
export const badRequest = (msg: string) => new AppError(400, "invalid_request", msg);
/**
 * 401 for a missing, invalid or expired credential.
 * @param msg - Optional detail.
 */
export const unauthorized = (msg = "missing or invalid credentials") =>
  new AppError(401, "unauthorized", msg);
/**
 * 403 for an authenticated caller who is not allowed to do this.
 * @param msg - Why access is refused.
 */
export const forbidden = (msg: string) => new AppError(403, "forbidden", msg);
/**
 * 503 for a dependency that is down; the service fails closed rather than guessing.
 * @param msg - Optional detail.
 */
export const unavailable = (msg = "dependency unavailable") =>
  new AppError(503, "service_unavailable", msg);
