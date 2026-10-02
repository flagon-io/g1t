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
  | "invalid";

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
};

export function httpStatus(failure: Failure): number {
  return HTTP_STATUS[failure.code];
}
