import { ssoClient } from "@g1t/contracts";

import { afterSso, errorCookie } from "../app/lib/sso";

/**
 * A workspace's identity provider posting its SAML response
 * (`POST /auth/sso/<slug>/saml`). It comes from the provider's site, so it
 * is answered here, before React Router, which refuses cross-site form
 * posts; and it carries no session cookie (SameSite=Lax), so identity
 * finds the session from the request g1t sent, which the response must
 * answer. Either way the browser is sent on with a 303: on to where it was
 * going, or back to the page that says what went wrong.
 */
export async function receiveSaml(env: Env, request: Request, slug: string): Promise<Response> {
  const back = (message: string) =>
    new Response(null, {
      status: 303,
      headers: { location: `/auth/sso/${slug}/saml`, "set-cookie": errorCookie(message), "cache-control": "no-store" },
    });
  let samlResponse = "";
  try {
    const form = await request.formData();
    samlResponse = String(form.get("SAMLResponse") ?? "");
  } catch {
    return back("The identity provider's response could not be read.");
  }
  if (!samlResponse) return back("The identity provider sent no SAML response.");
  const finished = await ssoClient(env.IDENTITY)
    .saml(slug, samlResponse)
    .catch(() => null);
  if (!finished) return back("g1t could not check the identity provider's response just now. Try again in a minute.");
  if (!finished.ok) return back(finished.error.message);
  return new Response(null, { status: 303, headers: { location: afterSso(finished.value), "cache-control": "no-store" } });
}
