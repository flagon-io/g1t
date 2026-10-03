/**
 * Expected failures cross service boundaries as values, not exceptions:
 * Worker RPC does not preserve error classes, and callers should have to
 * handle them.
 */
export type FailureCode =
  | "not_found"
  | "forbidden"
  | "unauthenticated"
  | "conflict"
  | "invalid"
  /** The workspace has to pay before this can happen. */
  | "payment_required";

export type Failure = { code: FailureCode; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: FailureCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

const HTTP_STATUS: Record<FailureCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  conflict: 409,
  invalid: 422,
  payment_required: 402,
};

export function httpStatus(failure: Failure): number {
  return HTTP_STATUS[failure.code];
}

/** Returned when an account with an unconfirmed email tries to change something. */
export const UNVERIFIED = fail(
  "forbidden",
  "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.",
);
