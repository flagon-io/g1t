import { History, Lock, MessageSquare, Workflow } from "lucide-react";
import { Link, data, useOutletContext } from "react-router";

import type { AgentActivity, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/activity";
import { readOrNull } from "../../../components/agents/actions.server";
import { Quiet, StatusChip } from "../../../components/agents/parts";
import { TimeAgo } from "../../../components/ui";
import { Card } from "../../../components/ui/card";
import { channelPath } from "../../../lib/chat";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { money } from "../../../lib/money";

/** Everything the agent did lately: its replies and its sessions, newest first. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ activity: AgentActivity[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  return { activity: await readOrNull(workspaceAgents.activity(params.owner.toLowerCase(), params.handle.toLowerCase(), viewer)) };
}

const REPLY_STATUS: Record<string, string> = { working: "Writing…", failed: "Failed", blocked: "Held back: budget or access" };

export default function ActivityTab({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { activity } = loaderData;
  if (!activity) return <Quiet title="Activity can't be shown right now">The agents service didn&apos;t answer. Reload in a moment.</Quiet>;
  if (activity.length === 0) {
    return (
      <Quiet title="Nothing yet" icon={<History size={20} />}>
        Every reply and session {agent.display_name} takes on shows here, with who asked, the model and what it cost.{" "}
        <Link to={`/${params.owner}/-/audit`} className="text-accent hover:underline">
          The audit log
        </Link>{" "}
        has every tool call.
      </Quiet>
    );
  }
  return (
    <div className="space-y-4">
      <Card asChild className="divide-y divide-line/60 overflow-hidden">
        <ul>
          {activity.map((item) => (
            <Item key={`${item.kind}:${item.id}`} item={item} slug={params.owner} handle={agent.handle} />
          ))}
        </ul>
      </Card>
      <p className="text-xs text-faint">
        The latest replies and sessions. Every tool call is in the{" "}
        <Link to={`/${params.owner}/-/audit`} className="text-muted hover:text-fg hover:underline">
          audit log
        </Link>
        .
      </p>
    </div>
  );
}

function Item({ item, slug, handle }: { item: AgentActivity; slug: string; handle: string }) {
  const where = item.visible ? (item.channel_name ? `#${item.channel_name}` : "A direct message") : null;
  const href = !item.visible
    ? null
    : item.kind === "session"
      ? `/${slug}/-/agents/${handle}/sessions/${item.id}`
      : item.ref
        ? `${channelPath(slug, { id: item.channel_id, kind: item.channel_name ? "channel" : "dm", name: item.channel_name })}?thread=${encodeURIComponent(item.ref)}`
        : null;
  const headline = !item.visible ? (
    <span className="inline-flex items-center gap-1.5 text-muted italic">
      <Lock size={12} className="not-italic" />
      In a conversation you&apos;re not in
    </span>
  ) : item.kind === "session" ? (
    <span className="font-medium">{item.title ?? "A session"}</span>
  ) : (
    <span>
      Replied{item.asked_by_username ? <> to @{item.asked_by_username}</> : null} in {where}
    </span>
  );
  return (
    <li className="relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-raised/40">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
        {item.kind === "session" ? <Workflow size={14} /> : <MessageSquare size={14} />}
      </span>
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {href ? (
            <Link to={href} className="min-w-0 truncate after:absolute after:inset-0 hover:underline">
              {headline}
            </Link>
          ) : (
            headline
          )}
          {item.kind === "session" ? (
            <StatusChip status={item.status} />
          ) : (
            item.status !== "replied" && <span className="text-xs text-faint">{REPLY_STATUS[item.status] ?? item.status.replaceAll("_", " ")}</span>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-faint">
          <span>{item.kind === "session" ? "Session" : "Reply"}</span>
          {item.kind === "session" && where && <span>· {where}</span>}
          {item.kind === "session" && item.visible && item.asked_by_username && <span>· asked by @{item.asked_by_username}</span>}
          {item.model && <span className="font-mono">· {item.model}</span>}
          {item.tools > 0 && (
            <span>
              · {item.tools} {item.tools === 1 ? "tool" : "tools"}
            </span>
          )}
          <span>
            · <TimeAgo at={item.created_at} />
          </span>
        </p>
      </div>
      <span className="shrink-0 text-sm tabular-nums">{money(item.charged_micros)}</span>
    </li>
  );
}
