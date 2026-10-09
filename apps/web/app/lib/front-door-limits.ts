/**
 * The front door's rate limits (workers/app.ts), per request before it is
 * answered. The bindings and their limits are in `RATE_LIMITS`
 * (packages/contracts/src/rate-limits.ts); docs/RATE-LIMITS.md says why.
 *
 * - Git over HTTPS: without credentials, by address; with them, by a hash
 *   of the credential, much higher. A clone is about three requests.
 * - Pages: every request that reaches the Worker counts against a ceiling
 *   per address. Signed out, by address, with a tighter limit on what is
 *   costly to answer (archives, run pages, logs, search). Signed in, by a
 *   hash of the session cookie, higher: the session is not checked here,
 *   which would cost a call to identity, and the ceiling per address keeps
 *   made-up cookies from getting round the signed-out limit.
 *
 * Static assets never reach the Worker (the assets binding answers them),
 * and the few files it serves itself are left out here too. Every limit
 * fails open.
 */
import {
  type RateLimitBinding,
  checkLimit,
  clientAddress,
  secretKey,
  tooManyRequests,
} from "@g1t/contracts/rate-limits";

export type FrontDoorLimits = {
  WEB_ANONYMOUS_LIMIT?: RateLimitBinding;
  WEB_HEAVY_LIMIT?: RateLimitBinding;
  WEB_SESSION_LIMIT?: RateLimitBinding;
  WEB_ADDRESS_LIMIT?: RateLimitBinding;
  GIT_ANONYMOUS_LIMIT?: RateLimitBinding;
  GIT_SIGNED_LIMIT?: RateLimitBinding;
};

/** Files the Worker serves that are never limited: build output, fonts, and top-level files such as robots.txt. */
const UNLIMITED = /^\/(?:assets\/|fonts\/|favicon|[^/]+\.(?:ico|png|svg|txt|xml|webmanifest)$)/;

/** What is costly to answer for a signed-out visitor: a repository's archives, a run's page, logs and artifacts, and search. */
const HEAVY =
  /^\/(?:search(?:\.data)?$|[^/]+\/[^/]+\/(?:archive\/|actions\/runs\/[^/]+(?:\.data|\/logs\.zip|\/artifacts\/[^/]+)?$|actions\/jobs\/[^/]+\/log))/;

export function unlimited(pathname: string): boolean {
  return UNLIMITED.test(pathname);
}

export function heavy(pathname: string): boolean {
  return HEAVY.test(pathname);
}

/** The session cookie's value, or null when signed out. */
export function sessionCookie(cookie: string | null): string | null {
  const match = /(?:^|;\s*)g1t_session=([^;]+)/.exec(cookie ?? "");
  return match?.[1] ?? null;
}

const GIT_MESSAGE_ANONYMOUS =
  "Too many git requests from your network. Wait a minute and try again, or use credentials for a higher limit: https://docs.g1t.sh/reference/rate-limits/\n";
const GIT_MESSAGE_SIGNED = "Too many git requests with these credentials. Wait a minute and try again: https://docs.g1t.sh/reference/rate-limits/\n";
const PAGE_MESSAGE = "Too many requests from your network. Wait a minute and try again.\n";

/**
 * The 429 for a git request past its limit, or null to go on. Git shows a
 * plain-text answer's body to the person running it.
 */
export async function gitLimited(env: FrontDoorLimits, request: Request): Promise<Response | null> {
  const credentials = request.headers.get("authorization");
  if (credentials) {
    const verdict = await checkLimit(env.GIT_SIGNED_LIMIT, await secretKey("git", credentials));
    return verdict === "limited" ? tooManyRequests(GIT_MESSAGE_SIGNED) : null;
  }
  const verdict = await checkLimit(env.GIT_ANONYMOUS_LIMIT, `ip:${clientAddress(request)}`);
  return verdict === "limited" ? tooManyRequests(GIT_MESSAGE_ANONYMOUS) : null;
}

/** The 429 for a page or data request past its limit, or null to go on. */
export async function pageLimited(env: FrontDoorLimits, request: Request, pathname: string): Promise<Response | null> {
  if (unlimited(pathname)) return null;
  const address = `ip:${clientAddress(request)}`;
  const session = sessionCookie(request.headers.get("cookie"));
  const checks: Promise<string>[] = [checkLimit(env.WEB_ADDRESS_LIMIT, address)];
  if (session) {
    checks.push(secretKey("session", session).then((key) => checkLimit(env.WEB_SESSION_LIMIT, key)));
  } else {
    checks.push(checkLimit(env.WEB_ANONYMOUS_LIMIT, address));
    if (heavy(pathname)) checks.push(checkLimit(env.WEB_HEAVY_LIMIT, address));
  }
  const verdicts = await Promise.all(checks);
  if (!verdicts.includes("limited")) return null;
  return tooManyRequests(session ? PAGE_MESSAGE : `${PAGE_MESSAGE.trimEnd()} Signed-in accounts have a higher limit.\n`);
}

/**
 * The 429 for a repository file on the usercontent origin past its limit,
 * or null to go on. Nothing there is signed in (it never sees the session
 * cookie), so a file counts as a signed-out page from its address. Avatars
 * are answered from cache and are not limited.
 */
export async function usercontentLimited(env: FrontDoorLimits, request: Request, path: string): Promise<Response | null> {
  if (path.startsWith("/avatars/")) return null;
  const verdict = await checkLimit(env.WEB_ANONYMOUS_LIMIT, `ip:${clientAddress(request)}`);
  return verdict === "limited" ? tooManyRequests(PAGE_MESSAGE) : null;
}
