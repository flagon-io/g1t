import { ArrowRight, Box, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data } from "react-router";

import type { Route } from "./+types/workspace-overview";
import { Avatar, Pill } from "../../components/ui";
import { UsageCard } from "../../components/usage-card";
import { identity, workspaceAgents } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { usageFor } from "../../lib/workspace-usage.server";
import { workspaceProjects } from "../../lib/workspace-projects.server";
import { page } from "../../lib/meta";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Workspace · ${params.owner} · g1t` });
}

/** Most members listed before "and N more". */
const MAX_FACES = 10;

/**
 * The workspace at a glance, for every member: who is in it, its projects
 * and agents, and the month's usage against its plan. Each part is left out
 * when its service does not answer.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const [members, usage, projects, agents] = await Promise.all([
    identity.listMembers(slug, viewer).catch(() => null),
    usageFor(slug, viewer),
    workspaceProjects(slug, viewer).catch(() => null),
    workspaceAgents.list(slug, viewer!).catch(() => null),
  ]);
  return {
    slug,
    role,
    members: members?.ok ? members.value : null,
    usage,
    projects: projects?.ok ? projects.value.length : null,
    agents: agents?.ok ? agents.value.filter((agent) => !agent.archived_at).length : null,
  };
}

function Tile({ icon, label, value, to, action }: { icon: ReactNode; label: string; value: string; to: string; action: string }) {
  return (
    <Link to={to} className="group rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-faint group-hover:text-muted">
        {action} <ArrowRight size={11} />
      </p>
    </Link>
  );
}

export default function WorkspaceOverview({ loaderData }: Route.ComponentProps) {
  const { slug, role, members, usage, projects, agents } = loaderData;
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile icon={<Users size={12} />} label="Members" value={members ? String(members.length) : "—"} to={role === "owner" ? `/${slug}/-/members` : `/${slug}/-/people`} action={role === "owner" ? "Manage people" : "See everyone"} />
        <Tile icon={<Sparkles size={12} />} label="Agents" value={agents == null ? "—" : String(agents)} to={`/${slug}/-/agents`} action="Open Agents" />
        <Tile icon={<Box size={12} />} label="Projects" value={projects == null ? "—" : String(projects)} to={`/${slug}/-/projects`} action="Open Code" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {usage ? (
            <UsageCard slug={slug} glance={usage} owner={role === "owner"} />
          ) : (
            <section className="rounded-xl border border-line bg-surface p-5">
              <h2 className="font-medium">Usage</h2>
              <p className="mt-1.5 text-sm text-muted">This month&apos;s usage isn&apos;t available right now.</p>
              <Link to={`/${slug}/-/usage`} className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
                Open Usage <ArrowRight size={13} />
              </Link>
            </section>
          )}
          <section className="rounded-xl border border-line bg-surface p-5">
            <h2 className="flex items-center gap-2 font-medium">
              <ShieldCheck size={15} className="text-faint" />
              Policies
            </h2>
            <p className="mt-1.5 text-sm text-muted">
              What agents may reach, run and spend, the rules every repository follows, and how the workspace&apos;s security is set up.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <Link to={`/${slug}/-/guardrails`} className="text-accent hover:underline">
                Guardrails
              </Link>
              <Link to={`/${slug}/-/rules`} className="text-accent hover:underline">
                Rules
              </Link>
              <Link to={`/${slug}/-/security/settings`} className="text-accent hover:underline">
                Security settings
              </Link>
              <Link to={`/${slug}/-/audit`} className="text-accent hover:underline">
                Audit log
              </Link>
            </div>
          </section>
        </div>
        <section className="self-start rounded-xl border border-line bg-surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Members</h2>
            <Link to={role === "owner" ? `/${slug}/-/members` : `/${slug}/-/people`} className="text-xs text-muted hover:text-fg">
              {role === "owner" ? "Manage" : "See all"}
            </Link>
          </div>
          {members ? (
            <>
              <ul className="mt-3 space-y-2">
                {members.slice(0, MAX_FACES).map((member) => (
                  <li key={member.username} className="flex items-center gap-2.5 text-sm">
                    <Avatar name={member.username} image={member.avatar} size={24} />
                    <Link to={`/u/${member.username}`} className="min-w-0 grow truncate hover:text-accent">
                      {member.name?.trim() || member.username}
                      {member.name?.trim() && <span className="ml-1.5 font-mono text-xs text-faint">{member.username}</span>}
                    </Link>
                    {member.role === "owner" && <Pill>owner</Pill>}
                  </li>
                ))}
              </ul>
              {members.length > MAX_FACES && <p className="mt-2 text-xs text-faint">and {members.length - MAX_FACES} more</p>}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted">The member list isn&apos;t available right now.</p>
          )}
        </section>
      </div>
    </div>
  );
}
