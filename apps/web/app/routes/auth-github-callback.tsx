import { Link, data, redirect } from "react-router";

import type { Route } from "./+types/auth-github-callback";
import { AuthCard } from "../components/auth-card";
import { ContinueWithGithub } from "../components/github";
import { PENDING_COOKIE, STATE_COOKIE, cookie, readCookie, stateMatches } from "../lib/github";
import { githubSignIn } from "../lib/github.server";
import { page } from "../lib/meta";
import { safeNext } from "../lib/next";
import { startSession } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Signing in with GitHub · g1t" });
}

/**
 * Where GitHub returns. The state must match the cookie this browser was
 * given; identity then redeems it once, exchanges the code with the PKCE
 * verifier, and says what happens next.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const clear = cookie(STATE_COOKIE, "", 0);
  const failed = (error: string) => data({ error }, { headers: { "set-cookie": clear } });
  if (url.searchParams.get("error")) {
    // access_denied: the person cancelled on GitHub.
    return failed("GitHub sign-in was cancelled.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !stateMatches(readCookie(request.headers.get("cookie"), STATE_COOKIE), state)) {
    return failed("This sign-in did not start in this browser, or took too long. Start again.");
  }
  const finished = await githubSignIn.finish(state!, code);
  if (!finished.ok) return failed(finished.error.message);
  const done = finished.value;
  const headers = new Headers({ "set-cookie": clear });
  switch (done.kind) {
    case "signed_in":
      headers.append("set-cookie", startSession(done.signedIn.sessionToken));
      throw redirect(safeNext(done.next), { headers });
    case "linked":
      throw redirect(safeNext(done.next === "/" ? "/settings#github" : done.next), { headers });
    case "needs_link":
      headers.append("set-cookie", cookie(PENDING_COOKIE, done.pending, 1800));
      throw redirect(`/login?github=link${done.next === "/" ? "" : `&next=${encodeURIComponent(done.next)}`}`, { headers });
    case "needs_username":
      headers.append("set-cookie", cookie(PENDING_COOKIE, done.pending, 1800));
      throw redirect("/auth/github/username", { headers });
  }
}

export default function GithubCallback({ loaderData }: Route.ComponentProps) {
  const error = loaderData?.error;
  return (
    <AuthCard
      title="Signing in with GitHub"
      subtitle="That did not work"
      footer={
        <Link to="/login" className="text-fg underline underline-offset-4">
          Sign in another way
        </Link>
      }
    >
      <p className="text-sm text-danger" role="alert">
        {error}
      </p>
      <div className="mt-6">
        <ContinueWithGithub href="/auth/github" label="Try again with GitHub" />
      </div>
    </AuthCard>
  );
}
