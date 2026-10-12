/**
 * Adding a connector: from the directory (`?directory=<id>`, the entry
 * filled in and what is known about its sign-in said), or by address: a
 * name, an HTTPS address, and how it signs in (not at all, a key sent as
 * a header, or the browser). Once added, the browser signs it in when it
 * needs that, or lands on its page.
 */
import { ArrowLeft, Plug } from "lucide-react";
import { useId, useState } from "react";
import { Form, Link, data, useActionData, useNavigation } from "react-router";

import { type ConnectorView, connectorById, connectorView } from "@g1t/contracts/connectors";
import { type ConnectorAuth, customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/connector-new";
import { agentsAction } from "../../../components/agents/actions.server";
import type { ActionResult } from "../../../components/agents/dialogs";
import { ConnectorMark } from "../../../components/connectors";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { RadioGroup, RadioOption } from "../../../components/ui/radio-group";
import { AUTH_WORDS, readAuth } from "../../../lib/customize";
import { addConnectorThen } from "../../../lib/customize.server";
import { page } from "../../../lib/meta";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Add a connector · Customize · ${params.owner} · g1t` });
}

/** The directory entry asked for, when there is one with an MCP server. */
function entryOf(id: string | null): ConnectorView | null {
  const connector = id ? connectorById(id) : null;
  const view = connector ? connectorView(connector, "workspace") : null;
  return view?.mcp ? view : null;
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ slug: string; owner: boolean; entry: ConnectorView | null }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  return { slug, owner: role === "owner", entry: entryOf(new URL(request.url).searchParams.get("directory")) };
}

export async function action({ params, context, request }: Route.ActionArgs): Promise<Response | ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const entry = entryOf(String(form.get("directory") ?? "") || null);
  const auth: ConnectorAuth = entry ? entry.mcp!.auth : readAuth(form.get("auth"));
  const header = auth === "header" ? { name: String(form.get("header_name") ?? "").trim() || "Authorization", value: String(form.get("value") ?? "") } : null;
  if (entry) return addConnectorThen(slug, viewer, { from: { kind: "directory", id: entry.id }, auth, header });
  const name = String(form.get("name") ?? "").trim();
  const url = String(form.get("url") ?? "").trim();
  if (!name || !url) return { ok: false, intent: "connect", error: "Give the connector a name and its address." };
  return addConnectorThen(slug, viewer, { from: { kind: "address", name, url }, auth, header });
}

export default function ConnectorNew({ loaderData }: Route.ComponentProps) {
  const { slug, owner, entry } = loaderData;
  const result = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod === "POST";
  const [auth, setAuth] = useState<ConnectorAuth>(entry?.mcp?.auth ?? "none");
  const id = useId();
  const error = result && !result.ok ? result.error : null;
  const back = (
    <Link to={`${customizePath("connectors", slug)}?view=discover`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Connectors
    </Link>
  );
  if (!owner) {
    return (
      <div className="space-y-6">
        {back}
        <Alert tone="info">Only the workspace&apos;s owners add connectors. Find one in Discover and choose Request, and they&apos;ll hear about it.</Alert>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {back}
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{entry ? `Connect ${entry.name}` : "Add a connector"}</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          {entry
            ? entry.description
            : "An MCP server the workspace connects once, then gives to agents: every agent, a team's, or one. Its tools become abilities, each with a level, like any other."}
        </p>
      </header>
      <Card asChild className="max-w-2xl p-5">
        <Form method="post" className="grid gap-5">
          {entry ? (
            <>
              <input type="hidden" name="directory" value={entry.id} />
              <div className="flex items-center gap-3">
                <ConnectorMark view={entry} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{entry.name}</p>
                  <p className="truncate font-mono text-xs text-muted">{entry.mcp!.url}</p>
                </div>
              </div>
              <p className="text-sm text-muted">{AUTH_WORDS[entry.mcp!.auth]}.</p>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input id={`${id}-name`} name="name" placeholder="weather" required autoComplete="off" pattern="[a-z0-9][a-z0-9-]{1,31}" spellCheck={false} />
                <FieldDescription>Lowercase letters, digits and hyphens. Agents call its tools as name__tool.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-url`}>Address</FieldLabel>
                <Input id={`${id}-url`} name="url" type="url" placeholder="https://mcp.example.com/mcp" required autoComplete="off" spellCheck={false} />
                <FieldDescription>Where it speaks MCP over HTTPS, on a public host.</FieldDescription>
              </Field>
              <FieldSet>
                <FieldLegend>How it signs in</FieldLegend>
                <RadioGroup name="auth" value={auth} onValueChange={(next) => setAuth(readAuth(next))}>
                  <RadioOption value="none" label="No sign-in" description="Open to anyone, like a documentation server." />
                  <RadioOption value="header" label="A key" description="A header sent with every call, kept sealed." />
                  <RadioOption value="oauth" label="The browser" description="You sign in on the server's own page; g1t keeps the tokens and refreshes them." />
                </RadioGroup>
              </FieldSet>
            </>
          )}
          {entry?.mcp?.caveat && (
            <Alert tone="warn" asChild>
              <p>{entry.mcp.caveat}</p>
            </Alert>
          )}
          {auth === "header" && (
            <>
              <Field>
                <FieldLabel htmlFor={`${id}-header`}>Header</FieldLabel>
                <Input id={`${id}-header`} name="header_name" defaultValue={entry?.mcp?.header ?? "Authorization"} required autoComplete="off" spellCheck={false} className="font-mono" />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-value`}>Value</FieldLabel>
                <Input id={`${id}-value`} name="value" type="password" placeholder="Bearer …" required autoComplete="off" spellCheck={false} className="font-mono" />
                <FieldDescription>The whole value, scheme included. It is sealed when saved and never shown again.</FieldDescription>
              </Field>
            </>
          )}
          {error && (
            <Alert asChild>
              <p role="alert">{error}</p>
            </Alert>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button type="submit" variant="accent" disabled={busy}>
              <Plug size={14} />
              {busy ? (auth === "oauth" ? "Going to sign in…" : "Connecting…") : auth === "oauth" ? "Connect and sign in" : "Connect"}
            </Button>
          </div>
        </Form>
      </Card>
    </div>
  );
}
