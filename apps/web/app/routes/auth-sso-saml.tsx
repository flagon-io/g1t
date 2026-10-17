import { data, redirect } from "react-router";

import type { Route } from "./+types/auth-sso-saml";
import { page } from "../lib/meta";
import { clearErrorCookie, readErrorCookie } from "../lib/sso";
import { SsoProblem } from "./auth-sso";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Single sign-on · ${params.owner} · g1t` });
}

/**
 * The assertion consumer service, as a page: the provider's POST is
 * answered by the Worker (workers/sso-saml.ts), which comes back here with
 * why it did not work. Opened by itself, it starts again.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  const slug = params.owner.toLowerCase();
  const error = readErrorCookie(request.headers.get("cookie"));
  if (!error) throw redirect(`/auth/sso/${slug}`);
  return data({ slug, error }, { headers: { "set-cookie": clearErrorCookie() } });
}

export default function SsoSaml({ loaderData }: Route.ComponentProps) {
  return <SsoProblem slug={loaderData.slug} error={loaderData.error} />;
}
