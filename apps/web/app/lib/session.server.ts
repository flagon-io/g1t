import {
  type MiddlewareFunction,
  type RouterContextProvider,
  createContext,
  data,
  redirect,
} from "react-router";

import { type Result, type User, type Viewer, httpStatus } from "@g1t/contracts";

import { identity } from "./services.server";

const SESSION_COOKIE = "g1t_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const viewerContext = createContext<Viewer>(null);

function sessionToken(request: Request): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|; )${SESSION_COOKIE}=([0-9a-f]{64})`).exec(cookies);
  return match ? match[1] : null;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Root middleware: resolves the signed-in user once per request. */
export const viewerMiddleware: MiddlewareFunction<Response> = async ({
  request,
  context,
}) => {
  const token = sessionToken(request);
  if (token) {
    context.set(viewerContext, await identity.userForSession(token));
  }
};

type Context = Readonly<RouterContextProvider>;

export function getViewer(context: Context): Viewer {
  return context.get(viewerContext);
}

export function requireUser(context: Context, request: Request): User {
  const viewer = getViewer(context);
  if (!viewer) {
    const next = new URL(request.url).pathname;
    throw redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return viewer;
}

/**
 * Where to go after signing in. Only same-site paths are honoured, so
 * `next` cannot redirect off g1t.
 */
export function nextPath(request: Request): string {
  const next = new URL(request.url).searchParams.get("next") ?? "/";
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** `Set-Cookie` value that starts a session. */
export function startSession(token: string): string {
  return sessionCookie(token, SESSION_TTL_SECONDS);
}

/** Ends the session and returns the `Set-Cookie` value that clears it. */
export async function endSession(request: Request): Promise<string> {
  const token = sessionToken(request);
  if (token) await identity.signOut(token);
  return sessionCookie("", 0);
}

/** Rejects cross-site form posts; call at the top of every action. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new Response("Cross-origin request rejected", { status: 403 });
  }
}

/** The value of a service result, or the matching HTTP error. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw data(result.error.message, { status: httpStatus(result.error) });
}
