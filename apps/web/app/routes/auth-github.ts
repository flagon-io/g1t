import { redirect } from "react-router";

import type { Route } from "./+types/auth-github";
import { STATE_COOKIE, cookie } from "../lib/github";
import { callbackUrl, githubSignIn } from "../lib/github.server";
import { getViewer, nextPath } from "../lib/session.server";

/**
 * Sends the browser to GitHub to sign in, sign up or (with `?link=1`)
 * link GitHub to the signed-in account. The state GitHub will send back is
 * kept in a short-lived cookie, so only this browser can finish the trip.
 * An invite code (`?invite=`) rides along for a new account.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const viewer = getViewer(context);
  const link = url.searchParams.get("link") === "1";
  if (link && !viewer) throw redirect(`/login?next=${encodeURIComponent("/settings#github")}`);
  if (!link && viewer) throw redirect(nextPath(request));
  const invite = url.searchParams.get("invite")?.trim().slice(0, 100) || null;
  const started = await githubSignIn.start({
    purpose: link ? "link" : "sign_in",
    user: link ? viewer : null,
    redirectUri: callbackUrl(request),
    next: link ? (url.searchParams.has("next") ? nextPath(request) : "/settings#github") : nextPath(request),
    inviteCode: invite,
  });
  if (!started.ok) throw redirect(link ? "/settings#github" : "/login");
  throw redirect(started.value.authorizeUrl, {
    headers: { "set-cookie": cookie(STATE_COOKIE, started.value.state, 600) },
  });
}
