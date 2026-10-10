/**
 * Using the website with an access token: automation driving a browser
 * (Playwright and the like) sends `Authorization: Bearer g1t_…` on every
 * request and is signed in as the token's owner for that request alone.
 * lib/session.server.ts resolves it; these are the rules it follows.
 *
 * - Only the `Authorization` header is read, never a query string or a
 *   cookie, and only a person's own token whose owner turned on "Use the
 *   website as you" is accepted (`token.website`, identity's tokens.rs).
 *   No cookie is set and no session is made: each request carries the
 *   token, and expiry, deletion and a workspace revoking it apply at once.
 * - The header wins over a session cookie on the same request, so a
 *   request is either a token's or a session's, never both.
 * - Browsers never send the header by themselves, so another site cannot
 *   make one: the same-origin check on form posts (`assertSameOrigin`) is
 *   the same for both and nothing about cookies is relaxed.
 * - What the token's owner does on the website is theirs, as for a
 *   session, except what needs a real sign-in: tokens, two-factor
 *   authentication, passwords, email addresses, SSH and signing keys,
 *   applications, deleting the account or a workspace, giving a workspace
 *   away, and payment methods ({@link needsRealSignIn}).
 * - A token that is not accepted is no one: a page loads signed out, and a
 *   data request or form post is refused with a 401 that says why.
 */

import type { User, Viewer } from "@g1t/contracts";

/**
 * The page a request is for, as routes match it: decoded, any case, no
 * doubled or trailing slashes, and a client navigation's `.data` as its
 * page (as lib/confirm-gate.ts's `pageOf`).
 */
function pageOf(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Left as it came: routes cannot match a malformed escape either.
  }
  path = path.toLowerCase().replace(/\/{2,}/g, "/");
  if (path.endsWith(".data")) {
    path = path.slice(0, -".data".length);
    if (path === "/_root") path = "/";
  }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

/** Where the docs explain it. */
export const WEBSITE_TOKEN_DOCS = "https://docs.g1t.sh/guides/authentication/#use-a-token-on-the-website";

/**
 * The token in `Authorization: Bearer <token>`, or null when the request
 * has no such header. Any other scheme is not a token.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * The person a token resolved to, when it may use the website: a person
 * (not a workspace, an agent or a job) whose token has the website
 * permission. Null otherwise.
 */
export function websiteUser(viewer: Viewer): User | null {
  if (!viewer || (viewer.kind ?? "user") !== "user" || viewer.acting) return null;
  const token = viewer.token;
  if (!token?.website || token.job || token.deploy_key) return null;
  return viewer;
}

/** Why a token was not accepted, for the 401. */
export const TOKEN_REFUSED =
  "This access token cannot be used on the website: it is not valid, has expired, or does not have “Use the website as you” turned on. " +
  `See ${WEBSITE_TOKEN_DOCS}`;

/** The `WWW-Authenticate` header for a refused token. */
export const TOKEN_CHALLENGE = 'Bearer realm="g1t", error="invalid_token"';

/** Pages a token never opens, whatever the method. */
const ALWAYS = [
  // Your tokens, two-factor authentication, emails, keys, the account
  // itself (its password and deleting it), applications you let in, and
  // how you sign in.
  /^\/settings\/(?:tokens|two-factor|emails|keys|account|applications|github)(?:\/|$)/,
  // Letting a device or an application in makes a token.
  /^\/(?:device|oauth\/authorize|auth\/github)(?:\/|$)/,
  // A workspace's own tokens, and its rules for and approvals of members' tokens.
  /^\/[^/]+\/-\/(?:tokens|personal-access-tokens)(?:\/|$)/,
];

/** Form posts a token never makes: a page, the field that names the change, and the changes. */
const CHANGES: { page: RegExp; field: string; values: string[] }[] = [
  // Deleting a workspace.
  { page: /^\/[^/]+\/-\/settings$/, field: "intent", values: ["delete"] },
  // Giving a workspace to another owner.
  { page: /^\/[^/]+\/-\/(?:members|people)$/, field: "action", values: ["transfer"] },
  // Payment methods: the card on file, and the payment pages that take one.
  { page: /^\/[^/]+\/-\/billing$/, field: "intent", values: ["portal", "card-check", "subscribe", "buy-ai-credit"] },
];

/** Whether a page opens nothing for a token whatever is posted to it. */
export function alwaysNeedsSignIn(pathname: string): boolean {
  const page = pageOf(pathname);
  return ALWAYS.some((pattern) => pattern.test(page));
}

/**
 * Whether a request needs a real sign-in rather than a token. `form` is
 * the posted form, read only for the few pages where one change of many
 * does (null for none, or when it could not be read).
 */
export function needsRealSignIn(pathname: string, method: string, form: { get(name: string): unknown } | null): boolean {
  if (alwaysNeedsSignIn(pathname)) return true;
  if (method === "GET" || method === "HEAD" || !form) return false;
  const page = pageOf(pathname);
  return CHANGES.some((change) => change.page.test(page) && change.values.includes(String(form.get(change.field) ?? "")));
}

/** Whether a posted form must be read to decide: a form post to one of {@link CHANGES}' pages. */
export function readsForm(pathname: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  const page = pageOf(pathname);
  return CHANGES.some((change) => change.page.test(page));
}

/** What a token is told on a page that needs a real sign-in. */
export type NeedsSignIn = { needs_sign_in: true; message: string };

export const NEEDS_SIGN_IN: NeedsSignIn = {
  needs_sign_in: true,
  message:
    "You are using g1t with an access token. Tokens, two-factor authentication, your password, email addresses and keys, " +
    "deleting an account or a workspace, giving a workspace away, and payment methods need you to sign in on g1t.sh yourself.",
};

/** Whether an error's data is {@link NEEDS_SIGN_IN}, for the error page. */
export function isNeedsSignIn(value: unknown): value is NeedsSignIn {
  return typeof value === "object" && value !== null && (value as { needs_sign_in?: unknown }).needs_sign_in === true;
}

/** Whether a request wants data (a loader's `.data` or a form post) rather than a page. */
export function wantsData(pathname: string, method: string): boolean {
  return pathname.endsWith(".data") || (method !== "GET" && method !== "HEAD");
}

/** What to do with a request, as far as a token on it goes. */
export type TokenVerdict =
  /** No token: the session cookie, if any, decides. */
  | { kind: "none" }
  /** Signed in as the token's owner, for this request. */
  | { kind: "signed-in"; user: User }
  /** A page with a token not accepted: shown signed out, with a challenge header. */
  | { kind: "signed-out" }
  /** Refused: a 401 for a token not accepted, a 403 for what needs a real sign-in. */
  | { kind: "refused"; status: 401; body: string }
  | { kind: "refused"; status: 403; body: NeedsSignIn };

/**
 * Decides a request's token. `lookup` resolves a token to whoever it
 * names (identity's `user_for_access_token`), checked on every request.
 */
export async function tokenVerdict(request: Request, lookup: (token: string) => Promise<Viewer>): Promise<TokenVerdict> {
  const token = bearerToken(request);
  if (token === null) return { kind: "none" };
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();
  const user = token.startsWith("g1t_") ? websiteUser(await lookup(token)) : null;
  if (!user) return wantsData(pathname, method) ? { kind: "refused", status: 401, body: TOKEN_REFUSED } : { kind: "signed-out" };
  let form: { get(name: string): unknown } | null = null;
  if (readsForm(pathname, method)) {
    try {
      form = await request.clone().formData();
    } catch {
      form = null;
    }
  }
  if (needsRealSignIn(pathname, method, form)) return { kind: "refused", status: 403, body: NEEDS_SIGN_IN };
  return { kind: "signed-in", user };
}
