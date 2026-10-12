/**
 * One plugin's page, read from its source as Claude Code would read it: its
 * README, what it brings g1t's agents (skills, each given to agents from
 * here once installed; subagents, each hireable as a starting point;
 * remote MCP servers, connectors once installed) and what only Claude Code
 * on a runner uses; and for owners Install, Update, the switch, and
 * Uninstall. Members ask with Request.
 */
import { ArrowLeft, ArrowUpCircle, Bot, ExternalLink, Plus, Power, Trash2, UserPlus } from "lucide-react";
import { Link, data, useFetcher } from "react-router";

import type { PluginDetail, SkillLibrary, WorkspaceConnector } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/plugin";
import { useCustomize } from "./layout";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, Confirm } from "../../../components/agents/dialogs";
import { skillsPath } from "../../../components/agents/skills";
import { AvailabilityBadge, AvailableTo, Chips, ListingMark, NoAnswer, RequestButton, SectionHead, StateBadge } from "../../../components/customize";
import { Markdown } from "../../../components/markdown";
import { ButtonLink, SubmitButton, TimeAgo } from "../../../components/ui";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { type Reach, type ReachOption, type ReachTargets, claudeCodeOnly, connectorPagePath, fetchWords, pluginListingRef, requestedBy, splitTarget } from "../../../lib/customize";
import { addConnectorThen } from "../../../lib/customize.server";
import { page } from "../../../lib/meta";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  const listing = args.loaderData?.detail?.listing;
  return page(args, { title: `${listing?.display_name ?? listing?.name ?? "Plugin"} · Customize · ${params.owner} · g1t` });
}

type Loaded = { detail: PluginDetail | null; library: SkillLibrary | null; connectors: WorkspaceConnector[] };

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<Loaded> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const [found, library, connectors] = await Promise.all([
    workspaceAgents.plugin(slug, viewer, params.ref).catch(() => null),
    readOrNull(skillLibrary.library(slug, viewer)),
    readOrNull(workspaceAgents.connectors(slug, viewer)),
  ]);
  if (found && !found.ok) throw data(null, { status: found.error.code === "not_found" ? 404 : 502 });
  return { detail: found?.value ?? null, library, connectors: connectors ?? [] };
}

/** Install, update, switch or uninstall the plugin; connect one of its servers; give one of its skills to agents. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<Response | ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const ref = params.ref;
  switch (intent) {
    case "install":
      return answer(intent, workspaceAgents.installPlugin(slug, viewer, ref));
    case "update":
      return answer(intent, workspaceAgents.updatePlugin(slug, viewer, ref));
    case "switch":
      return answer(intent, workspaceAgents.setPluginEnabled(slug, viewer, ref, form.get("enabled") === "on"));
    case "uninstall":
      return answer(intent, workspaceAgents.uninstallPlugin(slug, viewer, ref));
    case "connect":
      return addConnectorThen(slug, viewer, { from: { kind: "plugin", ref, server: String(form.get("server") ?? "") }, auth: form.get("auth") === "header" ? "header" : form.get("auth") === "none" ? "none" : "oauth", header: null });
    case "attach": {
      const { scope, target } = splitTarget(String(form.get("where") ?? ""));
      return answer(intent, skillLibrary.attachSkill(slug, viewer, String(form.get("name") ?? ""), scope, target));
    }
    case "detach":
      return answer(intent, skillLibrary.detachSkill(slug, viewer, String(form.get("name") ?? ""), String(form.get("attachment") ?? "")));
    default:
      return { ok: false, intent, error: "Unknown request." };
  }
}

export default function PluginPage({ loaderData, params }: Route.ComponentProps) {
  const { slug, owner, username, requests } = useCustomize();
  const { detail, library, connectors } = loaderData;
  const back = (
    <Link to={`${customizePath("plugins", slug)}?view=discover`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Plugins
    </Link>
  );
  if (!detail) {
    return (
      <div className="space-y-6">
        {back}
        <NoAnswer what={params.ref} />
      </div>
    );
  }
  const { listing, install } = detail;
  const components = install?.components ?? detail.components;
  const name = listing.display_name ?? listing.name;
  const enabled = install?.enabled ?? false;
  const targets: ReachTargets | null = library && (library.can_manage || library.teams.length > 0) ? { can_manage: library.can_manage, teams: library.teams, agents: library.agents } : null;
  const runner = components ? claudeCodeOnly(components) : [];
  const problems = [...detail.problems, ...(install?.problems ?? [])];
  return (
    <div className="space-y-8">
      {back}
      <header className="flex flex-wrap items-start gap-4">
        <ListingMark id={listing.ref} name={name} size={56} />
        <div className="min-w-0 grow basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{name}</h2>
            <AvailabilityBadge availability={listing.availability} />
            {install?.update && <Badge tone="warn">Update available{install.update.version ? `: ${install.update.version}` : ""}</Badge>}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            {listing.author && <span>by {listing.author}</span>}
            {listing.author && (
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
            )}
            <Link to={`${customizePath("plugins", slug)}?view=discover&marketplace=${encodeURIComponent(listing.marketplace)}`} className="hover:text-fg hover:underline">
              {listing.marketplace}
            </Link>
            {listing.version && (
              <>
                <span aria-hidden="true" className="text-faint">
                  ·
                </span>
                <span>v{listing.version}</span>
              </>
            )}
            {listing.category && (
              <>
                <span aria-hidden="true" className="text-faint">
                  ·
                </span>
                <span>{listing.category}</span>
              </>
            )}
          </p>
          <p className="mt-2 max-w-3xl text-sm text-fg-soft">{listing.description}</p>
        </div>
        <Actions detail={detail} slug={slug} owner={owner} requested={requestedBy(requests?.requests ?? [], pluginListingRef(listing), username)} />
      </header>
      {install && !enabled && (
        <Alert tone="warn" asChild>
          <p>Switched off: its skills, agents and connectors are kept but reach no agent until an owner switches it on.</p>
        </Alert>
      )}
      {problems.length > 0 && (
        <Alert tone="warn" asChild>
          <div>
            <p className="font-medium">What couldn&apos;t be read</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        </Alert>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-8">
          {components && (
            <section aria-labelledby="components" className="space-y-6">
              <SectionHead id="components" title="What it brings">
                Skills, agents and connectors reach g1t&apos;s agents once it is installed; the rest reaches Claude Code when it runs on a g1t runner.
              </SectionHead>
              <Group title="Skills" count={components.skills.length + components.commands.length} empty="None.">
                {[...components.skills, ...components.commands.map((command) => ({ name: command.name, description: "A command: the older one-file form of a skill.", path: command.path }))].map((skill) => {
                  const added = library?.skills.find((s) => s.plugin === listing.ref && s.name.toLowerCase() === skill.name.toLowerCase()) ?? null;
                  return (
                    <li key={skill.path} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                      <div className="min-w-0 grow">
                        {added ? (
                          <Link to={skillsPath(slug, added.qualified_name)} className="font-mono text-sm font-medium hover:underline">
                            {added.qualified_name}
                          </Link>
                        ) : (
                          <span className="font-mono text-sm font-medium">
                            {listing.name}:{skill.name}
                          </span>
                        )}
                        {skill.description && <p className="mt-0.5 text-sm text-muted">{skill.description}</p>}
                      </div>
                      {added && <SkillReach skill={added} targets={targets} />}
                    </li>
                  );
                })}
              </Group>
              <Group title="Agents" count={components.agents.length} empty="None.">
                {components.agents.map((agent) => {
                  const file = detail.agents.find((a) => a.name === agent.name);
                  return (
                    <li key={agent.path} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                      <Bot size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden />
                      <div className="min-w-0 grow">
                        <p className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-medium">{agent.name}</span>
                          {file?.model && <Badge>{file.model}</Badge>}
                        </p>
                        {(agent.description || file?.description) && <p className="mt-0.5 text-sm text-muted">{agent.description ?? file?.description}</p>}
                      </div>
                      {install && enabled && owner ? (
                        <ButtonLink to={`/${slug}/-/agents/new?plugin=${encodeURIComponent(listing.ref)}&agent=${encodeURIComponent(agent.name)}`} variant="outline" size="xs">
                          <UserPlus size={12} />
                          Hire
                        </ButtonLink>
                      ) : (
                        <span className="text-xs text-faint">{install ? (enabled ? "Owners hire agents" : "Switched off") : "Hire it once installed"}</span>
                      )}
                    </li>
                  );
                })}
              </Group>
              <Group title="Connectors" count={components.mcp_servers.length} empty="None.">
                {components.mcp_servers.map((server) => {
                  const connector = connectors.find((c) => c.from.kind === "plugin" && c.from.ref === listing.ref && c.from.server === server.name) ?? null;
                  return (
                    <li key={server.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="min-w-0 grow">
                        <p className="flex flex-wrap items-center gap-2">
                          {connector ? (
                            <Link to={connectorPagePath(slug, connector.id)} className="font-mono text-sm font-medium hover:underline">
                              {server.name}
                            </Link>
                          ) : (
                            <span className="font-mono text-sm font-medium">{server.name}</span>
                          )}
                          {!server.remote ? <Badge>Claude Code only</Badge> : connector ? <StateBadge state={connector.state} problem={connector.problem} /> : null}
                          {connector && install && !enabled && <span className="text-xs text-faint">Stopped while the plugin is off</span>}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted">{server.url ?? `${server.type} server, run on the machine Claude Code runs on`}</p>
                      </div>
                      {server.remote && install && !connector && owner && <ConnectServer server={server.name} />}
                    </li>
                  );
                })}
              </Group>
              {runner.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold">Claude Code only</h3>
                  <p className="mt-0.5 mb-2 text-sm text-muted">Read by Claude Code on a g1t runner, with the plugin fetched at its pinned commit; g1t&apos;s own agents don&apos;t use these.</p>
                  <Chips items={runner} />
                </div>
              )}
            </section>
          )}
          <section aria-labelledby="readme">
            <SectionHead id="readme" title="README" />
            {detail.readme ? (
              <Card className="p-5 sm:p-6">
                <Markdown source={detail.readme} />
              </Card>
            ) : (
              <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
                <p>{components ? "It has no README." : "Its files couldn't be read, so there is nothing more to show than its listing."}</p>
              </Card>
            )}
          </section>
        </div>

        <aside className="text-sm">
          <Card asChild className="space-y-3 p-4">
            <dl>
              <div>
                <dt className="text-xs text-faint">Source</dt>
                <dd className="mt-0.5 break-words">{fetchWords(install?.fetch ?? listing.fetch)}</dd>
              </div>
              {(install?.sha ?? detail.manifest?.version) && (
                <div>
                  <dt className="text-xs text-faint">{install ? "Installed at" : "Version"}</dt>
                  <dd className="mt-0.5 font-mono text-xs">{install ? install.sha?.slice(0, 7) : detail.manifest?.version}</dd>
                </div>
              )}
              {install && (
                <div>
                  <dt className="text-xs text-faint">Installed</dt>
                  <dd className="mt-0.5">
                    By @{install.installed_by} · <TimeAgo at={install.installed_at} />
                  </dd>
                </div>
              )}
              {detail.manifest?.license && (
                <div>
                  <dt className="text-xs text-faint">License</dt>
                  <dd className="mt-0.5">{detail.manifest.license}</dd>
                </div>
              )}
              {(listing.homepage ?? detail.manifest?.repository) && (
                <div>
                  <dt className="text-xs text-faint">More</dt>
                  <dd className="mt-0.5">
                    <a href={listing.homepage ?? detail.manifest!.repository!} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                      <span className="truncate">{listing.homepage ?? detail.manifest!.repository}</span>
                      <ExternalLink size={11} className="shrink-0" aria-hidden />
                    </a>
                  </dd>
                </div>
              )}
              {listing.tags.length > 0 && (
                <div>
                  <dt className="text-xs text-faint">Tags</dt>
                  <dd className="mt-1">
                    <Chips items={listing.tags} />
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** A list of what a plugin brings, under its heading, or a word when there is nothing. */
function Group({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
        {title}
        <span className="text-xs font-normal text-faint tabular-nums">{count}</span>
      </h3>
      {count === 0 ? (
        <Card asChild tone="plain" className="border-dashed px-4 py-3 text-sm text-muted">
          <p>{empty}</p>
        </Card>
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>{children}</ul>
        </Card>
      )}
    </div>
  );
}

/** Which agents one of the plugin's skills reaches, with the control that changes it. */
function SkillReach({ skill, targets }: { skill: SkillLibrary["skills"][number]; targets: ReachTargets | null }) {
  const fetcher = useFetcher<ActionResult>({ key: `plugin-skill-${skill.id}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const reach: Reach[] = skill.attachments.map((a) => ({ id: a.id, scope: a.scope, target: a.target, label: a.label }));
  const change = (option: ReachOption, checked: boolean) => {
    if (checked) fetcher.submit({ intent: "attach", name: skill.qualified_name, where: option.value }, { method: "post" });
    else if (option.reach) fetcher.submit({ intent: "detach", name: skill.qualified_name, attachment: option.reach.id }, { method: "post" });
  };
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <AvailableTo reach={reach} targets={targets} busy={fetcher.state !== "idle"} onChange={change} />
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Connect one of the plugin's remote servers that has no connector yet. */
function ConnectServer({ server }: { server: string }) {
  const fetcher = useFetcher<ActionResult>({ key: `plugin-connect-${server}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <fetcher.Form method="post" className="flex flex-col items-end gap-1">
      <input type="hidden" name="intent" value="connect" />
      <input type="hidden" name="server" value={server} />
      <SubmitButton variant="outline" size="xs" fetcher={fetcher} match={{ intent: "connect", server }} pending="Connecting…">
        <Plus size={12} />
        Connect
      </SubmitButton>
      {error && <p className="text-xs text-danger">{error}</p>}
    </fetcher.Form>
  );
}

/** What the viewer can do with the plugin: owners install, update, switch and uninstall; members ask. */
function Actions({ detail, slug, owner, requested }: { detail: PluginDetail; slug: string; owner: boolean; requested: boolean }) {
  const { listing, install } = detail;
  const fetcher = useFetcher<ActionResult>({ key: `plugin-${listing.ref}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const name = listing.display_name ?? listing.name;
  if (listing.availability.kind === "soon" || listing.availability.kind === "unavailable") return null;
  if (!owner) {
    return install ? null : <RequestButton slug={slug} listing={pluginListingRef(listing)} name={name} requested={requested} />;
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {!install ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="install" />
            <SubmitButton variant="accent" fetcher={fetcher} match={{ intent: "install" }} pending="Installing…">
              <Plus size={14} />
              Install
            </SubmitButton>
          </fetcher.Form>
        ) : (
          <>
            {install.update && (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="update" />
                <SubmitButton variant="accent" size="sm" fetcher={fetcher} match={{ intent: "update" }} pending="Updating…">
                  <ArrowUpCircle size={14} />
                  Update{install.update.version ? ` to ${install.update.version}` : ""}
                </SubmitButton>
              </fetcher.Form>
            )}
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="switch" />
              <input type="hidden" name="enabled" value={install.enabled ? "off" : "on"} />
              <SubmitButton variant="outline" size="sm" fetcher={fetcher} match={{ intent: "switch" }} pending="Saving…">
                <Power size={14} />
                {install.enabled ? "Switch off" : "Switch on"}
              </SubmitButton>
            </fetcher.Form>
            <Confirm
              title={`Uninstall ${name}?`}
              confirm="Uninstall"
              fields={{ intent: "uninstall" }}
              fetcherKey={`uninstall-${listing.ref}`}
              trigger={
                <Button type="button" variant="outline" size="sm" className="hover:border-danger/50 hover:text-danger">
                  <Trash2 size={14} />
                  Uninstall
                </Button>
              }
            >
              Its skills leave the library, its agents leave Templates and its connectors are removed, at once. Agents hired from it stay as they are.
            </Confirm>
          </>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
