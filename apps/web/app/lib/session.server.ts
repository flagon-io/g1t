import {
  type MiddlewareFunction,
  type RouterContextProvider,
  createContext,
  data,
  redirect,
} from "react-router";

import { type Result, type Role, type User, type Viewer, hasCodeAccess, httpStatus } from "@g1t/contracts";

import { confirmGate, pageOf } from "./confirm-gate";
import { workspaceGate } from "./workspace-gate";
import { readCookie } from "./mission";
import { safeNext } from "./next";
import { WORKSPACE_COOKIE, chosenWorkspace } from "./workspace-choice";
import { codeGate } from "./workspace-nav";
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

/**
 * Root middleware: resolves the signed-in user once per request.
 *
 * An account that has not confirmed its email address is sent to confirm
 * it, from any page but the few that needs (lib/confirm-gate.ts).
 *
 * Everything on g1t lives in a workspace, so a confirmed account with none
 * is sent to create one, from wherever it was going, and returned there
 * afterwards.
 */
export const viewerMiddleware: MiddlewareFunction<Response> = async ({
  request,
  context,
}) => {
  const token = sessionToken(request);
  if (!token) return;
  const viewer = await identity.userForSession(token);
  context.set(viewerContext, viewer);

  const { pathname, search } = new URL(request.url);
  // An account that has not confirmed its email address does that first,
  // from wherever it was going (lib/confirm-gate.ts).
  const gated = confirmGate(pathname, search, viewer);
  if (gated) throw redirect(gated);
  // A member without Code access in a workspace (docs/WORKSPACE.md,
  // "Members without Code"): their Home in place of Mission control, and
  // the page that says to ask an owner in place of anything of Code's.
  // The services enforce it too; this keeps the site from offering it.
  const noCode = (viewer?.workspaces ?? []).filter((m) => !hasCodeAccess(m)).map((m) => m.slug.toLowerCase());
  if (request.method === "GET" && noCode.length > 0) {
    const chosen = chosenWorkspace(viewer?.workspaces ?? [], readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE));
    const around = codeGate(pathname, search, noCode, chosen?.slug ?? null);
    if (around) throw redirect(around);
  }
  // Nobody uses g1t without a workspace: someone with none makes one, or
  // answers an invitation to one, before anything else (lib/workspace-gate.ts).
  // Data requests too, so a page is never loaded behind its back.
  if (request.method === "GET") {
    const around = workspaceGate(pageOf(pathname), search, viewer);
    if (around) throw redirect(around);
  }
};

type Context = Readonly<RouterContextProvider>;

export function getViewer(context: Context): Viewer {
  return context.get(viewerContext);
}

/** The viewer's role in a workspace, or null if they are not a member. */
export function roleIn(viewer: Viewer, slug: string): Role | null {
  const wanted = slug.toLowerCase();
  return (
    viewer?.workspaces?.find((membership) => membership.slug === wanted)?.role ?? null
  );
}

/** Whether the viewer may manage a workspace's billing: an owner or a billing manager. */
export function managesBilling(viewer: Viewer, slug: string): boolean {
  const membership = viewer?.workspaces?.find((m) => m.slug === slug.toLowerCase());
  return membership?.role === "owner" || !!membership?.org_roles?.includes("billing_manager");
}

/** Whether the viewer may manage security across a workspace: an owner or a security manager. */
export function managesSecurity(viewer: Viewer, slug: string): boolean {
  const membership = viewer?.workspaces?.find((m) => m.slug === slug.toLowerCase());
  return membership?.role === "owner" || !!membership?.org_roles?.includes("security_manager");
}

export function requireUser(context: Context, request: Request): User {
  const viewer = getViewer(context);
  if (!viewer) {
    // Keep the query string: a device sign-in link carries its code there.
    const { pathname, search } = new URL(request.url);
    throw redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }
  return viewer;
}

/**
 * Where to go after signing in. Only same-site paths are honoured, so
 * `next` cannot redirect off g1t.
 */
export function nextPath(request: Request): string {
  return safeNext(new URL(request.url).searchParams.get("next"));
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

/** The session token the request carries, for proof of a recent sign-in. */
export function sessionTokenOf(request: Request): string | null {
  return sessionToken(request);
}

/** The visitor's IP address, as Cloudflare saw it, for rate limits. */
export function clientOf(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
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
