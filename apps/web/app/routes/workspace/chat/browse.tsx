import { Archive, Hash, Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/browse";
import { ChatUnavailable } from "../../../components/chat/empty";
import { CreateChannelButton, OWNERS_ONLY_CHANNELS, useChannelCreation, useChatSend } from "../../../components/chat/actions";
import { channelPath } from "../../../lib/chat";
import { sidebarOrNull } from "../../../lib/chat.server";
import { page } from "../../../lib/meta";
import { chat } from "../../../lib/services.server";
import { requireUser } from "../../../lib/session.server";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Browse channels · ${params.owner} · g1t` });
}

/**
 * Every public channel in the workspace, joined or not, and the private
 * ones the viewer is in (the chat service leaves out the rest). With
 * `?archived=1`, the archived ones instead.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const archived = new URL(request.url).searchParams.get("archived") === "1";
  const [listed, sidebar] = await Promise.all([chat.browse(slug, viewer, { archived }).catch(() => null), sidebarOrNull(slug, viewer)]);
  if (!listed?.ok) return { slug, unavailable: true as const };
  const joined = (sidebar?.entries ?? []).map((entry) => entry.channel.id);
  return { slug, unavailable: false as const, archived, channels: listed.value, joined };
}

export default function Browse({ loaderData }: Route.ComponentProps) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const send = useChatSend(loaderData.slug);
  const [joining, setJoining] = useState<string | null>(null);
  const may = useChannelCreation();
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
          <h1 className="text-2xl font-semibold tracking-tight">{loaderData.archived ? "Archived channels" : "Browse channels"}</h1>
          <p className="mt-1 text-sm text-muted">
            {loaderData.archived
              ? "Channels no one posts in any more. Their history stays readable; whoever may archive a channel may bring it back."
              : `Every public channel in ${loaderData.slug}, which anyone in the workspace can read and join, and the private ones you're in.`}
          </p>
          {!loaderData.archived && !may.any && <p className="mt-1 text-xs text-faint">{OWNERS_ONLY_CHANNELS}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={loaderData.archived ? `/${loaderData.slug}/-/chat/browse` : `/${loaderData.slug}/-/chat/browse?archived=1`}
            className="inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            {loaderData.archived ? <Hash size={15} /> : <Archive size={15} />}
            {loaderData.archived ? "Current channels" : "Archived"}
          </Link>
          {!loaderData.archived && <CreateChannelButton slug={loaderData.slug} variant="button" />}
        </div>
      </div>
      <Card asChild radius="lg" className="mt-6 flex h-10 items-center gap-2 px-3 text-sm focus-within:border-accent-dim">
        <label>
          <Search size={15} className="text-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search channels"
            aria-label="Search channels"
            className="min-w-0 grow bg-transparent outline-none placeholder:text-faint"
          />
        </label>
      </Card>
      <Card asChild divided className="mt-4 overflow-hidden">
        <ul>
          {shown.length === 0 && (
            <li className="px-4 py-10 text-center text-sm text-muted">
              {query ? "No channel matches." : loaderData.archived ? "No archived channels." : "No channels yet."}
            </li>
          )}
          {shown.map((channel) => {
            const isIn = joined.has(channel.id);
            return (
              // The whole row opens the channel: its name's link reaches over
              // it (`after:inset-0`), and Join sits above that, so nothing
              // interactive nests inside anything else.
              <li
                key={channel.id}
                className="group/card relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/50 has-[a:focus-visible]:bg-raised/50 has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-accent has-[a:focus-visible]:ring-inset"
              >
                {channel.private ? (
                  <Lock size={15} className="shrink-0 text-faint" aria-label="Private" />
                ) : (
                  <Hash size={16} className="shrink-0 text-faint" aria-label="Public" />
                )}
                <div className="min-w-0 grow">
                  <Link
                    to={channelPath(loaderData.slug, channel)}
                    className="font-medium outline-none group-hover/card:text-accent after:absolute after:inset-0 after:content-['']"
                  >
                    {channel.name}
                  </Link>
                  {channel.private && <span className="ml-2 text-xs text-faint">Private</span>}
                  {channel.topic && <p className="truncate text-sm text-muted">{channel.topic}</p>}
                </div>
                {loaderData.archived ? (
                  <span className="text-xs text-faint">Archived</span>
                ) : isIn ? (
                  <span className="text-xs text-faint">Joined</span>
                ) : (
                  <Button
                    type="button"
                    disabled={joining === channel.id}
                    onClick={async () => {
                      setJoining(channel.id);
                      const done = await send({ intent: "join", channel_id: channel.id });
                      setJoining(null);
                      if (done.ok) navigate(channelPath(loaderData.slug, channel));
                    }}
                    variant="outline"
                    size="sm"
                    className="relative z-10 px-3 text-fg/90 hover:bg-raised"
                  >
                    {joining === channel.id ? "Joining…" : "Join"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
