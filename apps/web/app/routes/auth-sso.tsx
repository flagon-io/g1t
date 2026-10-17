import { Form, Link, data, redirect } from "react-router";

import { type User, ssoAddresses } from "@g1t/contracts";

import type { Route } from "./+types/auth-sso";
import { AuthCard } from "../components/auth-card";
import { SubmitButton } from "../components/ui";
import { cookie } from "../lib/github";
import { page } from "../lib/meta";
import { safeNext } from "../lib/next";
import { SSO_STATE_COOKIE, bindingCookie } from "../lib/sso";
import { sso } from "../lib/sso.server";
import { assertSameOrigin, nextPath, requireUser, sessionTokenOf } from "../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Single sign-on · ${params.owner} · g1t` });
}

/** Whether `viewer` belongs to `slug`, held out of it or not. */
function belongs(viewer: User, slug: string): boolean {
  return (viewer.workspaces ?? []).some((m) => m.slug === slug) || (viewer.held ?? []).some((hold) => hold.slug === slug);
}

/**
 * Sets off to the workspace's identity provider: the state the provider
 * sends back is kept in a short-lived cookie (OpenID Connect and OAuth 2.0);
 * a SAML request's id binds its answer instead.
 */
async function start(request: Request, user: User, slug: string, next: string) {
  const token = sessionTokenOf(request);
  if (!token) return { slug, error: "Single sign-on is for people signed in on this site, not for access tokens." };
  const summary = await sso.summary(slug);
  if (!summary.enabled) throw data({ slug, error: `${slug} has not set up single sign-on.` }, { status: 404 });
  const addresses = ssoAddresses(new URL(request.url).origin, summary.workspace_id, slug);
  const started = await sso.start({
    user,
    session_token: token,
    slug,
    redirect_uri: summary.protocol === "saml" ? addresses.acsUrl : addresses.callbackUrl,
    entity_id: addresses.entityId,
    next,
  });
  if (!started.ok) return { slug, error: started.error.message };
  const headers = new Headers();
  if (started.value.state) headers.append("set-cookie", cookie(SSO_STATE_COOKIE, started.value.state, 600));
  if (started.value.binding) headers.append("set-cookie", bindingCookie(started.value.binding));
  throw redirect(started.value.url, { headers });
}

/**
 * A member (held out or not) sets off at once. Anyone else is asked first,
 * on this page, and sets off only by saying so: a link from another site
 * must never make someone a member of a workspace without their knowing.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (belongs(user, slug)) return start(request, user, slug, nextPath(request));
  const summary = await sso.summary(slug);
  if (!summary.enabled) return data({ slug, error: `${slug} has not set up single sign-on.` }, { status: 404 });
  return { slug, confirm: true as const, username: user.display_username ?? user.username, next: nextPath(request) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  return start(request, user, params.owner.toLowerCase(), safeNext(String(form.get("next") ?? "")));
}

export default function SsoStart({ loaderData, actionData }: Route.ComponentProps) {
  const shown = actionData ?? loaderData;
  if ("error" in shown && shown.error) return <SsoProblem slug={shown.slug} error={shown.error} />;
  if (!("confirm" in loaderData)) return null;
  return (
    <AuthCard
      title={`Join ${loaderData.slug}`}
      subtitle="Through its identity provider"
      footer={
        <Link to="/" className="text-fg underline underline-offset-4">
          Not now
        </Link>
      }
    >
      <p className="text-sm text-muted">
        You are signed in as <span className="font-medium text-fg">{loaderData.username}</span>. Signing in through{" "}
        {loaderData.slug}&apos;s identity provider links your account there to this one and, if {loaderData.slug} lets its
        provider&apos;s people join, makes you a member.
      </p>
      <Form method="post" className="mt-6">
        <input type="hidden" name="next" value={loaderData.next} />
        <SubmitButton className="w-full" pending="Setting off…">
          Continue to {loaderData.slug}&apos;s sign-in
        </SubmitButton>
      </Form>
    </AuthCard>
  );
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
