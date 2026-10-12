/**
 * Customize → Connectors (docs.g1t.sh/guides/customize/, "Connectors").
 * Yours: the MCP servers the workspace connected, each with how it is
 * doing, its tools, which agents it reaches and what an owner does with
 * it; then g1t's own integrations the workspace has connected (GitHub,
 * trackers, alerts, model providers), looked after on their settings
 * pages. Discover: the directory, remote MCP servers first, each connected
 * in a step; g1t's integrations with where each is set up; what each
 * person connects for themselves; and what is coming.
 */
import { ArrowRight, ExternalLink, Plus } from "lucide-react";
import { Link, data, useFetcher, useSearchParams } from "react-router";

import type { SkillLibrary, WorkspaceConnector } from "@g1t/contracts";
import { type ConnectorView, connectorPath, connectorsFor } from "@g1t/contracts/connectors";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/connectors";
import { useCustomize } from "./layout";
import { agentsAction, readOrNull } from "../../../components/agents/actions.server";
import type { ActionResult } from "../../../components/agents/dialogs";
import { ConnectorMark } from "../../../components/connectors";
import { Caveat, Chips, FeaturedBanner, ListingCard, ListingGrid, NoAnswer, RequestButton, SectionHead, StateBadge, Waiting } from "../../../components/customize";
import { ConnectorMenu, ConnectorReach, SetKeyDialog, WorkspaceConnectorMark } from "../../../components/customize-connector";
import { ButtonLink, EmptyState, SubmitButton } from "../../../components/ui";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { workspaceConnections } from "../../../lib/connected.server";
import { type ConnectedState, categoryTitle } from "../../../lib/connectors";
import { type IntegrationEntry, type McpDirectoryEntry, type ReachTargets, connectorListingRef, connectorNewPath, connectorPagePath, connectorsDirectory, flashOf, fromWords, matches, personalDirectory, readQuery, readView, requestedBy, waitingFor, withParams } from "../../../lib/customize";
import { addConnectorThen, connectorAction } from "../../../lib/customize.server";
import { page } from "../../../lib/meta";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export { shouldRevalidate } from "../../../lib/customize.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Connectors · Customize · ${params.owner} · g1t` });
}

type Loaded = {
  connectors: WorkspaceConnector[] | null;
  connected: Record<string, ConnectedState>;
  unavailable: Record<string, string>;
  /** Who an owner may give connectors to; null for anyone else. */
  targets: ReachTargets | null;
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<Loaded> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const [connectors, connections, library] = await Promise.all([
    readOrNull(workspaceAgents.connectors(slug, viewer)),
    workspaceConnections(slug, viewer),
    role === "owner" ? readOrNull(skillLibrary.library(slug, viewer)) : Promise.resolve(null as SkillLibrary | null),
  ]);
  return { connectors, ...connections, targets: library ? { can_manage: true, teams: library.teams, agents: library.agents } : null };
}

/** Connect a directory entry, or anything a connector's menu does (lib/customize.server.ts). */
export async function action({ params, context, request }: Route.ActionArgs): Promise<Response | ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  if (intent === "connect") {
    const id = String(form.get("directory") ?? "");
    const view = connectorsFor("workspace").find((v) => v.id === id);
    if (!view?.mcp) return { ok: false, intent, error: "There is no such connector in the directory." };
    const header = view.mcp.auth === "header" ? { name: String(form.get("header_name") ?? "").trim() || view.mcp.header || "Authorization", value: String(form.get("value") ?? "") } : null;
    return addConnectorThen(slug, viewer, { from: { kind: "directory", id }, auth: view.mcp.auth, header });
  }
  return (await connectorAction(intent, form, slug, viewer, null)) ?? { ok: false, intent, error: "Unknown request." };
}

export default function CustomizeConnectors({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const flash = flashOf(params);
  // An old integration's address lands here with `?directory=`: that is Discover.
  const discover = readView(params) === "discover" || params.has("directory");
  return (
    <div className="space-y-8">
      {flash && (
        <Alert tone={flash.tone} asChild>
          <p role="alert">{flash.text}</p>
        </Alert>
      )}
      {discover ? <Discover data={loaderData} /> : <Yours data={loaderData} />}
    </div>
  );
}

// ── Yours ────────────────────────────────────────────────────────────────

function Yours({ data: loaded }: { data: Loaded }) {
  const { slug, owner } = useCustomize();
  const [params] = useSearchParams();
  const query = readQuery(params);
  const views = connectorsFor("workspace");
  const connectors = (loaded.connectors ?? []).filter((connector) => matches([connector.title, connector.name, connector.url, connector.about, ...connector.tools.map((tool) => tool.name)], query));
  const builtIn = views.filter((view) => loaded.connected[view.id] && matches([view.name, view.description, categoryTitle(view.category)], query));
  return (
    <>
      <section aria-labelledby="connectors">
        <SectionHead
          id="connectors"
          title="Connectors"
          aside={
            owner ? (
              <ButtonLink to={connectorNewPath(slug)} variant="outline" size="xs">
                <Plus size={12} />
                Add by address
              </ButtonLink>
            ) : loaded.connectors ? (
              `${connectors.length}`
            ) : undefined
          }
        >
          MCP servers the workspace connected once and gives to agents: every agent, a team&apos;s, or one. Each tool a server lists becomes an ability of the agents that have it, with a level like any other.
        </SectionHead>
        {!loaded.connectors ? (
          <NoAnswer what="Connectors" />
        ) : connectors.length === 0 ? (
          <EmptyState title={query ? "No connector matches" : "No connectors yet"}>
            {query ? (
              "Try another word, or look in Discover."
            ) : (
              <>
                Connect one from{" "}
                <Link to={withParams(customizePath("connectors", slug), params, { view: "discover" })} className="text-accent hover:underline">
                  Discover
                </Link>
                {owner ? ", add one by address, or install a plugin that brings one." : ", or ask an owner for one."}
              </>
            )}
          </EmptyState>
        ) : (
          <ListingGrid>
            {connectors.map((connector) => (
              <ConnectorCard key={connector.id} connector={connector} slug={slug} owner={owner} targets={loaded.targets} />
            ))}
          </ListingGrid>
        )}
      </section>

      {builtIn.length > 0 && (
        <section aria-labelledby="built-in">
          <SectionHead id="built-in" title="Connected integrations" aside={<Link to={`/${slug}/-/integrations`} className="hover:text-fg">Integrations settings</Link>}>
            g1t&apos;s own, connected for the whole workspace and looked after on their settings pages. Agents get their actions as abilities on their Abilities tab.
          </SectionHead>
          <ListingGrid>
            {builtIn.map((view) => (
              <IntegrationCard key={view.id} entry={{ view, state: loaded.connected[view.id]!, why: null, href: loaded.connected[view.id]!.manage ?? (view.href ? connectorPath(view.href, slug) : null) }} slug={slug} owner={owner} requested={false} waiting={0} />
            ))}
          </ListingGrid>
        </section>
      )}
    </>
  );
}

/** A workspace connector: how it is doing, what it offers, which agents have it, and what an owner does with it. */
function ConnectorCard({ connector, slug, owner, targets }: { connector: WorkspaceConnector; slug: string; owner: boolean; targets: ReachTargets | null }) {
  const caveat = connector.from.kind === "directory" ? (connectorsFor("workspace").find((view) => view.id === (connector.from as { id: string }).id)?.mcp?.caveat ?? null) : null;
  return (
    <ListingCard
      mark={<WorkspaceConnectorMark connector={connector} />}
      title={connector.title}
      to={connectorPagePath(slug, connector.id)}
      description={connector.about ?? connector.url}
      badge={
        <>
          <StateBadge state={connector.state} problem={connector.problem} />
          {owner && <ConnectorMenu connector={connector} caveat={caveat} />}
        </>
      }
      meta={`${connector.tools.length} ${connector.tools.length === 1 ? "tool" : "tools"} · ${fromWords(connector.from)}`}
      action={
        connector.state === "needs_key" && owner ? (
          <SetKeyDialog
            connector={connector}
            caveat={caveat}
            trigger={
              <Button type="button" size="xs" variant="accent">
                Set the key
              </Button>
            }
          />
        ) : connector.state === "needs_sign_in" && owner ? (
          <SignInButton connector={connector} />
        ) : null
      }
    >
      <ConnectorReach connector={connector} targets={targets} />
    </ListingCard>
  );
}

/** Signing a connector in: the browser leaves for the server's own page. */
function SignInButton({ connector }: { connector: Pick<WorkspaceConnector, "id"> }) {
  const fetcher = useFetcher<ActionResult>({ key: `connector-sign-in-${connector.id}` });
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="sign_in" />
      <input type="hidden" name="connector" value={connector.id} />
      <SubmitButton size="xs" variant="accent" fetcher={fetcher} match={{ intent: "sign_in", connector: connector.id }} pending="Going to sign in…">
        Sign in
      </SubmitButton>
    </fetcher.Form>
  );
}

// ── Discover ─────────────────────────────────────────────────────────────

function Discover({ data: loaded }: { data: Loaded }) {
  const { slug, owner, username, requests } = useCustomize();
  const [params] = useSearchParams();
  const query = readQuery(params);
  const chosen = params.get("directory");
  const directory = connectorsDirectory(connectorsFor("workspace"), loaded.connectors ?? [], loaded.connected, loaded.unavailable, slug, query);
  const personal = personalDirectory(connectorsFor("personal"), query);
  const asked = requests?.requests ?? [];
  const empty = directory.mcp.length + directory.integrations.length + directory.soon.length + personal.length === 0;
  return (
    <>
      <FeaturedBanner
        title="Connect what your team already uses"
        action={
          owner ? (
            <ButtonLink to={connectorNewPath(slug)} variant="outline" size="sm">
              <Plus size={14} />
              Add by address
            </ButtonLink>
          ) : undefined
        }
      >
        Remote MCP servers the workspace connects once, signing in with the browser or a key, then gives to agents. Any server with an HTTPS address works; these are the ones g1t knows.
      </FeaturedBanner>
      {empty && <EmptyState title="Nothing matches">Try another word. An owner can add any MCP server by its address.</EmptyState>}
      {directory.mcp.length > 0 && (
        <section aria-labelledby="mcp">
          <SectionHead id="mcp" title="MCP servers" aside={`${directory.mcp.length}`}>
            Connected from here, in a step. Their tools reach the agents you choose.
          </SectionHead>
          <ListingGrid>
            {directory.mcp.map((entry) => (
              <McpCard key={entry.view.id} entry={entry} slug={slug} owner={owner} highlighted={entry.view.id === chosen} requested={requestedBy(asked, connectorListingRef(entry.view.id), username)} waiting={owner ? waitingFor(asked, connectorListingRef(entry.view.id)) : 0} />
            ))}
          </ListingGrid>
        </section>
      )}
      {directory.integrations.length > 0 && (
        <section aria-labelledby="integrations">
          <SectionHead id="integrations" title="g1t's integrations" aside={`${directory.integrations.length}`}>
            Built into g1t and set up on their own pages: import and mirror code, read trackers and alerts, run models on your own account.
          </SectionHead>
          <ListingGrid>
            {directory.integrations.map((entry) => (
              <IntegrationCard key={entry.view.id} entry={entry} slug={slug} owner={owner} highlighted={entry.view.id === chosen} requested={requestedBy(asked, `integration:${entry.view.id}`, username)} waiting={owner ? waitingFor(asked, `integration:${entry.view.id}`) : 0} />
            ))}
          </ListingGrid>
        </section>
      )}
      {personal.length > 0 && (
        <section aria-labelledby="personal">
          <SectionHead id="personal" title="Connected by each person" aside={`${personal.length}`}>
            Each person connects these for themselves, under their own settings, and agents use them only when that person asks.
          </SectionHead>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {personal.map((view) => (
              <PersonalRow key={view.id} view={view} slug={slug} />
            ))}
          </ul>
        </section>
      )}
      {directory.soon.length > 0 && (
        <section aria-labelledby="soon">
          <SectionHead id="soon" title="Soon" aside={`${directory.soon.length}`}>
            Planned, not built. Nobody can connect these yet.
          </SectionHead>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {directory.soon.map((view) => (
              <SoonRow key={view.id} view={view} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** A remote MCP server from the directory: connected (its page), or Connect, or Request. */
function McpCard({ entry, slug, owner, highlighted, requested, waiting }: { entry: McpDirectoryEntry; slug: string; owner: boolean; highlighted: boolean; requested: boolean; waiting: number }) {
  const { view, connector } = entry;
  const fetcher = useFetcher<ActionResult>({ key: `connect-${view.id}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const mcp = view.mcp!;
  const action = connector ? (
    <ButtonLink to={connectorPagePath(slug, connector.id)} variant="outline" size="xs">
      Open
      <ArrowRight size={12} />
    </ButtonLink>
  ) : !owner ? (
    <RequestButton slug={slug} listing={connectorListingRef(view.id)} name={view.name} requested={requested} size="xs" />
  ) : mcp.auth === "header" ? (
    <SetKeyDialog
      connector={{ id: `directory-${view.id}`, title: view.name, header_name: mcp.header ?? null }}
      caveat={mcp.caveat}
      trigger={
        <Button type="button" size="xs">
          <Plus size={13} />
          Connect
        </Button>
      }
      connect={view.id}
    />
  ) : (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="connect" />
      <input type="hidden" name="directory" value={view.id} />
      <SubmitButton size="xs" fetcher={fetcher} match={{ intent: "connect", directory: view.id }} pending={mcp.auth === "oauth" ? "Going to sign in…" : "Connecting…"}>
        <Plus size={13} />
        Connect
      </SubmitButton>
    </fetcher.Form>
  );
  return (
    <div className={highlighted ? "rounded-xl ring-2 ring-accent/60" : undefined}>
      <ListingCard
        mark={<ConnectorMark view={view} />}
        title={view.name}
        to={connector ? connectorPagePath(slug, connector.id) : undefined}
        description={view.description}
        badge={
          <>
            <Caveat text={mcp.caveat} />
            {connector ? <StateBadge state={connector.state} problem={connector.problem} /> : <Badge>{mcp.auth === "oauth" ? "Signs in" : mcp.auth === "header" ? "Needs a key" : "Open"}</Badge>}
          </>
        }
        meta={
          <>
            {categoryTitle(view.category)}
            {waiting > 0 && (
              <>
                {" · "}
                <Waiting slug={slug} count={waiting} />
              </>
            )}
          </>
        }
        action={action}
      >
        <Chips items={view.capabilities} label="What it does" />
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </ListingCard>
    </div>
  );
}

/** One of g1t's integrations: connected (Manage), connectable (Connect, on its setup page), not available here (why), or asked for. */
function IntegrationCard({ entry, slug, owner, highlighted = false, requested, waiting }: { entry: IntegrationEntry; slug: string; owner: boolean; highlighted?: boolean; requested: boolean; waiting: number }) {
  const { view, state, why, href } = entry;
  const action = state ? (
    href ? (
      <ButtonLink to={href} variant="outline" size="xs">
        Manage
        <ArrowRight size={12} />
      </ButtonLink>
    ) : null
  ) : why ? null : owner ? (
    href ? (
      <ButtonLink to={href} size="xs">
        <Plus size={13} />
        Connect
      </ButtonLink>
    ) : null
  ) : (
    <RequestButton slug={slug} listing={`integration:${view.id}`} name={view.name} requested={requested} size="xs" />
  );
  return (
    <div className={highlighted ? "rounded-xl ring-2 ring-accent/60" : undefined}>
      <ListingCard
        mark={<ConnectorMark view={view} />}
        title={view.name}
        to={state && href ? href : undefined}
        description={view.description}
        muted={!!why}
        badge={
          state ? (
            state.problem ? (
              <Hint label={state.problem}>
                <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                  <Badge tone="warn">Needs attention</Badge>
                </span>
              </Hint>
            ) : (
              <Badge tone="success">Connected</Badge>
            )
          ) : why ? (
            <Hint label={why}>
              <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Badge>Not available here</Badge>
              </span>
            </Hint>
          ) : null
        }
        meta={
          <>
            {state?.detail ?? categoryTitle(view.category)}
            {waiting > 0 && (
              <>
                {" · "}
                <Waiting slug={slug} count={waiting} />
              </>
            )}
          </>
        }
        action={action}
      >
        <Chips items={view.capabilities} muted={!!why} label="What it does" />
      </ListingCard>
    </div>
  );
}

/** What each person connects for themselves: a row leading to their own settings. */
function PersonalRow({ view, slug }: { view: ConnectorView; slug: string }) {
  return (
    <Card asChild className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:border-line-strong">
      <li>
        <ConnectorMark view={view} size={28} />
        <span className="min-w-0 grow">
          <span className="block truncate text-sm">{view.name}</span>
          <span className="block truncate text-xs text-muted">{view.description}</span>
        </span>
        <ButtonLink to={connectorPath(view.href!, slug)} variant="ghost" size="xs" className="shrink-0">
          Connect yours
          <ExternalLink size={12} />
        </ButtonLink>
      </li>
    </Card>
  );
}

/** A planned connector: muted and dashed, with nothing to press. */
function SoonRow({ view }: { view: ConnectorView }) {
  return (
    <Card asChild tone="plain" className="flex items-center gap-3 border-dashed px-3 py-2.5">
      <li>
        <span className="shrink-0 opacity-60 grayscale">
          <ConnectorMark view={view} size={28} />
        </span>
        <span className="min-w-0 grow">
          <span className="block truncate text-sm text-fg-soft">{view.name}</span>
          <span className="block truncate text-xs text-faint">{view.description}</span>
        </span>
        <Badge className="shrink-0">Soon</Badge>
      </li>
    </Card>
  );
}
