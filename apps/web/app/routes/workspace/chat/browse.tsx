import { Hash, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Channel } from "@g1t/contracts";

import type { Route } from "./+types/browse";
import { ChatUnavailable } from "../../../components/chat/empty";
import { CreateChannelButton, useChatSend } from "../../../components/chat/actions";
import { channelPath } from "../../../lib/chat";
import { sidebarOrNull } from "../../../lib/chat.server";
import { page } from "../../../lib/meta";
import { chat } from "../../../lib/services.server";
import { requireUser } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Browse channels · ${params.owner} · g1t` });
}

/** Every public channel in the workspace, joined or not. */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const [open, sidebar] = await Promise.all([chat.browse(slug, viewer).catch(() => null), sidebarOrNull(slug, viewer)]);
  if (!open?.ok) return { slug, unavailable: true as const };
  const mine = new Set((sidebar?.entries ?? []).map((entry) => entry.channel.id));
  const listed = new Map<string, Channel>();
  for (const channel of open.value) listed.set(channel.id, channel);
  for (const entry of sidebar?.entries ?? []) if (entry.channel.kind === "channel") listed.set(entry.channel.id, entry.channel);
  const channels = [...listed.values()].filter((channel) => !channel.archived_at).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return { slug, unavailable: false as const, channels, joined: [...mine] };
}

export default function Browse({ loaderData }: Route.ComponentProps) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const send = useChatSend(loaderData.slug);
  const [joining, setJoining] = useState<string | null>(null);
  const shown = useMemo(() => {
    if (loaderData.unavailable) return [];
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return loaderData.channels.filter((c) => !q || (c.name ?? "").includes(q) || (c.topic ?? "").toLowerCase().includes(q));
  }, [loaderData, query]);
  if (loaderData.unavailable) return <ChatUnavailable title="Browse channels" />;
  const joined = new Set(loaderData.joined);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 lg:py-12">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Browse channels</h1>
          <p className="mt-1 text-sm text-muted">Every public channel in {loaderData.slug}. Anyone in the workspace can read and join them.</p>
        </div>
        <CreateChannelButton slug={loaderData.slug} variant="button" />
      </div>
      <label className="mt-6 flex h-10 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm focus-within:border-accent-dim">
        <Search size={15} className="text-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search channels"
          aria-label="Search channels"
          className="min-w-0 grow bg-transparent outline-none placeholder:text-faint"
        />
      </label>
      <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {shown.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted">No channel matches.</li>}
        {shown.map((channel) => {
          const isIn = joined.has(channel.id);
          return (
            <li key={channel.id} className="flex items-center gap-3 px-4 py-3">
              <Hash size={16} className="shrink-0 text-faint" />
              <div className="min-w-0 grow">
                <Link to={channelPath(loaderData.slug, channel)} className="font-medium hover:text-accent">
                  {channel.name}
                </Link>
                {channel.topic && <p className="truncate text-sm text-muted">{channel.topic}</p>}
              </div>
              {isIn ? (
                <span className="text-xs text-faint">Joined</span>
              ) : (
                <button
                  type="button"
                  disabled={joining === channel.id}
                  onClick={async () => {
                    setJoining(channel.id);
                    const done = await send({ intent: "join", channel_id: channel.id });
                    setJoining(null);
                    if (done.ok) navigate(channelPath(loaderData.slug, channel));
                  }}
                  className="h-8 rounded-md border border-line px-3 text-[0.8125rem] font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-raised disabled:opacity-50"
                >
                  {joining === channel.id ? "Joining…" : "Join"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
