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
  | "payment_required"
  /** Billing's refusals to start compute (`reserve`); each message says what to do. */
  /** No plan, and no trial or pool that pays for this work: a card check or the g1t plan is needed. */
  | "not_paid"
  /** The workspace's one trial is spent. */
  | "trial_used"
  /** The spend limit or g1t's ceiling is reached. */
  | "limit"
  /** Compute is paused: a spend spike waiting for an owner, or a hold. */
  | "paused"
  /** This month's open-source pool, or the repository's share of it, is spent. */
  | "oss_pool_empty"
  /** A sensitive change needs a recent sign-in or the password again. */
  | "reauth_required"
  /** Another host g1t depends on for this did not answer. */
  | "unavailable";

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
  not_paid: 402,
  trial_used: 402,
  limit: 402,
  paused: 409,
  oss_pool_empty: 402,
  reauth_required: 403,
  unavailable: 503,
};

export function httpStatus(failure: Failure): number {
  return HTTP_STATUS[failure.code];
}

/** Returned when an account with an unconfirmed email tries to change something. */
export const UNVERIFIED = fail(
  "forbidden",
  "Confirm your email address first. Check your inbox, or resend the link from the banner on g1t.sh.",
);
