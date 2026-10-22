import { AlertTriangle, ArrowLeft, CheckCircle2, Siren, Ticket, X } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, redirect } from "react-router";

import { type Connection, type ConnectionConfig, type Delivery, type Provider, type ProviderKind, PROVIDERS } from "@g1t/contracts";

import type { Route } from "./+types/integrations";
import { page } from "../../lib/meta";
import { ProviderMark, ProviderTiles } from "../../components/connectors";
import { aiPagePath, providerPage, sectionKind } from "../../lib/integration-sections";
import { CopyLine, ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { Combobox } from "../../components/ui/combobox";
import { integrations, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, orElse, part, type Failed } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  const kind = sectionKind(params.section);
  return page(args, { title: `${kind ? KIND_INFO[kind].title : "Integrations"} · ${params.owner} · g1t` });
}

const isProvider = (value: string | null): value is Provider => value != null && value in PROVIDERS;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  // AI providers were set up here: they are the workspace's AI settings now.
  if (params.section === "models") throw redirect(aiPagePath(slug, new URL(request.url).search));
  // One kind of connection's page: the directory at `-/integrations` finds them.
  const kind = sectionKind(params.section);
  if (!kind) throw new Response(null, { status: 404 });
  // The connections are what the page is about. The repositories a new
  // one can file work items from, and what each alert source sent lately, are
  // beside them: each says so in its place when it cannot be read.
  const [connections, listed] = await Promise.all([integrations.list(slug, viewer), part(repos.list(viewer, { namespace: slug }), "Repositories")]);
  const all = unwrap(connections);
  // What each alert source has sent lately, to see it is wired up.
  const deliveries: Record<string, Delivery[] | Failed> = {};
  await Promise.all(
    all
      .filter((connection) => connection.kind === "alerts")
      .map(async (connection) => {
        const found = await part(integrations.deliveries(slug, viewer, connection.id), "What it sent lately");
        deliveries[connection.id] = isFailed(found) ? found : found.ok ? found.value.slice(0, 5) : [];
      }),
  );
  const adding = new URL(request.url).searchParams.get("add");
  return {
    slug,
    role,
    kind,
    connections: all,
    deliveries,
    repos: isFailed(listed) ? listed : listed.map((repo) => `${repo.namespace}/${repo.name}`),
    adding: isProvider(adding) && PROVIDERS[adding].kind === kind ? adding : null,
  };
}

function text(form: FormData, name: string): string | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value || undefined;
}

/** The settings a form describes, for the provider it is for. */
function configFrom(form: FormData): ConnectionConfig {
  const keys = text(form, "keys");
  return {
    repo: text(form, "repo"),
    label: text(form, "label"),
    writeBack: form.get("writeBack") !== "off",
    organization: text(form, "organization"),
    site: text(form, "site"),
    email: text(form, "email"),
    keys: keys ? keys.split(/[\s,]+/).filter(Boolean) : [],
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const intent = form.get("intent");
  const id = String(form.get("id") ?? "");
  if (intent === "disconnect") {
    const removed = await integrations.disconnect(user, slug, id);
    return { error: removed.ok ? null : removed.error.message };
  }
  if (intent === "test") {
    const tested = await integrations.test(user, slug, id);
    return tested.ok ? { tested: { id, ...tested.value } } : { error: tested.error.message };
  }
  if (intent === "update") {
    const updated = await integrations.update(user, slug, id, {
      signingSecret: text(form, "signingSecret"),
      secret: text(form, "secret"),
    });
    return updated.ok ? { updated: id } : { error: updated.error.message };
  }
  const provider = String(form.get("provider") ?? "");
  if (!isProvider(provider)) return { error: "Choose what to connect." };
  const connected = await integrations.connect(user, slug, {
    provider,
    name: text(form, "name"),
    config: configFrom(form),
    secret: text(form, "secret"),
    signingSecret: text(form, "signingSecret"),
  });
  return connected.ok ? { connected: connected.value } : { error: connected.error.message, provider };
}

/** The kinds of connection set up here: AI providers are on the workspace's AI page. */
const KIND_INFO: Record<ProviderKind, { title: string; icon: ReactNode; blurb: string }> = {
  alerts: {
    title: "Alerts",
    icon: <Siren size={16} />,
    blurb: "Problems your monitoring finds become work items, with what was seen.",
  },
  tracker: {
    title: "Trackers",
    icon: <Ticket size={16} />,
    blurb: "Tickets people can import as work items, and that hear back when the work lands.",
  },
};

const PROVIDER_BLURB: Partial<Record<Provider, string>> = {
  sentry: "New errors open work items, with the stack trace. Resolved in Sentry when the fix merges.",
  datadog: "Monitors that trigger open work items. Recoveries are noted on them.",
  webhook: "Anything that can send signed JSON: PagerDuty, Grafana, your own scripts.",
  jira: "Import tickets such as TECH-1234 as work items; they hear back when the work lands.",
  linear: "Import Linear issues such as ENG-42 as work items; they hear back when the work lands.",
};

export default function WorkspaceIntegrations({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, kind, connections, deliveries, adding } = loaderData;
  const repoNames = orElse(loaderData.repos, []);
  // A new connection can still be added without the list to choose a repository from: say why it is empty.
  const owner = role === "owner";
  const reposMissing = isFailed(loaderData.repos) && adding && owner ? <Unavailable what={loaderData.repos.what} compact /> : null;
  const justConnected = actionData && "connected" in actionData ? actionData.connected : null;
  const tested = (actionData && "tested" in actionData ? actionData.tested : null) ?? null;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? null;
  const updated = (actionData && "updated" in actionData ? actionData.updated : null) ?? null;

  return (
    <div>
      <Link to={`/${slug}/-/settings/integrations`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> All integrations
      </Link>
      {justConnected && <Connected connected={justConnected} />}
      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {/* Alerts -------------------------------------------------------------- */}
      {kind === "alerts" && (
        <Section kind="alerts">
          <Connections list={connections.filter((c) => c.kind === "alerts")} owner={owner} tested={tested} updated={updated} deliveries={deliveries} />
          {owner && <Choices kind="alerts" slug={slug} adding={adding} />}
          {adding && PROVIDERS[adding].kind === "alerts" && reposMissing}
          {adding && PROVIDERS[adding].kind === "alerts" && owner && (
            <AddForm provider={adding} slug={slug} repos={repoNames} error={actionData && "provider" in actionData ? error : null} />
          )}
        </Section>
      )}

      {/* Trackers ------------------------------------------------------------ */}
      {kind === "tracker" && (
        <Section kind="tracker">
          <Connections list={connections.filter((c) => c.kind === "tracker")} owner={owner} tested={tested} updated={updated} deliveries={deliveries} />
          {owner && <Choices kind="tracker" slug={slug} adding={adding} />}
          {adding && PROVIDERS[adding].kind === "tracker" && reposMissing}
          {adding && PROVIDERS[adding].kind === "tracker" && owner && (
            <AddForm provider={adding} slug={slug} repos={repoNames} error={actionData && "provider" in actionData ? error : null} />
          )}
        </Section>
      )}

      {!owner && <p className="mt-8 text-sm text-muted">An owner of {slug} can add and remove integrations.</p>}
    </div>
  );
}

/** One kind of connection's page: its heading, then what is connected and what to connect. */
function Section({ kind, children }: { kind: ProviderKind; children: ReactNode }) {
  const info = KIND_INFO[kind];
  return (
    <section className="mt-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight [&_svg]:size-5">
        <span className="text-muted">{info.icon}</span>
        {info.title}
      </h1>
      <p className="mt-1.5 mb-6 border-b border-line pb-6 text-sm text-muted">{info.blurb}</p>
      {children}
    </section>
  );
}

function Connections({
  list,
  owner,
  tested,
  updated,
  deliveries,
}: {
  list: Connection[];
  owner: boolean;
  tested: { id: string; ok: boolean; message: string } | null;
  /** The connection whose secret was just saved. */
  updated: string | null;
  deliveries: Record<string, Delivery[] | Failed>;
}) {
  if (list.length === 0) return null;
  return (
    <Card asChild divided className="mb-4 overflow-hidden">
      <ul>
        {list.map((connection) => (
          <li key={connection.id} className="p-4">
            <ConnectionRow
              connection={connection}
              owner={owner}
              tested={tested}
              updated={updated === connection.id}
              deliveries={deliveries[connection.id] ?? []}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Just the host of an address, which is what tells connections apart. */
function host(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ConnectionRow({
  connection,
  owner,
  tested,
  updated,
  deliveries,
}: {
  connection: Connection;
  owner: boolean;
  tested: { id: string; ok: boolean; message: string } | null;
  updated: boolean;
  deliveries: Delivery[] | Failed;
}) {
  const { config } = connection;
  const facts = [
    PROVIDERS[connection.provider].label,
    config.repo && `work items filed from ${config.repo}`,
    config.organization,
    host(config.site),
    config.keys?.length ? config.keys.join(", ") : null,
    connection.secretHint && `key ${connection.secretHint}`,
  ].filter(Boolean);
  // Unread deliveries say nothing about whether its secret was set.
  const waitingForSecret = connection.provider === "sentry" && !isFailed(deliveries) && !deliveries.length && !connection.lastUsedAt;
  return (
    <div>
      <div className="flex items-center gap-3">
        <ProviderMark provider={connection.provider} />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium">{connection.name}</p>
          <p className="truncate text-xs text-muted">{facts.join(" · ")}</p>
        </div>
        {connection.lastUsedAt && (
          <span className="hidden shrink-0 text-xs text-faint sm:inline">
            Used <TimeAgo at={connection.lastUsedAt} />
          </span>
        )}
        {owner && (
          <Form method="post" className="flex shrink-0 gap-2">
            <input type="hidden" name="id" value={connection.id} />
            <SubmitButton variant="outline" name="intent" value="test" match={{ id: connection.id }} pending="Testing…">
              Test
            </SubmitButton>
            <SubmitButton variant="outline" name="intent" value="disconnect" match={{ id: connection.id }} pending="Disconnecting…" aria-label="Disconnect">
              <X size={14} />
            </SubmitButton>
          </Form>
        )}
      </div>
      {tested?.id === connection.id && <p className={`mt-3 text-sm ${tested.ok ? "text-success" : "text-danger"}`}>{tested.message}</p>}
      {connection.lastError && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warn">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {connection.lastError}
        </p>
      )}
      {connection.webhookUrl && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs text-faint">Where it sends alerts</p>
          <CopyLine text={connection.webhookUrl} />
        </div>
      )}
      {owner && waitingForSecret && (
        <Form method="post" className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="id" value={connection.id} />
          <div className="min-w-64 grow">
            <Field label="Client secret" hint="From the internal integration's page in Sentry, once it has this address. Leave it if it is already saved.">
              <Input name="signingSecret" type="password" placeholder="Paste to replace" />
            </Field>
          </div>
          <SubmitButton variant="outline" match={{ intent: "update", id: connection.id }} pending="Saving…">
            Save
          </SubmitButton>
          {updated && <span className="pb-2 text-sm text-muted">Saved.</span>}
        </Form>
      )}
      {isFailed(deliveries) ? (
        <div className="mt-3">
          <Unavailable what={deliveries.what} compact />
        </div>
      ) : (
        deliveries.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="flex items-center gap-2 text-muted">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    delivery.outcome === "refused" ? "bg-danger" : delivery.outcome === "ignored" ? "bg-faint" : "bg-success"
                  }`}
                />
                <span className="font-mono text-faint">{delivery.event}</span>
                <span className="min-w-0 truncate">{delivery.detail}</span>
                {delivery.item && (
                  <Link to={`/${delivery.item.replace("#", "/-/work/")}`} className="shrink-0 font-mono text-fg hover:underline">
                    {delivery.item}
                  </Link>
                )}
                <span className="ml-auto shrink-0 text-faint">
                  <TimeAgo at={delivery.receivedAt} />
                </span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}

/** What a provider is for, in a line. */
function blurb(provider: Provider): string {
  return PROVIDER_BLURB[provider] ?? "";
}

function Choices({ kind, slug, adding }: { kind: ProviderKind; slug: string; adding: Provider | null }) {
  const providers = (Object.keys(PROVIDERS) as Provider[]).filter((p) => PROVIDERS[p].kind === kind);
  return (
    <div className="mt-3">
      <ProviderTiles providers={providers} slug={slug} adding={adding} blurb={blurb} />
    </div>
  );
}

function RepoField({ repos, required, hint }: { repos: string[]; required?: boolean; hint: string }) {
  return (
    <Field label="Repository" hint={hint}>
      <Combobox
        name="repo"
        defaultValue={repos[0] ?? ""}
        aria-label="Repository"
        placeholder={repos.length === 0 ? "No repositories yet" : "Choose a repository"}
        searchPlaceholder="Find a repository"
        emptyText="No repository by that name."
        options={[
          ...(required ? [] : [{ value: "", label: "None" }]),
          ...repos.map((repo) => ({ value: repo, label: repo, icon: <Avatar name={repo.split("/").pop() ?? repo} size={16} square /> })),
        ]}
        className="font-mono text-[0.8125rem]"
      />
    </Field>
  );
}

function AddForm({ provider, slug, repos, error }: { provider: Provider; slug: string; repos: string[]; error: string | null }) {
  const fields: Partial<Record<Provider, ReactNode>> = {
    sentry: (
      <>
        <Field label="Organization" hint="Its slug, as in acme.sentry.io.">
          <Input name="organization" required placeholder="acme" />
        </Field>
        <RepoField repos={repos} required hint="The repository its work items are filed from." />
        <Field
          label="Auth token"
          hint="The internal integration's token, with Issue & Event read and write. Lets g1t read stack traces and resolve Sentry issues. Optional, but recommended."
        >
          <Input name="secret" type="password" />
        </Field>
        <Field label="Client secret" hint="You get this from Sentry after giving it this connection's address; you can add it on the next step.">
          <Input name="signingSecret" type="password" />
        </Field>
      </>
    ),
    datadog: (
      <>
        <RepoField repos={repos} required hint="The repository its work items are filed from." />
      </>
    ),
    webhook: (
      <>
        <RepoField repos={repos} required hint="The repository its work items are filed from." />
      </>
    ),
    jira: (
      <>
        <Field label="Site" hint="Your Jira's address.">
          <Input name="site" type="url" required placeholder="https://acme.atlassian.net" />
        </Field>
        <Field label="Email" hint="The account the API token belongs to.">
          <Input name="email" type="email" required autoComplete="off" />
        </Field>
        <Field label="API token" hint="From id.atlassian.com → Security → API tokens.">
          <Input name="secret" type="password" required />
        </Field>
        <Field label="Project keys" hint="Optional. The projects this answers for, such as TECH, OPS. Empty answers for any key.">
          <Input name="keys" placeholder="TECH, OPS" />
        </Field>
      </>
    ),
    linear: (
      <>
        <Field label="API key" hint="From Linear → Settings → Security & access → Personal API keys.">
          <Input name="secret" type="password" required placeholder="lin_api_…" />
        </Field>
        <Field label="Team keys" hint="Optional. Such as ENG. Empty answers for any key.">
          <Input name="keys" placeholder="ENG" />
        </Field>
      </>
    ),
  };
  return (
    <Card asChild className="mt-4 scroll-mt-[calc(var(--topbar-h)+1rem)] p-5">
      <section id="add">
        <div className="flex items-center gap-3">
          <ProviderMark provider={provider} />
          <div className="grow">
            <h3 className="font-medium">Connect {PROVIDERS[provider].label}</h3>
            <p className="text-xs text-muted">{blurb(provider)}</p>
          </div>
          <Link
            to={`/${slug}/-/${providerPage(PROVIDERS[provider].kind)}`}
            className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg"
            aria-label="Close"
          >
            <X size={16} />
          </Link>
        </div>
        <Form method="post" className="mt-5 grid max-w-xl gap-4">
          <input type="hidden" name="provider" value={provider} />
          {fields[provider]}
          <ErrorText>{error}</ErrorText>
          <div>
            <SubmitButton match={{ provider }} pending="Connecting…">
              Connect
            </SubmitButton>
          </div>
        </Form>
      </section>
    </Card>
  );
}

/** What to do next, right after connecting: shown once. */
function Connected({ connected }: { connected: { connection: Connection; signingSecret: string | null } }) {
  const { connection, signingSecret } = connected;
  const url = connection.webhookUrl;
  return (
    <div className="mt-6 rounded-xl border border-success-dim/60 bg-success/5 p-5">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 size={16} className="text-success" />
        {connection.name} is connected.
      </p>
      {connection.provider === "sentry" && url && (
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>In Sentry, open Settings → Developer Settings → Custom Integrations, and create an internal integration.</li>
          <li>
            Set its webhook URL to <CopyLine text={url} />
          </li>
          <li>Turn on Alert Rule Action, and under Webhooks, tick issue.</li>
          <li>Give it Issue &amp; Event read and write, save, and paste its client secret below, on the connection.</li>
        </ol>
      )}
      {(connection.provider === "datadog" || connection.provider === "webhook") && url && signingSecret && (
        <div className="mt-3 space-y-3 text-sm text-muted">
          <p>This secret is shown once. Copy it now.</p>
          <CopyLine text={signingSecret} />
          {connection.provider === "datadog" ? (
            <>
              <p>
                In Datadog, open Integrations → Webhooks and add one named <code>g1t</code> with this URL:
              </p>
              <CopyLine text={url} />
              <p>Custom headers:</p>
              <CopyLine text={`{"Authorization": "Bearer ${signingSecret}"}`} />
              <p>Payload:</p>
              <CopyLine
                text={`{"id": "$ALERT_ID", "title": "$EVENT_TITLE", "body": "$EVENT_MSG", "url": "$LINK", "status": "$ALERT_TRANSITION", "priority": "$PRIORITY"}`}
              />
              <p>
                Then mention <code>@webhook-g1t</code> in any monitor's message.
              </p>
            </>
          ) : (
            <>
              <p>Send JSON with at least a title to:</p>
              <CopyLine text={url} />
              <p>
                with <code>Authorization: Bearer &lt;secret&gt;</code>, or an HMAC-SHA256 of the body in <code>X-G1t-Signature</code>. An <code>id</code> keeps
                repeats on one work item.
              </p>
            </>
          )}
        </div>
      )}
      {connection.kind === "tracker" && (
        <p className="mt-2 text-sm text-muted">You can import a ticket from New work item, under Work. Use Test to check the token.</p>
      )}
    </div>
  );
}
