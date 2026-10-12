/**
 * One connector's page: what it is and where it came from, how it is
 * doing, who signed it in and when, the tools it lists (each a read or a
 * write), which agents it reaches with the control that changes that, and
 * what an owner does with it.
 */
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Link, data, useSearchParams } from "react-router";

import type { SkillLibrary, WorkspaceConnector } from "@g1t/contracts";
import { connectorById } from "@g1t/contracts/connectors";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/connector";
import { useCustomize } from "./layout";
import { agentsAction, readOrNull } from "../../../components/agents/actions.server";
import type { ActionResult } from "../../../components/agents/dialogs";
import { NoAnswer, SectionHead, StateBadge } from "../../../components/customize";
import { ConnectorMenu, ConnectorReach, SetKeyDialog, WorkspaceConnectorMark } from "../../../components/customize-connector";
import { TimeAgo } from "../../../components/ui";
import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { AUTH_WORDS, type ReachTargets, flashOf, fromWords, pluginPath } from "../../../lib/customize";
import { connectorAction } from "../../../lib/customize.server";
import { page } from "../../../lib/meta";
import { skillLibrary, workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${args.loaderData?.connector?.title ?? "Connector"} · Customize · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ connector: WorkspaceConnector | null; targets: ReachTargets | null }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const [found, library] = await Promise.all([
    workspaceAgents.connector(slug, viewer, params.id).catch(() => null),
    role === "owner" ? readOrNull(skillLibrary.library(slug, viewer)) : Promise.resolve(null as SkillLibrary | null),
  ]);
  if (found && !found.ok) throw data(null, { status: found.error.code === "not_found" ? 404 : 502 });
  return { connector: found?.value ?? null, targets: library ? { can_manage: true, teams: library.teams, agents: library.agents } : null };
}

export async function action({ params, context, request }: Route.ActionArgs): Promise<Response | ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  return (await connectorAction(intent, form, slug, viewer, customizePath("connectors", slug))) ?? { ok: false, intent, error: "Unknown request." };
}

export default function ConnectorPage({ loaderData }: Route.ComponentProps) {
  const { slug, owner } = useCustomize();
  const { connector, targets } = loaderData;
  const [params] = useSearchParams();
  const flash = flashOf(params);
  const back = (
    <Link to={customizePath("connectors", slug)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
      <ArrowLeft size={14} />
      Connectors
    </Link>
  );
  if (!connector) {
    return (
      <div className="space-y-6">
        {back}
        <NoAnswer what="This connector" />
      </div>
    );
  }
  const entry = connector.from.kind === "directory" ? connectorById(connector.from.id) : null;
  const caveat = entry?.mcp?.caveat ?? null;
  return (
    <div className="space-y-8">
      {back}
      {flash && (
        <Alert tone={flash.tone} asChild>
          <p role="alert">{flash.text}</p>
        </Alert>
      )}
      <header className="flex flex-wrap items-start gap-4">
        <WorkspaceConnectorMark connector={connector} size={56} />
        <div className="min-w-0 grow basis-60">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{connector.title}</h2>
            <StateBadge state={connector.state} problem={connector.problem} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted">
            <a href={connector.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-xs hover:text-fg">
              {connector.url}
              <ExternalLink size={11} aria-hidden />
            </a>
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            <span>{AUTH_WORDS[connector.auth]}</span>
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            {connector.from.kind === "plugin" ? (
              <Link to={pluginPath(slug, connector.from.ref)} className="hover:text-fg hover:underline">
                {fromWords(connector.from)}
              </Link>
            ) : (
              <span>{fromWords(connector.from)}</span>
            )}
          </p>
          {connector.about && <p className="mt-2 max-w-3xl text-sm text-fg-soft">{connector.about}</p>}
        </div>
        {owner && (
          <div className="flex shrink-0 items-center gap-2">
            {connector.state === "needs_key" && (
              <SetKeyDialog
                connector={connector}
                caveat={caveat}
                trigger={
                  <Button type="button" variant="accent" size="sm">
                    Set the key
                  </Button>
                }
              />
            )}
            <ConnectorMenu connector={connector} caveat={caveat} />
          </div>
        )}
      </header>
      {connector.problem && (
        <Alert tone="warn" asChild>
          <p>{connector.problem}</p>
        </Alert>
      )}
      {caveat && connector.state !== "connected" && (
        <Alert tone="info" asChild>
          <p>{caveat}</p>
        </Alert>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="tools" className="min-w-0">
          <SectionHead id="tools" title="Tools" aside={connector.checked_at ? <span>Listed <TimeAgo at={connector.checked_at} /></span> : undefined}>
            Each becomes an ability of the agents that have it. A tool that doesn&apos;t say it only reads counts as a write, which asks first unless an owner says otherwise.
          </SectionHead>
          {connector.tools.length === 0 ? (
            <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
              <p>{connector.state === "connected" ? "It listed no tools." : "Its tools are listed once it is connected."}</p>
            </Card>
          ) : (
            <Card asChild divided className="overflow-hidden">
              <ul>
                {connector.tools.map((tool) => (
                  <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 grow">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium">{tool.name}</span>
                        <Badge tone={tool.kind === "read" ? "neutral" : "warn"}>{tool.kind === "read" ? "Reads" : "Writes"}</Badge>
                      </p>
                      {tool.description && <p className="mt-0.5 text-sm text-muted">{tool.description}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>

        <aside className="space-y-4 text-sm">
          <Card asChild className="space-y-3 p-4">
            <section aria-labelledby="reach">
              <h3 id="reach" className="text-xs text-faint">
                Available to
              </h3>
              <ConnectorReach connector={connector} targets={targets} size="sm" />
              <p className="text-xs text-muted">Every agent, a team&apos;s agents, or one agent, the way skills are attached. Each agent&apos;s Abilities tab sets the level of every tool.</p>
            </section>
          </Card>
          <Card asChild className="space-y-3 p-4">
            <dl>
              {connector.auth === "oauth" && (
                <div>
                  <dt className="text-xs text-faint">Signed in</dt>
                  <dd className="mt-0.5">
                    {connector.signed_in_at ? (
                      <>
                        {connector.signed_in_as ? `As ${connector.signed_in_as}, ` : ""}
                        <TimeAgo at={connector.signed_in_at} />
                      </>
                    ) : (
                      "Not yet"
                    )}
                  </dd>
                </div>
              )}
              {connector.auth === "header" && (
                <div>
                  <dt className="text-xs text-faint">Key</dt>
                  <dd className="mt-0.5">{connector.state === "needs_key" ? "None yet" : `Sent as ${connector.header_name ?? "Authorization"}; its value is never shown.`}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-faint">Name to agents</dt>
                <dd className="mt-0.5 font-mono text-xs">{connector.name}__&lt;tool&gt;</dd>
              </div>
              <div>
                <dt className="text-xs text-faint">Added</dt>
                <dd className="mt-0.5">
                  By @{connector.added_by} · <TimeAgo at={connector.added_at} />
                </dd>
              </div>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
