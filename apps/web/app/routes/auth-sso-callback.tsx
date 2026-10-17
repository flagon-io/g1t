import { data, redirect } from "react-router";

import type { Route } from "./+types/auth-sso-callback";
import { cookie, readCookie, stateMatches } from "../lib/github";
import { page } from "../lib/meta";
import { SSO_STATE_COOKIE, afterSso } from "../lib/sso";
import { sso } from "../lib/sso.server";
import { sessionTokenOf } from "../lib/session.server";
import { SsoProblem } from "./auth-sso";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Single sign-on · ${params.owner} · g1t` });
}

/**
 * Where a workspace's provider returns over OpenID Connect or OAuth 2.0.
 * The state must match this browser's cookie, and the session must be the
 * one that set off; identity then spends the state once, exchanges the
 * code, and links, admits and marks the session.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const slug = params.owner.toLowerCase();
  const url = new URL(request.url);
  const clear = cookie(SSO_STATE_COOKIE, "", 0);
  const failed = (error: string) => data({ slug, error }, { headers: { "set-cookie": clear } });
  const refused = url.searchParams.get("error");
  if (refused) {
    const said = url.searchParams.get("error_description")?.slice(0, 300);
    return failed(refused === "access_denied" ? "The sign-in was cancelled at the identity provider." : `The identity provider refused the sign-in${said ? `: ${said}` : ` (${refused.slice(0, 60)})`}.`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !stateMatches(readCookie(request.headers.get("cookie"), SSO_STATE_COOKIE), state)) {
    return failed("This sign-in did not start in this browser, or took too long. Start again.");
  }
  const token = sessionTokenOf(request);
  if (!token) return failed("Sign in to g1t again, then start single sign-on again.");
  const finished = await sso.finish({ slug, session_token: token, state: state!, code });
  if (!finished.ok) return failed(finished.error.message);
  throw redirect(afterSso(finished.value), { headers: { "set-cookie": clear } });
}

export default function SsoCallback({ loaderData }: Route.ComponentProps) {
  return <SsoProblem slug={loaderData.slug} error={loaderData.error} />;
}
