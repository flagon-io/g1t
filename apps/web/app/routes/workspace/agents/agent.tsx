import { MessageSquare } from "lucide-react";
import { Form, Outlet, data, redirect, useNavigation } from "react-router";

import type { WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/agent";
import { AgentFace } from "../../../components/agents-mode";
import { AgentPill, StatusDot, statusLabel } from "../../../components/chat/marks";
import { TabLink } from "../../../components/ui";
import { channelPath } from "../../../lib/chat";
import { page } from "../../../lib/meta";
import { chat, workspaceAgents } from "../../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  const name = loaderData?.agent?.display_name ?? `@${params.handle}`;
  return page(args, { title: `${name} · Agents · ${params.owner} · g1t` });
}

/** One agent: who it is, for its tabs. Null when the agents service does not answer. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ agent: WorkspaceAgent | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await workspaceAgents.get(params.owner.toLowerCase(), params.handle.toLowerCase(), viewer).catch(() => null);
  if (found && !found.ok && found.error.code === "not_found") throw data(null, { status: 404 });
  return { agent: found?.ok ? found.value : null };
}

/** Message: the direct message with this agent, opened or made. */
export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  const form = await request.formData();
  if (form.get("intent") !== "message") return { error: "Unknown request." };
  const id = String(form.get("agent") ?? "");
  const dm = await chat.openDm(slug, viewer, [{ kind: "agent", id }]).catch(() => null);
  if (!dm?.ok) return { error: dm ? dm.error.message : "Chat didn't answer. Try again in a moment." };
  throw redirect(channelPath(slug, dm.value));
}

/** The button that opens the direct message with an agent. */
export function MessageAgent({ slug, agent, variant = "quiet" }: { slug: string; agent: WorkspaceAgent; variant?: "quiet" | "accent" }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "message";
  return (
    <Form method="post" action={`/${slug}/-/agents/${agent.handle}`}>
      <input type="hidden" name="intent" value="message" />
      <input type="hidden" name="agent" value={agent.id} />
      <button
        type="submit"
        disabled={busy}
        className={`inline-flex h-9 items-center gap-2 rounded-md px-3.5 text-sm font-medium transition-colors disabled:opacity-60 ${
          variant === "accent" ? "bg-accent text-bg hover:bg-accent-hover" : "border border-line text-fg/90 hover:border-line-strong hover:bg-surface"
        }`}
      >
        <MessageSquare size={15} />
        {busy ? "Opening…" : "Message"}
      </button>
    </Form>
  );
}

export default function AgentPage({ loaderData, params }: Route.ComponentProps) {
  const { agent } = loaderData;
  const base = `/${params.owner}/-/agents/${params.handle}`;
  if (!agent) {
    return (
      <div className="rounded-xl border border-dashed border-line px-6 py-14 text-center">
        <p className="font-medium">@{params.handle} can't be shown right now</p>
        <p className="mt-1.5 text-sm text-muted">The agents service didn't answer. It's usually back within a minute; reload to try again.</p>
      </div>
    );
  }
  return (
    <div>
      <header className="flex flex-wrap items-start gap-4">
        <span className="relative">
          <AgentFace agent={agent} size={56} />
          <StatusDot status={agent.status} className="absolute -right-0.5 -bottom-0.5 size-3 ring-[3px] ring-bg" />
        </span>
        <div className="min-w-0 grow">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{agent.display_name}</h1>
            <AgentPill />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            <span className="font-mono">@{agent.handle}</span>
            <span className="mx-1.5 text-line-strong">·</span>
            {agent.role}
          </p>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-faint">
            <StatusDot status={agent.status} />
            {statusLabel(agent.status)}
            <span className="text-line-strong">·</span>
            Version {agent.version}
          </p>
        </div>
        <MessageAgent slug={params.owner} agent={agent} variant="accent" />
      </header>
      <nav aria-label={`${agent.display_name}'s pages`} className="mt-8 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
        <TabLink to={base} end icon={null}>
          Desk
        </TabLink>
        <TabLink to={`${base}/profile`} icon={null}>
          Profile
        </TabLink>
        <TabLink to={`${base}/spend`} icon={null}>
          Spend
        </TabLink>
        <TabLink to={`${base}/activity`} icon={null}>
          Activity
        </TabLink>
      </nav>
      <div className="pt-8">
        <Outlet context={agent} />
      </div>
    </div>
  );
}
