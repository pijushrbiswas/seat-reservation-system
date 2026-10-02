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

export type DeclineReason =
  | "seat_taken"
  | "per_user_limit"
  | "idempotency_key_conflict"
  | "unknown_seat";

export class DeclineError extends AppError {
  constructor(
    public readonly reason: DeclineReason,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(reason === "unknown_seat" ? 422 : 409, reason, message, details);
    this.name = "DeclineError";
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const badRequest = (msg: string) => new AppError(400, "invalid_request", msg);
export const unauthorized = (msg = "missing or invalid credentials") =>
  new AppError(401, "unauthorized", msg);
export const forbidden = (msg: string) => new AppError(403, "forbidden", msg);
export const unavailable = (msg = "dependency unavailable") =>
  new AppError(503, "service_unavailable", msg);
