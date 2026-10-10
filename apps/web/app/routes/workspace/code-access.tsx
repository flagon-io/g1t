import { Code2, MessagesSquare } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/code-access";
import { page } from "../../lib/meta";
import { identity } from "../../lib/services.server";
import { requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Code access · ${params.owner} · g1t` });
}

/**
 * What a member without Code access sees in place of a repository, an
 * issue, a pull request or a project list: what it was, and who to ask.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const members = await identity.listMembers(params.owner, viewer).catch(() => null);
  const owners = members?.ok ? members.value.filter((m) => m.role === "owner").slice(0, 4).map((m) => m.username) : [];
  const from = new URL(request.url).searchParams.get("from");
  // Only a path on this site, shown as text.
  return { owners, from: from && /^\/[^/]/.test(from) ? from.split("?")[0] : null };
}

export default function CodeAccess({ loaderData, params }: Route.ComponentProps) {
  const { owners, from } = loaderData;
  const what = from ? from.split("/").filter(Boolean).slice(1).join("/") : null;
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <span className="mx-auto flex size-12 items-center justify-center rounded-xl border border-line bg-surface text-muted">
        <Code2 size={22} />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Ask an owner for Code access</h1>
      <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">
        {what ? (
          <>
            <span className="font-mono text-fg-soft">{what}</span> is part of Code in {params.owner}.
          </>
        ) : (
          <>This is part of Code in {params.owner}.</>
        )}{" "}
        Your membership includes Chat, Artifacts, Agents and Notifications. An owner can turn on Code access for you.
      </p>
      {owners.length > 0 && (
        <p className="mt-4 text-sm text-muted">
          Owners:{" "}
          {owners.map((owner, index) => (
            <span key={owner}>
              {index > 0 && ", "}
              <Link to={`/u/${owner}`} className="font-medium text-fg hover:text-accent">
                @{owner}
              </Link>
            </span>
          ))}
        </p>
      )}
      <div className="mt-8 flex justify-center gap-2">
        <Link
          to={`/${params.owner}/-/chat`}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3.5 text-sm font-medium text-bg transition-colors hover:bg-accent-hover"
        >
          <MessagesSquare size={15} />
          Back to Chat
        </Link>
        <Link
          to={`/${params.owner}/-/today`}
          className="inline-flex h-9 items-center rounded-md border border-line px-3.5 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-surface"
        >
          Today
        </Link>
      </div>
      <p className="mt-6 text-xs text-faint">Agents can still explain how things work and what changed; they never show source code.</p>
    </div>
  );
}
