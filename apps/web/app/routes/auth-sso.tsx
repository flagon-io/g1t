import { Link, data, redirect } from "react-router";

import { ssoAddresses } from "@g1t/contracts";

import type { Route } from "./+types/auth-sso";
import { AuthCard } from "../components/auth-card";
import { cookie } from "../lib/github";
import { page } from "../lib/meta";
import { SSO_STATE_COOKIE } from "../lib/sso";
import { sso } from "../lib/sso.server";
import { nextPath, requireUser, sessionTokenOf } from "../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Single sign-on · ${params.owner} · g1t` });
}

/**
 * Sends the signed-in person to a workspace's identity provider. Signed
 * out, they sign in to g1t first and come back here. The state the
 * provider will send back is kept in a short-lived cookie (OpenID Connect
 * and OAuth 2.0); a SAML request's id binds its answer instead.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const token = sessionTokenOf(request);
  if (!token) {
    return data({ slug, error: "Single sign-on is for people signed in on this site, not for access tokens." }, { status: 403 });
  }
  const summary = await sso.summary(slug);
  if (!summary.enabled) return data({ slug, error: `${slug} has not set up single sign-on.` }, { status: 404 });
  const addresses = ssoAddresses(new URL(request.url).origin, slug);
  const started = await sso.start({
    user,
    session_token: token,
    slug,
    redirect_uri: summary.protocol === "saml" ? addresses.acsUrl : addresses.callbackUrl,
    entity_id: addresses.entityId,
    next: nextPath(request),
  });
  if (!started.ok) return { slug, error: started.error.message };
  const headers = started.value.state ? { "set-cookie": cookie(SSO_STATE_COOKIE, started.value.state, 600) } : undefined;
  throw redirect(started.value.url, { headers });
}

export default function SsoStart({ loaderData }: Route.ComponentProps) {
  return <SsoProblem slug={loaderData.slug} error={loaderData.error} />;
}

/** What a single sign-on that did not work says, with the ways on. */
export function SsoProblem({ slug, error }: { slug: string; error: string }) {
  return (
    <AuthCard
      title="Single sign-on"
      subtitle={`Signing in through ${slug}'s identity provider`}
      footer={
        <Link to="/" className="text-fg underline underline-offset-4">
          Back to g1t
        </Link>
      }
    >
      <p className="text-sm text-danger" role="alert">
        {error}
      </p>
      <p className="mt-6 text-sm">
        <Link to={`/auth/sso/${slug}`} className="font-medium text-accent underline underline-offset-4">
          Try again
        </Link>
      </p>
    </AuthCard>
  );
}
