import { CircleX, KeyRound } from "lucide-react";
import { Form, redirect } from "react-router";

import { decodeOAuthClient, isRegisteredRedirect } from "@g1t/contracts";

import type { Route } from "./+types/oauth-authorize";
import { page } from "../lib/meta";
import { ErrorText, SubmitButton, usePending } from "../components/ui";
import { Card } from "../components/ui/card";
import { ScopeChecklist } from "../components/token-scopes";
import { identity } from "../lib/services.server";
import { addresses } from "../lib/addresses.server";
import { consentedScopes, requestedScopes } from "../lib/token-scopes";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Sign in to an application · g1t" });
}

type Checked =
  | { ok: false; problem: string }
  | {
      ok: true;
      clientId: string;
      clientName: string;
      redirectUri: string;
      codeChallenge: string;
      state: string;
    };

/**
 * Checks an authorization request. A request that names a client or a
 * redirect address we cannot vouch for is never redirected anywhere; the
 * person is told instead.
 */
function check(params: URLSearchParams | FormData): Checked {
  const get = (key: string) => String(params.get(key) ?? "");
  const client = decodeOAuthClient(get("client_id"));
  if (!client) {
    return { ok: false, problem: "This sign-in link names an application g1t does not recognise." };
  }
  const redirectUri = get("redirect_uri") || client.redirectUris[0];
  if (!isRegisteredRedirect(client, redirectUri)) {
    return {
      ok: false,
      problem: "This sign-in link would send you somewhere the application did not register.",
    };
  }
  if (get("response_type") !== "code") {
    return { ok: false, problem: "This sign-in link asks for a kind of access g1t does not offer." };
  }
  if (!get("code_challenge") || get("code_challenge_method") !== "S256") {
    return {
      ok: false,
      problem: "This application did not protect its sign-in with PKCE (S256), which g1t requires.",
    };
  }
  return {
    ok: true,
    clientId: get("client_id"),
    clientName: client.name,
    redirectUri,
    codeChallenge: get("code_challenge"),
    state: get("state"),
  };
}

/** The application's redirect address with the outcome added to it. */
function callback(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Where an application sends a person to approve its sign-in. */
export function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const { searchParams } = new URL(request.url);
  return {
    user,
    request: check(searchParams),
    // What the application asked for; nothing usable means the default set.
    requested: requestedScopes(searchParams.get("scope")),
    // Sent back unchanged when the person decides.
    query: Object.fromEntries(searchParams),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const checked = check(form);
  if (!checked.ok) return null;
  if (form.get("decision") !== "approve") {
    throw redirect(
      callback(checked.redirectUri, { error: "access_denied", state: checked.state }),
    );
  }
  // Only what the application asked for, never more, whatever the form says.
  const scopes = consentedScopes(form, requestedScopes(String(form.get("scope") ?? "")));
  if (scopes.length === 0) {
    return { error: "Leave at least one box ticked, or deny." };
  }
  let code: string;
  try {
    ({ code } = await identity.oauthAuthorize(user, {
      clientId: checked.clientId,
      clientName: checked.clientName,
      redirectUri: checked.redirectUri,
      codeChallenge: checked.codeChallenge,
      scopes,
    }));
  } catch (error) {
    // The service's own words are for the log; the person can try again.
    console.warn("oauth-authorize:", error);
    return { error: "g1t could not approve this sign-in just now. Try again in a moment." };
  }
  // `iss` is the API's origin, the issuer its metadata names (RFC 9207).
  throw redirect(
    callback(checked.redirectUri, { code, state: checked.state, iss: addresses().api }),
  );
}

export default function Authorize({ loaderData, actionData }: Route.ComponentProps) {
  const { user, request, requested, query } = loaderData;
  // Either answer turns both buttons off until it is in.
  const deciding = usePending();

  if (!request.ok) {
    return (
      <main className="mx-auto max-w-md pt-10 text-center">
        <CircleX size={40} className="mx-auto text-muted" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">This link cannot be used</h1>
        <p className="mt-2 text-muted">{request.problem}</p>
        <p className="mt-2 text-sm text-faint">Nothing was given access to your account.</p>
      </main>
    );
  }

  const destination = new URL(request.redirectUri);
  return (
    <main className="mx-auto max-w-md pt-8">
      <KeyRound size={36} className="text-accent" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Sign in to {request.clientName}
      </h1>
      <p className="mt-2 text-muted">
        <span className="font-medium text-fg">{request.clientName}</span> wants to act as{" "}
        <span className="font-mono font-medium text-fg">{user.username}</span> on g1t.
      </p>

      <Form method="post" className="mt-6 space-y-6">
        {Object.entries(query).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <section>
          <h2 className="text-sm font-medium">It will be able to</h2>
          <p className="mt-0.5 text-xs text-faint">
            Everywhere you can, as you. Untick anything you would rather it could not do.
          </p>
          <div className="mt-3">
            <ScopeChecklist initial={requested} only={requested} allowFull={false} />
          </div>
        </section>
        <Card asChild className="p-4 text-sm">
          <dl>
            <dt className="text-xs text-faint">You will be sent back to</dt>
            <dd className="mt-0.5 font-mono text-[0.8125rem] break-all">
              {destination.protocol === "https:" || destination.protocol === "http:"
                ? destination.host + destination.pathname
                : request.redirectUri}
            </dd>
          </dl>
        </Card>
        <div>
          <p className="text-xs text-faint">
            Approve only if you started this from {request.clientName} yourself. You can change
            what it may do, or sign it out, in Settings.
          </p>
          <ErrorText>{actionData?.error}</ErrorText>
          <div className="mt-4 flex gap-2">
            <SubmitButton variant="accent" name="decision" value="approve" pending="Approving…" disabled={deciding}>
              Approve
            </SubmitButton>
            <SubmitButton variant="outline" name="decision" value="deny" pending="Denying…" disabled={deciding}>
              Deny
            </SubmitButton>
          </div>
        </div>
      </Form>
    </main>
  );
}
