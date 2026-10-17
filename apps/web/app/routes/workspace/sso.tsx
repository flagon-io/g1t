import { useState } from "react";
import { Form, data } from "react-router";
import { KeyRound, Sparkles } from "lucide-react";

import { type SsoConfig, type SsoProtocol, type SsoSettings, ssoAddresses } from "@g1t/contracts";

import type { Route } from "./+types/sso";
import { page } from "../../lib/meta";
import { DangerAction, DangerZone } from "../../components/danger-zone";
import { planHref } from "../../components/start-plan";
import { ButtonLink, CopyLine, ErrorText, Field, Input, SubmitButton, Textarea, TimeAgo } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { SwitchCard } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";
import { billing } from "../../lib/services.server";
import { PROTOCOL_NAMES } from "../../lib/sso";
import { sso } from "../../lib/sso.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Single sign-on · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Owners only; to anyone else the page does not exist.
  const viewer = getViewer(context);
  if (!viewer || roleIn(viewer, params.owner) !== "owner") throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [settings, free] = await Promise.all([
    sso.settings(viewer, slug),
    // Whether it can be set up here: every paid plan has it.
    part(billing.freeWorkspaces([slug]), "The workspace's plan"),
  ]);
  return {
    settings: unwrap(settings),
    plan: isFailed(free) ? free : free.includes(slug) ? ("free" as const) : ("paid" as const),
    addresses: ssoAddresses(new URL(request.url).origin, slug),
  };
}

type Answer = { saved?: string; error?: string; intent?: string };

export async function action({ request, params, context }: Route.ActionArgs): Promise<Answer> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const text = (name: string) => String(form.get(name) ?? "").trim() || null;
  const answer = (result: { ok: true } | { ok: false; error: { message: string } }, saved: string): Answer =>
    result.ok ? { saved, intent } : { error: result.error.message, intent };
  switch (intent) {
    case "save": {
      const protocol = String(form.get("protocol") ?? "oidc") as SsoProtocol;
      const config: SsoConfig = {
        issuer: text("issuer"),
        client_id: text("client_id"),
        scopes: text("scopes"),
        authorization_url: text("authorization_url"),
        token_url: text("token_url"),
        userinfo_url: text("userinfo_url"),
        subject_claim: text("subject_claim"),
        email_claim: text("email_claim"),
        idp_entity_id: text("idp_entity_id"),
        idp_sso_url: text("idp_sso_url"),
      };
      const saved = await sso.save(user, slug, {
        protocol,
        config,
        client_secret: text("client_secret"),
        certificate: text("certificate"),
        allow_join: form.get("allow_join") === "on",
      });
      return answer(saved, "Saved.");
    }
    case "required": {
      const required = form.get("required") === "on";
      return answer(await sso.setRequired(user, slug, required), required ? "Single sign-on is required." : "Single sign-on is not required.");
    }
    case "unlink": {
      const username = String(form.get("username") ?? "");
      return answer(await sso.unlink(user, slug, username), `Unlinked ${username}.`);
    }
    case "delete":
      return answer(await sso.remove(user, slug), "Single sign-on is removed.");
    default:
      return { error: "Unknown change.", intent };
  }
}

export default function WorkspaceSso({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings, plan, addresses } = loaderData;
  const slug = params.owner.toLowerCase();
  const free = plan === "free";
  const said = (intent: string) => (actionData?.intent === intent ? actionData : undefined);
  return (
    <div className="max-w-3xl space-y-10">
      <section aria-labelledby="sso-about">
        <h2 id="sso-about" className="flex items-center gap-2 font-medium">
          <KeyRound size={16} className="text-faint" aria-hidden />
          Single sign-on
        </h2>
        <p className="mt-1.5 text-sm text-muted">
          Connect {slug} to your identity provider over OpenID Connect, OAuth 2.0 or SAML. People sign in to g1t as
          themselves, then through your provider to use {slug}: the first time, g1t links who they are there to their g1t
          account. Require it, and members use {slug} only after signing in through it.
        </p>
        {isFailed(plan) ? (
          <div className="mt-4">
            <Unavailable what={plan.what} />
          </div>
        ) : (
          free && <PlanNeeded slug={slug} />
        )}
      </section>

      <ProviderSection
        // Starts from what is saved whenever that changes.
        key={settings.connection?.updated_at ?? "none"}
        settings={settings}
        addresses={addresses}
        disabled={free}
        answer={said("save")}
      />

      {settings.connection && (
        <RequireSection settings={settings} slug={slug} disabled={free} answer={said("required")} />
      )}

      {settings.connection && <PeopleSection settings={settings} answer={said("unlink")} />}

      {settings.connection && (
        <DangerZone>
          <DangerAction
            title="Remove single sign-on"
            action={<RemoveDialog slug={slug} />}
          >
            Forgets the provider and who everyone is there, and stops requiring it. Members keep their place in {slug}.
            {said("delete")?.error && <ErrorText>{said("delete")?.error}</ErrorText>}
          </DangerAction>
        </DangerZone>
      )}
    </div>
  );
}

/** Removing it, once the owner says so in a dialog. */
function RemoveDialog({ slug }: { slug: string }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive">Remove</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove single sign-on from {slug}?</AlertDialogTitle>
          <AlertDialogDescription>
            g1t forgets your provider and who everyone is there, and stops requiring it. Setting it up again links everyone
            afresh.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="delete" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <SubmitButton variant="destructive" match={{ intent: "delete" }} pending="Removing…">
              Remove single sign-on
            </SubmitButton>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** For a free workspace: it is there, and comes with any paid plan. */
function PlanNeeded({ slug }: { slug: string }) {
  return (
    <div role="note" className="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Sparkles size={16} className="hidden shrink-0 text-accent sm:block" aria-hidden />
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">Single sign-on comes with every paid plan</p>
          <p className="mt-1 text-sm text-muted">
            {slug} is a free workspace. Start the plan to connect your identity provider: there is nothing extra to pay
            for it.
          </p>
        </div>
        <span className="shrink-0">
          <ButtonLink to={planHref(slug)}>Start the plan</ButtonLink>
        </span>
      </div>
    </div>
  );
}

function Saved({ answer }: { answer?: Answer }) {
  if (!answer) return null;
  return answer.error ? <ErrorText>{answer.error}</ErrorText> : <span className="text-sm text-success">{answer.saved}</span>;
}

function ProviderSection({
  settings,
  addresses,
  disabled,
  answer,
}: {
  settings: SsoSettings;
  addresses: ReturnType<typeof ssoAddresses>;
  disabled: boolean;
  answer?: Answer;
}) {
  const connection = settings.connection;
  const [protocol, setProtocol] = useState<SsoProtocol>(connection?.protocol ?? "oidc");
  // What is saved for the protocol shown; another protocol starts empty.
  const saved = connection?.protocol === protocol ? connection.config : {};
  const value = (name: keyof SsoConfig) => (saved[name] as string | null | undefined) ?? "";
  const keepsSecret = connection?.protocol === protocol && connection.has_client_secret;
  return (
    <section aria-labelledby="sso-provider">
      <h2 id="sso-provider" className="font-medium">
        Identity provider
      </h2>
      <Form method="post" className="mt-5 space-y-5">
        <input type="hidden" name="intent" value="save" />
        <fieldset disabled={disabled} className="space-y-5 disabled:opacity-60">
          <RadioGroup name="protocol" value={protocol} onValueChange={(next) => setProtocol(next as SsoProtocol)} className="sm:grid-cols-3">
            <RadioOption value="oidc" label={PROTOCOL_NAMES.oidc} description="Okta, Microsoft Entra ID, Google, Auth0 and most others." />
            <RadioOption value="saml" label={PROTOCOL_NAMES.saml} description="For providers set up for SAML apps." />
            <RadioOption value="oauth2" label={PROTOCOL_NAMES.oauth2} description="A provider without OpenID Connect." />
          </RadioGroup>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted">In your provider, set up an app with these</p>
            {protocol === "saml" ? (
              <>
                <Field label="Entity id (audience) and metadata">
                  <CopyLine text={addresses.entityId} breakAtSlashes />
                </Field>
                <Field label="Assertion consumer service (ACS) URL, HTTP-POST">
                  <CopyLine text={addresses.acsUrl} breakAtSlashes />
                </Field>
              </>
            ) : (
              <Field label="Redirect URI (callback)">
                <CopyLine text={addresses.callbackUrl} breakAtSlashes />
              </Field>
            )}
          </div>

          {protocol === "oidc" && (
            <>
              <Field label="Issuer" hint="Where its /.well-known/openid-configuration lives, such as https://acme.okta.com.">
                <Input name="issuer" type="url" required defaultValue={value("issuer")} placeholder="https://" />
              </Field>
              <ClientFields value={value} keepsSecret={keepsSecret} defaultScopes="openid email profile" />
            </>
          )}

          {protocol === "oauth2" && (
            <>
              <Field label="Authorization URL">
                <Input name="authorization_url" type="url" required defaultValue={value("authorization_url")} placeholder="https://" />
              </Field>
              <Field label="Token URL">
                <Input name="token_url" type="url" required defaultValue={value("token_url")} placeholder="https://" />
              </Field>
              <Field label="Userinfo URL" hint="Read with the access token: who signed in.">
                <Input name="userinfo_url" type="url" required defaultValue={value("userinfo_url")} placeholder="https://" />
              </Field>
              <ClientFields value={value} keepsSecret={keepsSecret} defaultScopes="" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Subject claim" hint="The person's stable id in the userinfo answer. sub, then id, when empty.">
                  <Input name="subject_claim" defaultValue={value("subject_claim")} placeholder="sub" />
                </Field>
                <Field label="Email claim" hint="Shown beside each person; never used to sign in.">
                  <Input name="email_claim" defaultValue={value("email_claim")} placeholder="email" />
                </Field>
              </div>
            </>
          )}

          {protocol === "saml" && (
            <>
              <Field label="Identity provider entity id" hint="Its issuer, as its metadata says it.">
                <Input name="idp_entity_id" required defaultValue={value("idp_entity_id")} />
              </Field>
              <Field label="Single sign-on URL" hint="Where it takes SAML requests (HTTP-Redirect).">
                <Input name="idp_sso_url" type="url" required defaultValue={value("idp_sso_url")} placeholder="https://" />
              </Field>
              <Field
                label="Signing certificate"
                hint={
                  connection?.protocol === "saml" && connection.certificates.length > 0 ? (
                    <>
                      Saved, by SHA-256:{" "}
                      {connection.certificates.map((c) => (
                        <span key={c.fingerprint} className="block font-mono break-all">
                          {c.fingerprint}
                        </span>
                      ))}
                      Paste new ones to replace them; several while you rotate.
                    </>
                  ) : (
                    "PEM, starting -----BEGIN CERTIFICATE-----. Sign the assertion or the response with SHA-256, and leave the assertion unencrypted."
                  )
                }
              >
                <Textarea name="certificate" rows={5} required={!(connection?.protocol === "saml" && connection.certificates.length > 0)} />
              </Field>
            </>
          )}

          <SwitchCard name="allow_join" title="Let people from your provider join" defaultChecked={connection?.allow_join ?? true}>
            Anyone your provider signs in becomes a member of the workspace, with no invitation. Off: only members can sign in
            through it.
          </SwitchCard>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton match={{ intent: "save" }} pending="Checking…" disabled={disabled}>
            {connection ? "Save" : "Set up single sign-on"}
          </SubmitButton>
          <Saved answer={answer} />
        </div>
      </Form>
    </section>
  );
}

function ClientFields({ value, keepsSecret, defaultScopes }: { value: (name: keyof SsoConfig) => string; keepsSecret: boolean; defaultScopes: string }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client id">
          <Input name="client_id" required defaultValue={value("client_id")} />
        </Field>
        <Field label="Client secret" hint={keepsSecret ? "Saved, and never shown. Enter a new one to replace it." : "Kept encrypted, and never shown again."}>
          <Input name="client_secret" type="password" autoComplete="new-password" required={!keepsSecret} placeholder={keepsSecret ? "••••••••" : undefined} />
        </Field>
      </div>
      <Field label="Scopes" hint={defaultScopes ? `Space-separated. ${defaultScopes} when empty.` : "Space-separated, as the provider needs to answer userinfo."}>
        <Input name="scopes" defaultValue={value("scopes")} placeholder={defaultScopes} />
      </Field>
    </>
  );
}

function RequireSection({ settings, slug, disabled, answer }: { settings: SsoSettings; slug: string; disabled: boolean; answer?: Answer }) {
  const connection = settings.connection!;
  const [chosen, setChosen] = useState(settings.required);
  const back = encodeURIComponent(`/${slug}/-/sso`);
  // Requiring it needs the owner to have signed in through it; never needed to stop.
  const locked = !settings.required && (disabled || !settings.you_linked);
  return (
    <section aria-labelledby="sso-require">
      <h2 id="sso-require" className="font-medium">
        Test and require
      </h2>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {connection.tested_at ? (
          <Badge tone="success">
            Tested by {connection.tested_by ?? "someone"} <TimeAgo at={connection.tested_at} />
          </Badge>
        ) : (
          <Badge tone="warn">Not tested yet</Badge>
        )}
        <ButtonLink to={`/auth/sso/${slug}?next=${back}`} variant="outline" size="sm">
          {settings.you_linked ? "Sign in through it again" : "Test sign-in"}
        </ButtonLink>
      </div>
      <Form method="post" className="mt-5 space-y-3">
        <input type="hidden" name="intent" value="required" />
        <SwitchCard name="required" title="Require single sign-on" checked={chosen} onCheckedChange={setChosen} disabled={locked}>
          {locked && !disabled
            ? "Sign in through your provider yourself first, with Test sign-in."
            : `Members use ${slug} only from a session that signed in through your provider in the last day, and their access tokens and SSH keys only once they have linked. Owners always can, so a provider that breaks never locks you out. Outside collaborators are not asked.`}
        </SwitchCard>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="outline" size="sm" match={{ intent: "required" }} pending="Saving…" disabled={chosen === settings.required}>
            Save
          </SubmitButton>
          <Saved answer={answer} />
        </div>
      </Form>
    </section>
  );
}

function PeopleSection({ settings, answer }: { settings: SsoSettings; answer?: Answer }) {
  return (
    <section aria-labelledby="sso-people">
      <h2 id="sso-people" className="font-medium">
        Linked people
      </h2>
      <p className="mt-1.5 text-sm text-muted">
        Who has signed in through your provider, and who they are there. Unlink someone to let them link another account
        there; their sessions sign in through it again.
      </p>
      <div className="mt-4">
        {settings.identities.length === 0 ? (
          <p className="text-sm text-faint">No one yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Person</TableHead>
                <TableHead>At your provider</TableHead>
                <TableHead>Last signed in</TableHead>
                <TableHead>
                  <span className="sr-only">Unlink</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.identities.map((identity) => (
                <TableRow key={identity.username}>
                  <TableCell className="font-medium">{identity.display_username ?? identity.username}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted">{identity.email ?? identity.subject}</TableCell>
                  <TableCell className="text-muted">
                    <TimeAgo at={identity.last_used_at} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Form method="post">
                      <input type="hidden" name="intent" value="unlink" />
                      <input type="hidden" name="username" value={identity.username} />
                      <SubmitButton variant="ghost" size="sm" match={{ intent: "unlink", username: identity.username }} pending="Unlinking…">
                        Unlink
                      </SubmitButton>
                    </Form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="mt-2">
          <Saved answer={answer} />
        </div>
      </div>
    </section>
  );
}
