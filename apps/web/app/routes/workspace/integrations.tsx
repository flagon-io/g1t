import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Plug,
  Siren,
  Ticket,
  Webhook,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, useNavigation } from "react-router";

import {
  type Connection,
  type ConnectionConfig,
  type Delivery,
  type Provider,
  type ProviderKind,
  PROVIDERS,
} from "@g1t/contracts";

import type { Route } from "./+types/integrations";
import { Button, CopyLine, ErrorText, Field, Input, Pill, TimeAgo } from "../../components/ui";
import { billing, integrations, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Integrations · ${params.owner} · g1t` }];
}

const isProvider = (value: string | null): value is Provider => value != null && value in PROVIDERS;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [connections, listed, account] = await Promise.all([
    integrations.list(slug, viewer),
    repos.list(viewer, { namespace: slug }),
    billing.account(slug, viewer),
  ]);
  const all = unwrap(connections);
  // What each alert source has sent lately, to see it is wired up.
  const deliveries: Record<string, Delivery[]> = {};
  await Promise.all(
    all
      .filter((connection) => connection.kind === "alerts")
      .map(async (connection) => {
        const found = await integrations.deliveries(slug, viewer, connection.id);
        deliveries[connection.id] = found.ok ? found.value.slice(0, 5) : [];
      }),
  );
  const adding = new URL(request.url).searchParams.get("add");
  return {
    slug,
    role,
    connections: all,
    deliveries,
    repos: listed.map((repo) => `${repo.namespace}/${repo.name}`),
    adding: isProvider(adding) ? adding : null,
    feeMicros: account.ok ? account.value.orchestrationFeeMicros : 100_000,
    marginPercent: account.ok ? account.value.marginPercent : 20,
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
    assign: form.get("assign") === "on",
    label: text(form, "label"),
    writeBack: form.get("writeBack") !== "off",
    organization: text(form, "organization"),
    site: text(form, "site"),
    email: text(form, "email"),
    keys: keys ? keys.split(/[\s,]+/).filter(Boolean) : [],
    baseUrl: text(form, "baseUrl"),
    authHeader: text(form, "authHeader"),
    model: text(form, "model"),
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
    return { error: updated.ok ? null : updated.error.message };
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

const KIND_INFO: Record<ProviderKind, { title: string; icon: ReactNode; blurb: string }> = {
  models: {
    title: "Model provider",
    icon: <Cpu size={16} />,
    blurb: "Where your agents' model requests go, and who pays for them.",
  },
  alerts: {
    title: "Alerts",
    icon: <Siren size={16} />,
    blurb: "Problems your monitoring finds become issues, and agents can start on them before anyone looks.",
  },
  tracker: {
    title: "Trackers",
    icon: <Ticket size={16} />,
    blurb: "Tickets agents can read when work mentions them, that people can import as issues, and that hear back when the work lands.",
  },
};

const PROVIDER_BLURB: Record<Provider, string> = {
  anthropic: "Use your own Anthropic API key. Anthropic bills you for the models.",
  anthropic_endpoint: "Any Anthropic-compatible endpoint: your own AI Gateway, LiteLLM, Bedrock or Vertex behind a proxy.",
  sentry: "New errors open issues, with the stack trace. Resolved in Sentry when the fix merges.",
  datadog: "Monitors that trigger open issues. Recoveries are noted on them.",
  webhook: "Anything that can send signed JSON: PagerDuty, Grafana, your own scripts.",
  jira: "Agents read TECH-1234 when work mentions it. Import tickets; they hear back.",
  linear: "Agents read ENG-42 when work mentions it. Import issues; they hear back.",
};

/** A small mark for each provider: its initial, in a tile. */
function ProviderMark({ provider, size = 32 }: { provider: Provider; size?: number }) {
  const hue: Record<Provider, number> = {
    anthropic: 40,
    anthropic_endpoint: 280,
    sentry: 300,
    datadog: 290,
    webhook: 200,
    jira: 250,
    linear: 265,
  };
  const icon =
    provider === "webhook" ? <Webhook size={size * 0.5} /> : provider === "anthropic_endpoint" ? <Bot size={size * 0.5} /> : null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        fontSize: size * 0.42,
        background: `oklch(0.3 0.06 ${hue[provider]})`,
        color: `oklch(0.9 0.08 ${hue[provider]})`,
      }}
    >
      {icon ?? PROVIDERS[provider].label[0]}
    </span>
  );
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

export default function WorkspaceIntegrations({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, connections, deliveries, repos: repoNames, adding, feeMicros, marginPercent } = loaderData;
  const owner = role === "owner";
  const busy = useNavigation().state === "submitting";
  const model = connections.find((connection) => connection.kind === "models");
  const justConnected = actionData && "connected" in actionData ? actionData.connected : null;
  const tested = (actionData && "tested" in actionData ? actionData.tested : null) ?? null;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? null;

  return (
    <div className="max-w-4xl">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-lg bg-surface p-2 text-muted ring-1 ring-line">
          <Plug size={18} />
        </span>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Integrations</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Connect {slug} to the systems your work already lives in. g1t keeps secrets sealed and never
            shows them again; agents never see them at all.
          </p>
        </div>
      </div>

      {justConnected && <Connected connected={justConnected} />}
      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {/* Models -------------------------------------------------------------- */}
      <Section kind="models">
        <div className="rounded-xl border border-line bg-surface p-4">
          {model ? (
            <ConnectionRow connection={model} owner={owner} busy={busy} tested={tested} deliveries={[]} />
          ) : (
            <div className="flex items-center gap-3">
              <span className="inline-flex size-8 items-center justify-center rounded-lg bg-merged/15 text-merged ring-1 ring-merged/30">
                <CheckCircle2 size={16} />
              </span>
              <div className="min-w-0 grow">
                <p className="text-sm font-medium">g1t's models</p>
                <p className="text-xs text-muted">
                  The default. g1t picks the model for each kind of work and charges your credit what it
                  cost, plus {marginPercent}%.
                </p>
              </div>
              <Pill>In use</Pill>
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-faint">
          With your own provider, its bill is yours and g1t charges {dollars(feeMicros)} a run for the
          sandbox and orchestration. Your key goes only from g1t's model proxy to your provider: the
          agent's sandbox holds a token that dies with the run.
        </p>
        {!model && owner && <Choices kind="models" slug={slug} adding={adding} />}
      </Section>

      {/* Alerts -------------------------------------------------------------- */}
      <Section kind="alerts">
        <Connections
          list={connections.filter((c) => c.kind === "alerts")}
          owner={owner}
          busy={busy}
          tested={tested}
          deliveries={deliveries}
        />
        {owner && <Choices kind="alerts" slug={slug} adding={adding} />}
      </Section>

      {/* Trackers ------------------------------------------------------------ */}
      <Section kind="tracker">
        <Connections
          list={connections.filter((c) => c.kind === "tracker")}
          owner={owner}
          busy={busy}
          tested={tested}
          deliveries={deliveries}
        />
        {owner && <Choices kind="tracker" slug={slug} adding={adding} />}
      </Section>

      {adding && owner && (
        <AddForm
          provider={adding}
          slug={slug}
          repos={repoNames}
          busy={busy}
          error={actionData && "provider" in actionData ? error : null}
        />
      )}
      {!owner && <p className="mt-8 text-sm text-muted">An owner of {slug} can add and remove integrations.</p>}
    </div>
  );
}

function Section({ kind, children }: { kind: ProviderKind; children: ReactNode }) {
  const info = KIND_INFO[kind];
  return (
    <section className="mt-10">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className="text-muted">{info.icon}</span>
        {info.title}
      </h3>
      <p className="mt-1 mb-4 text-sm text-muted">{info.blurb}</p>
      {children}
    </section>
  );
}

function Connections({
  list,
  owner,
  busy,
  tested,
  deliveries,
}: {
  list: Connection[];
  owner: boolean;
  busy: boolean;
  tested: { id: string; ok: boolean; message: string } | null;
  deliveries: Record<string, Delivery[]>;
}) {
  if (list.length === 0) return null;
  return (
    <ul className="mb-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {list.map((connection) => (
        <li key={connection.id} className="p-4">
          <ConnectionRow
            connection={connection}
            owner={owner}
            busy={busy}
            tested={tested}
            deliveries={deliveries[connection.id] ?? []}
          />
        </li>
      ))}
    </ul>
  );
}

function ConnectionRow({
  connection,
  owner,
  busy,
  tested,
  deliveries,
}: {
  connection: Connection;
  owner: boolean;
  busy: boolean;
  tested: { id: string; ok: boolean; message: string } | null;
  deliveries: Delivery[];
}) {
  const { config } = connection;
  const facts = [
    PROVIDERS[connection.provider].label,
    config.repo && `issues in ${config.repo}`,
    config.assign && "agents start at once",
    config.organization,
    config.site?.replace(/^https:\/\//, ""),
    config.baseUrl?.replace(/^https:\/\//, ""),
    config.model && `model ${config.model}`,
    config.keys?.length ? config.keys.join(", ") : null,
    connection.secretHint && `key ${connection.secretHint}`,
  ].filter(Boolean);
  const waitingForSecret = connection.provider === "sentry" && !deliveries.length && !connection.lastUsedAt;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <ProviderMark provider={connection.provider} />
        <div className="min-w-0 grow">
          <p className="truncate text-sm font-medium">{connection.name}</p>
          <p className="truncate text-xs text-muted">{facts.join(" · ")}</p>
        </div>
        {connection.lastUsedAt && (
          <span className="text-xs text-faint">
            Used <TimeAgo at={connection.lastUsedAt} />
          </span>
        )}
        {owner && (
          <Form method="post" className="flex gap-2">
            <input type="hidden" name="id" value={connection.id} />
            <Button variant="quiet" type="submit" name="intent" value="test" disabled={busy}>
              Test
            </Button>
            <Button variant="quiet" type="submit" name="intent" value="disconnect" disabled={busy} aria-label="Disconnect">
              <X size={14} />
            </Button>
          </Form>
        )}
      </div>
      {tested?.id === connection.id && (
        <p className={`mt-3 text-sm ${tested.ok ? "text-accent" : "text-danger"}`}>{tested.message}</p>
      )}
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
          <Button type="submit" variant="quiet" disabled={busy}>
            Save
          </Button>
        </Form>
      )}
      {deliveries.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {deliveries.map((delivery) => (
            <li key={delivery.id} className="flex items-center gap-2 text-muted">
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  delivery.outcome === "refused"
                    ? "bg-danger"
                    : delivery.outcome === "ignored"
                      ? "bg-faint"
                      : "bg-accent"
                }`}
              />
              <span className="font-mono text-faint">{delivery.event}</span>
              <span className="min-w-0 truncate">{delivery.detail}</span>
              {delivery.issue && (
                <Link
                  to={`/${delivery.issue.replace("#", "/issues/")}`}
                  className="shrink-0 font-mono text-fg hover:underline"
                >
                  {delivery.issue}
                </Link>
              )}
              <span className="ml-auto shrink-0 text-faint">
                <TimeAgo at={delivery.receivedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Choices({ kind, slug, adding }: { kind: ProviderKind; slug: string; adding: Provider | null }) {
  const providers = (Object.keys(PROVIDERS) as Provider[]).filter((p) => PROVIDERS[p].kind === kind);
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {providers.map((provider) => (
        <Link
          key={provider}
          to={`/${slug}/-/integrations?add=${provider}#add`}
          preventScrollReset
          className={`group flex items-start gap-3 rounded-xl border p-3.5 transition-colors ${
            adding === provider ? "border-accent-dim bg-surface" : "border-line hover:border-line-strong hover:bg-surface"
          }`}
        >
          <ProviderMark provider={provider} size={28} />
          <span className="min-w-0 grow">
            <span className="flex items-center gap-1 text-sm font-medium">
              {PROVIDERS[provider].label}
              <ChevronRight size={13} className="text-faint transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">{PROVIDER_BLURB[provider]}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function RepoField({ repos, required, hint }: { repos: string[]; required?: boolean; hint: string }) {
  return (
    <Field label="Repository" hint={hint}>
      <select
        name="repo"
        required={required}
        defaultValue={repos[0] ?? ""}
        className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none hover:border-line-strong focus:border-accent-dim"
      >
        {!required && <option value="">None</option>}
        {repos.map((repo) => (
          <option key={repo} value={repo}>
            {repo}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AssignField() {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input type="checkbox" name="assign" className="mt-1 accent-[var(--color-accent)]" />
      <span>
        <span className="font-medium">Put a g1t agent on each new issue</span>
        <span className="block text-xs text-muted">
          It opens a pull request, gets reviewed, and lands through your merge rules, before anyone has
          to look. Agents run only where g1t agents are enabled.
        </span>
      </span>
    </label>
  );
}

function AddForm({
  provider,
  slug,
  repos,
  busy,
  error,
}: {
  provider: Provider;
  slug: string;
  repos: string[];
  busy: boolean;
  error: string | null;
}) {
  const fields: Record<Provider, ReactNode> = {
    anthropic: (
      <Field label="API key" hint="From console.anthropic.com. Sealed when saved; nobody sees it again.">
        <Input name="secret" type="password" required placeholder="sk-ant-…" />
      </Field>
    ),
    anthropic_endpoint: (
      <>
        <Field label="Base URL" hint="Without /v1. For a Cloudflare AI Gateway: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic">
          <Input name="baseUrl" type="url" required placeholder="https://llm.example.com" />
        </Field>
        <Field label="Key" hint="Optional, if the endpoint needs one.">
          <Input name="secret" type="password" />
        </Field>
        <Field label="Send the key as">
          <select name="authHeader" className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm">
            <option value="x-api-key">x-api-key</option>
            <option value="authorization">Authorization: Bearer</option>
          </select>
        </Field>
        <Field label="Model" hint="Optional. Leave empty to use g1t's choice for each kind of work; set it if your endpoint names models its own way.">
          <Input name="model" placeholder="claude-sonnet-5-5" />
        </Field>
      </>
    ),
    sentry: (
      <>
        <Field label="Organization" hint="Its slug, as in acme.sentry.io.">
          <Input name="organization" required placeholder="acme" />
        </Field>
        <RepoField repos={repos} required hint="Where issues are opened." />
        <Field label="Auth token" hint="The internal integration's token, with Issue & Event read and write. Lets g1t read stack traces and resolve issues. Optional, but recommended.">
          <Input name="secret" type="password" />
        </Field>
        <Field label="Client secret" hint="You get this from Sentry after giving it this connection's address; you can add it on the next step.">
          <Input name="signingSecret" type="password" />
        </Field>
        <AssignField />
      </>
    ),
    datadog: (
      <>
        <RepoField repos={repos} required hint="Where issues are opened." />
        <AssignField />
      </>
    ),
    webhook: (
      <>
        <RepoField repos={repos} required hint="Where issues are opened." />
        <AssignField />
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
    <section id="add" className="mt-10 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-3">
        <ProviderMark provider={provider} />
        <div className="grow">
          <h3 className="font-medium">Connect {PROVIDERS[provider].label}</h3>
          <p className="text-xs text-muted">{PROVIDER_BLURB[provider]}</p>
        </div>
        <Link to={`/${slug}/-/integrations`} className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg" aria-label="Close">
          <X size={16} />
        </Link>
      </div>
      <Form method="post" className="mt-5 grid max-w-xl gap-4">
        <input type="hidden" name="provider" value={provider} />
        {fields[provider]}
        <ErrorText>{error}</ErrorText>
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </Form>
    </section>
  );
}

/** What to do next, right after connecting: shown once. */
function Connected({ connected }: { connected: { connection: Connection; signingSecret: string | null } }) {
  const { connection, signingSecret } = connected;
  const url = connection.webhookUrl;
  return (
    <div className="mt-6 rounded-xl border border-accent-dim/60 bg-accent/5 p-5">
      <p className="flex items-center gap-2 font-medium">
        <CheckCircle2 size={16} className="text-accent" />
        {connection.name} is connected.
      </p>
      {connection.provider === "sentry" && url && (
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>
            In Sentry, open Settings → Developer Settings → Custom Integrations, and create an internal
            integration.
          </li>
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
                with <code>Authorization: Bearer &lt;secret&gt;</code>, or an HMAC-SHA256 of the body in{" "}
                <code>X-G1t-Signature</code>. An <code>id</code> keeps repeats on one issue.
              </p>
            </>
          )}
        </div>
      )}
      {connection.kind === "tracker" && (
        <p className="mt-2 text-sm text-muted">
          Agents now read tickets that work mentions, and you can import one from any repository's new
          issue page. Use Test to check the token.
        </p>
      )}
      {connection.kind === "models" && (
        <p className="mt-2 text-sm text-muted">
          The next agent run uses it. Use Test to check the key.
        </p>
      )}
    </div>
  );
}
