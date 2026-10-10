import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Siren,
  Ticket,
  X,
} from "lucide-react";
import { env } from "cloudflare:workers";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import {
  type Connection,
  type ConnectionConfig,
  type Delivery,
  MODEL_TASKS,
  type ModelRoute,
  type Provider,
  type ProviderKind,
  PROVIDERS,
  gatewayPatterns,
} from "@g1t/contracts";

import type { Route } from "./+types/integrations";
import { page } from "../../lib/meta";
import { trialClosed } from "../../lib/trial";
import { GatewayModelsField, MODEL_CATALOG, ModelCatalog, ModelProviderFields, ProviderMark, ProviderTiles, Routing } from "../../components/model-providers";
import { parseGatewayModels } from "../../lib/gateway";
import { integrationsSection, sectionKind } from "../../lib/integration-sections";
import { money } from "../../lib/money";
import { CopyLine, ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Combobox } from "../../components/ui/combobox";
import { billing, integrations, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  const kind = sectionKind(params.section);
  return page(args, { title: `${kind ? KIND_INFO[kind].title : "Integrations"} · ${params.owner} · g1t` });
}

const isProvider = (value: string | null): value is Provider => value != null && value in PROVIDERS;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // One kind of connection's page: the directory at `-/integrations` finds them.
  const kind = sectionKind(params.section);
  if (!role || !kind) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const [connections, listed, account, access, routes] = await Promise.all([
    integrations.list(slug, viewer),
    repos.list(viewer, { namespace: slug }),
    billing.account(slug, viewer),
    env.RUNNER.modelAccess(slug),
    integrations.routes(slug, viewer),
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
    kind,
    connections: all,
    deliveries,
    repos: listed.map((repo) => `${repo.namespace}/${repo.name}`),
    adding: isProvider(adding) ? adding : null,
    hostedOpen: access.hosted,
    hostedPreview: access.preview,
    trial: access.trial,
    routes: routes.ok ? routes.value : [],
    free: account.ok ? Boolean(account.value.status.free) : false,
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
    // Only a model provider's form has the field; empty means none.
    gatewayModels: form.has("gatewayModels") ? parseGatewayModels(String(form.get("gatewayModels"))) : undefined,
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
  if (intent === "routes") {
    const routes: ModelRoute[] = [];
    for (const task of MODEL_TASKS) {
      const choice = String(form.get(`route-${task}`) ?? "");
      if (!choice) continue;
      if (choice === "g1t") routes.push({ task, connectionId: null, model: null });
      else if (choice.startsWith("g1t::")) routes.push({ task, connectionId: null, model: choice.slice("g1t::".length) || null });
      else {
        const [connectionId, model] = choice.split("::");
        routes.push({ task, connectionId, model: model || null });
      }
    }
    const saved = await integrations.setRoutes(user, slug, routes);
    return saved.ok ? { routed: true } : { error: saved.error.message };
  }
  if (intent === "gateway") {
    // A model provider's AI Gateway models, and a new key if one was given:
    // its other settings as they are.
    const listed = await integrations.list(slug, user);
    const connection = listed.ok ? listed.value.find((c) => c.id === id) : undefined;
    if (!connection) return { error: listed.ok ? "No such integration." : listed.error.message };
    const updated = await integrations.update(user, slug, id, {
      config: { ...connection.config, gatewayModels: parseGatewayModels(String(form.get("gatewayModels") ?? "")) },
      secret: text(form, "secret"),
    });
    return updated.ok ? { updated: id } : { error: updated.error.message };
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

const KIND_INFO: Record<ProviderKind, { title: string; icon: ReactNode; blurb: string }> = {
  models: {
    title: "Model providers",
    icon: <Cpu size={16} />,
    blurb: "Connect as many as you use, then choose which model does which work, and so who pays for it.",
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

const PROVIDER_BLURB: Partial<Record<Provider, string>> = {
  sentry: "New errors open issues, with the stack trace. Resolved in Sentry when the fix merges.",
  datadog: "Monitors that trigger open issues. Recoveries are noted on them.",
  webhook: "Anything that can send signed JSON: PagerDuty, Grafana, your own scripts.",
  jira: "Agents read TECH-1234 when work mentions it. Import tickets; they hear back.",
  linear: "Agents read ENG-42 when work mentions it. Import issues; they hear back.",
};

export default function WorkspaceIntegrations({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, role, kind, connections, deliveries, repos: repoNames, adding, free, marginPercent, hostedOpen, hostedPreview, trial, routes } =
    loaderData;
  const owner = role === "owner";
  const modelConnections = connections.filter((connection) => connection.kind === "models");
  const justConnected = actionData && "connected" in actionData ? actionData.connected : null;
  const tested = (actionData && "tested" in actionData ? actionData.tested : null) ?? null;
  const error = (actionData && "error" in actionData ? actionData.error : null) ?? null;
  const updated = (actionData && "updated" in actionData ? actionData.updated : null) ?? null;

  return (
    <div>
      <Link to={`/${slug}/-/integrations`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> All integrations
      </Link>
      {justConnected && <Connected connected={justConnected} />}
      <div className="mt-4">
        <ErrorText>{error}</ErrorText>
      </div>

      {/* Models -------------------------------------------------------------- */}
      {kind === "models" && (
      <Section kind="models">
        {!hostedOpen && modelConnections.length === 0 && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-warn/30 bg-warn/5 p-4">
            <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-warn/10 text-warn ring-1 ring-warn/30">
              <AlertTriangle size={16} />
            </span>
            <p className="text-sm text-muted">
              <span className="font-medium text-fg">Choose how your agents reach a model.</span>{" "}
              {hostedPreview
                ? `During the preview, g1t's hosted models run only for a few invited workspaces, and ${slug} is not one of them yet.`
                : (trialClosed(trial, slug) ?? `g1t's hosted models are not open to ${slug}.`)}{" "}
              Connect a provider of your own below and your agents start at once, billed by that provider.
            </p>
          </div>
        )}
        <Connections list={modelConnections} owner={owner} tested={tested} updated={updated} deliveries={deliveries} />
        {modelConnections.length === 0 && hostedOpen && (
          <Card asChild className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            <p>
              <CheckCircle2 size={15} className="shrink-0 text-accent" />
              {trial?.open
                ? trial.granted
                  ? `All work runs on g1t's models, paid by ${slug}'s trial credit first: ${money(Math.max(0, trial.limitMicros - trial.usedMicros))} of ${money(trial.limitMicros)} left. Connect a provider of your own for more, or to choose models.`
                  : `All work runs on g1t's models. ${slug} gets ${money(trial.limitMicros)} of trial credit the first time its agents work. Connect a provider of your own for more, or to choose models.`
                : free
                  ? "All work runs on g1t's models, free while g1t is being built out. Connect a provider of your own to choose models and pay for them there."
                  : "All work runs on g1t's models, charged to your AI credit at the provider's price plus the agent rate. Auto picks the model for each job; choose one per kind of work below, or connect a provider of your own and pay for its models there."}
            </p>
          </Card>
        )}
        {(modelConnections.length > 0 || hostedOpen) && (
        <Routing
          // Started again from what is saved whenever that changes, such as a provider disconnected.
          key={JSON.stringify([routes, modelConnections.map((c) => c.id)])}
          connections={modelConnections}
          routes={routes}
          hostedOpen={hostedOpen}
          owner={owner}
          saved={actionData != null && "routed" in actionData}
        />
        )}
        <p className="mt-3 text-xs text-faint">
          On your own providers, their bills are yours.{" "}
          {free
            ? `g1t charges nothing while it is being built out; once pricing starts, each run's sandbox time at cost plus ${marginPercent}%, and the agent rate on the tokens it used.`
            : `g1t charges each run's sandbox time at cost plus ${marginPercent}%, and the agent rate on the tokens it used, shown on Usage as "Agent rate, your own model key".`}{" "}
          Keys go only from g1t's model proxy to the provider: the agent's
          sandbox holds a token that dies with the run.
        </p>
        {owner && <ModelCatalog slug={slug} adding={adding} />}
        {adding && PROVIDERS[adding].kind === "models" && owner && (
          <AddForm
            provider={adding}
            slug={slug}
            repos={repoNames}
            error={actionData && "provider" in actionData ? error : null}
          />
        )}
      </Section>
      )}

      {/* Alerts -------------------------------------------------------------- */}
      {kind === "alerts" && (
      <Section kind="alerts">
        <Connections
          list={connections.filter((c) => c.kind === "alerts")}
          owner={owner}
          tested={tested}
          updated={updated}
          deliveries={deliveries}
        />
        {owner && <Choices kind="alerts" slug={slug} adding={adding} />}
        {adding && PROVIDERS[adding].kind === "alerts" && owner && (
          <AddForm
            provider={adding}
            slug={slug}
            repos={repoNames}
            error={actionData && "provider" in actionData ? error : null}
          />
        )}
      </Section>
      )}

      {/* Trackers ------------------------------------------------------------ */}
      {kind === "tracker" && (
      <Section kind="tracker">
        <Connections
          list={connections.filter((c) => c.kind === "tracker")}
          owner={owner}
          tested={tested}
          updated={updated}
          deliveries={deliveries}
        />
        {owner && <Choices kind="tracker" slug={slug} adding={adding} />}
        {adding && PROVIDERS[adding].kind === "tracker" && owner && (
          <AddForm
            provider={adding}
            slug={slug}
            repos={repoNames}
            error={actionData && "provider" in actionData ? error : null}
          />
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
  deliveries: Record<string, Delivery[]>;
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
  deliveries: Delivery[];
}) {
  const { config } = connection;
  const facts = [
    PROVIDERS[connection.provider].label,
    config.repo && `issues in ${config.repo}`,
    config.assign && "agents start at once",
    config.organization,
    host(config.site),
    host(config.baseUrl),
    config.model && `default ${config.model}`,
    connection.models.length > 0 && `${connection.models.length} models`,
    config.keys?.length ? config.keys.join(", ") : null,
    connection.secretHint && `key ${connection.secretHint}`,
  ].filter(Boolean);
  const gateway = connection.kind === "models" ? gatewayPatterns(connection.provider, config) : null;
  const waitingForSecret = connection.provider === "sentry" && !deliveries.length && !connection.lastUsedAt;
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
      {tested?.id === connection.id && (
        <p className={`mt-3 text-sm ${tested.ok ? "text-success" : "text-danger"}`}>{tested.message}</p>
      )}
      {connection.lastError && (
        <p className="mt-3 flex items-start gap-2 text-xs text-warn">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {connection.lastError}
        </p>
      )}
      {gateway && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="text-faint">AI Gateway</span>
          {gateway.length === 0 ? (
            <span>no models</span>
          ) : (
            gateway.map((pattern) => (
              <code key={pattern} className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[0.75rem] text-fg">
                {pattern}
              </code>
            ))
          )}
        </div>
      )}
      {owner && gateway && (
        <details className="group mt-3" open={updated || undefined}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted hover:text-fg">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" />
            Change its AI Gateway models or key
          </summary>
          <Form method="post" className="mt-3 max-w-2xl space-y-3">
            <input type="hidden" name="intent" value="gateway" />
            <input type="hidden" name="id" value={connection.id} />
            <GatewayModelsField provider={connection.provider} value={gateway} />
            <Field label="Replace the key" hint="Write-only: g1t never shows it again. Leave it empty to keep the key you have.">
              <Input name="secret" type="password" placeholder={connection.secretHint ? `Now ${connection.secretHint}` : "Paste a key"} autoComplete="new-password" className="max-w-sm" />
            </Field>
            <div className="flex items-center gap-3">
              <SubmitButton variant="outline" match={{ intent: "gateway", id: connection.id }} pending="Saving…">
                Save
              </SubmitButton>
              {updated && <span className="text-sm text-success">Saved.</span>}
            </div>
          </Form>
        </details>
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
                      : "bg-success"
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

/** What a provider is for, in a line. */
function blurb(provider: Provider): string {
  return PROVIDER_BLURB[provider] ?? MODEL_CATALOG[provider]?.blurb ?? "";
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

function AssignField() {
  return (
    <CheckboxOption
      name="assign"
      label={<span className="font-medium">Assign each new issue to g1t</span>}
      description={
        <span className="text-muted">
          It opens a pull request, gets reviewed, and lands through your merge rules, before anyone has to look.
          Agents run only where g1t is enabled.
        </span>
      }
    />
  );
}

function AddForm({
  provider,
  slug,
  repos,
  error,
}: {
  provider: Provider;
  slug: string;
  repos: string[];
  error: string | null;
}) {
  const fields: Partial<Record<Provider, ReactNode>> = {
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
    <Card asChild className="mt-4 scroll-mt-20 p-5">
      <section id="add">
        <div className="flex items-center gap-3">
          <ProviderMark provider={provider} />
          <div className="grow">
            <h3 className="font-medium">
              Connect {provider.endsWith("_endpoint") ? `an ${PROVIDERS[provider].label}` : PROVIDERS[provider].label}
            </h3>
            <p className="text-xs text-muted">{blurb(provider)}</p>
          </div>
          <Link
            to={`/${slug}/-/integrations/${integrationsSection(PROVIDERS[provider].kind)}`}
            className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg"
            aria-label="Close"
          >
            <X size={16} />
          </Link>
        </div>
        <Form method="post" className="mt-5 grid max-w-xl gap-4">
          <input type="hidden" name="provider" value={provider} />
          {fields[provider] ?? <ModelProviderFields provider={provider} />}
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
          {connection.lastError
            ? `It was saved, but the check failed: ${connection.lastError}`
            : connection.models.length > 0
              ? `It offers ${connection.models.length} models. Choose which work goes to it under “Which model does which work”.`
              : "Choose which work goes to it under “Which model does which work”."}
        </p>
      )}
    </div>
  );
}
