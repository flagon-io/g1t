import { CloudOff, Flag, Undo2, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, useRouteLoaderData } from "react-router";

import type { RepoMirror } from "@g1t/contracts";

import { ConfirmDialog } from "./repo-lifecycle";
import { ButtonLink, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import {
  type MirrorBrief,
  type MirroredRepo,
  followersOf,
  leaderOf,
  mirrorBadge,
  mirrorBanner,
  mirrorReason,
  mirroringSettings,
  workflowReason,
} from "../lib/mirror";

/**
 * The repository the page is in, its remotes in brief and whether the
 * viewer manages them, from the repository layout's loader. Empty outside
 * a repository.
 */
export function useRepoMirror(): { repo: MirroredRepo | null; briefs: MirrorBrief[]; admin: boolean } {
  const layout = useRouteLoaderData("routes/repo/layout") as
    | { repo?: MirroredRepo; mirrorBriefs?: MirrorBrief[]; access?: { can?: { manage_integrations?: boolean } } }
    | undefined;
  return {
    repo: layout?.repo ?? null,
    briefs: layout?.mirrorBriefs ?? [],
    admin: Boolean(layout?.access?.can?.manage_integrations),
  };
}

/**
 * Why pushing, merging, opening issues and pull requests and assigning
 * agents are off in the repository the page is in; null when they are not
 * off because it is a mirror.
 */
export function useMirrorReason(): string | null {
  return mirrorReason(useRepoMirror().repo);
}

/** Why running workflows is off: a mirror standing by or handing back runs nothing. */
export function useWorkflowReason(): string | null {
  return workflowReason(useRepoMirror().repo);
}

/** What the badge means, said on hover. */
function badgeHint(mirror: RepoMirror | null | undefined, briefs: readonly MirrorBrief[]): string {
  if (mirror) {
    switch (mirror.state) {
      case "standby":
        return `A read-only copy that follows ${mirror.remote}. Work happens there; clone and fetch freely here.`;
      case "ci":
        return `${mirror.remote} keeps the code; g1t runs its workflows and sends the results back.`;
      case "takeover":
        return `g1t leads for now: everything works here until it is handed back to ${mirror.remote}.`;
      case "handing_back":
        return `Going back to ${mirror.remote} branch by branch. Read-only until it is done.`;
    }
  }
  const names = followersOf(briefs).map((brief) => brief.name);
  return `g1t leads. Every push here goes to ${names.join(", ")}.`;
}

/**
 * Beside the repository's name: what it is to its remotes. An amber dot
 * when the remote a mirror follows is not answering.
 */
export function MirrorBadge({ mirror, briefs }: { mirror: RepoMirror | null | undefined; briefs: readonly MirrorBrief[] }) {
  const badge = mirrorBadge(mirror, briefs);
  if (!badge) return null;
  const silent = Boolean(mirror) && leaderOf(briefs)?.reachable === false;
  return (
    <Hint label={badgeHint(mirror, briefs)}>
      <Badge tone={badge.tone} tabIndex={0} className="min-w-0 max-w-full px-2 py-0.5 text-xs font-normal">
        {silent && <span aria-label="Not answering" className="size-1.5 shrink-0 rounded-full bg-warn" />}
        <span className="truncate">{badge.label}</span>
        {badge.more > 0 && <span className="shrink-0 opacity-70">+{badge.more} more</span>}
      </Badge>
    </Hint>
  );
}

const BANNER_TONES = {
  warn: { box: "border-warn/40 bg-warn/5", icon: "text-warn", action: "text-warn" },
  info: { box: "border-info/40 bg-info/5", icon: "text-info", action: "text-info" },
} as const;

/** A compact line across the top of the page, with what it is about and one action. */
function BannerBox({ tone, icon, title, children, action, className = "" }: {
  tone: keyof typeof BANNER_TONES;
  className?: string;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const colours = BANNER_TONES[tone];
  return (
    <div
      role="status"
      className={`flex flex-col gap-2 rounded-lg border px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between ${colours.box} ${className}`}
    >
      <p className="flex min-w-0 gap-2.5">
        <span className={`mt-0.5 shrink-0 ${colours.icon} [&_svg]:size-4`}>{icon}</span>
        <span className="min-w-0">
          <span className="font-medium text-fg">{title}</span>
          {children && <> <span className="text-muted">{children}</span></>}
        </span>
      </p>
      {action && <div className={`shrink-0 pl-6.5 font-medium sm:pl-0 ${colours.action}`}>{action}</div>}
    </div>
  );
}

/**
 * Taking over, from anywhere: says what it does and posts to the
 * mirroring settings, which then show it.
 */
export function TakeOverDialog({
  base,
  full,
  mirror,
  error,
  trigger,
}: {
  base: string;
  full: string;
  mirror: Pick<RepoMirror, "remote" | "holdDeploys">;
  error?: string | null;
  trigger: (open: () => void) => ReactNode;
}) {
  return (
    <ConfirmDialog
      intent="take-over"
      action={mirroringSettings(base)}
      title={`Take over ${full}?`}
      description={`g1t leads ${full} until you hand it back. Pushes, pull requests, agents and workflows work here meanwhile.`}
      submit="Take over"
      busy="Taking over…"
      danger={false}
      error={error}
      trigger={trigger}
    >
      <li>{mirror.remote} keeps what it has. Nothing goes back to it until you hand it back, branch by branch.</li>
      {mirror.holdDeploys !== false && <li>Workflows that deploy wait for someone to approve them.</li>}
    </ConfirmDialog>
  );
}

/**
 * Across the top of a mirror's pages, when there is something to know: its
 * remote is not answering, g1t runs its CI, has taken over, or is handing
 * back. A mirror standing by whose remote answers gets none: the badge
 * beside its name says it.
 */
export function MirrorBanner({
  base,
  full,
  mirror,
  briefs,
  admin,
  className,
}: {
  base: string;
  full: string;
  mirror: RepoMirror | null | undefined;
  briefs: readonly MirrorBrief[];
  /** Whether the viewer manages its mirroring: they get its one action. */
  admin: boolean;
  className?: string;
}) {
  const kind = mirrorBanner(mirror, briefs);
  if (!kind || !mirror) return null;
  const settings = mirroringSettings(base);
  switch (kind) {
    case "unreachable": {
      const synced = leaderOf(briefs)?.syncedAt;
      return (
        <BannerBox
          className={className}
          tone="warn"
          icon={<CloudOff />}
          title={`${mirror.remote} isn't answering.`}
          action={
            admin ? (
              <TakeOverDialog
                base={base}
                full={full}
                mirror={mirror}
                trigger={(open) => (
                  <Button variant="link" size="inline" onClick={open} className="text-inherit">
                    Take over
                  </Button>
                )}
              />
            ) : undefined
          }
        >
          {synced ? (
            <>
              g1t has its copy as of <TimeAgo at={synced} />.
            </>
          ) : (
            "g1t has its copy as of the last sync."
          )}
          {mirror.state === "ci" && " Its workflows keep running here."}
        </BannerBox>
      );
    }
    case "ci":
      return (
        <BannerBox
          className={className}
          tone="info"
          icon={<Workflow />}
          title={`Running ${mirror.remote}'s workflows on g1t.`}
          action={
            admin ? (
              <Form method="post" action={settings}>
                <SubmitButton name="intent" value="ci-off" pending="Ending…" variant="link" size="inline" className="text-inherit">
                  End CI failover
                </SubmitButton>
              </Form>
            ) : undefined
          }
        >
          CI failover started <TimeAgo at={mirror.since} />.
          {mirror.holdDeploys !== false && " Deploying workflows wait for approval."}
        </BannerBox>
      );
    case "takeover":
      return (
        <BannerBox
          className={className}
          tone="warn"
          icon={<Flag />}
          title={`g1t is leading ${full} for now.`}
          action={
            admin ? (
              <ButtonLink to={`${settings}?plan=1#hand-back`} variant="link" size="inline" className="text-inherit">
                Hand back…
              </ButtonLink>
            ) : undefined
          }
        >
          Everything works here; when you're done, hand it back to {mirror.remote}.
        </BannerBox>
      );
    case "handing_back":
      return (
        <BannerBox
          className={className}
          tone="warn"
          icon={<Undo2 />}
          title={`Handing back to ${mirror.remote}…`}
          action={
            admin ? (
              <ButtonLink to={settings} variant="link" size="inline" className="text-inherit">
                Progress
              </ButtonLink>
            ) : undefined
          }
        >
          {full} is read-only until it's done.
        </BannerBox>
      );
  }
}

/**
 * Under the clone address: what pushing here does when the repository
 * mirrors a remote. Null when it leads.
 */
export function MirrorCloneNote({ mirror, base, admin }: { mirror: RepoMirror | null | undefined; base: string; admin: boolean }) {
  if (!mirror) return null;
  const where = admin ? (
    <Link to={mirroringSettings(base)} className="text-fg underline underline-offset-4">
      Settings → Mirroring
    </Link>
  ) : (
    "Settings → Mirroring"
  );
  return (
    <p className="mt-2 text-xs text-muted">
      {mirror.state === "takeover" ? (
        <>g1t leads for now: pushes here go back to {mirror.remote} when it is handed back.</>
      ) : mirror.state === "handing_back" ? (
        <>Handing back to {mirror.remote}: clone and fetch freely; pushes wait until it is done.</>
      ) : (
        <>
          A mirror of {mirror.remote}. Clone and fetch freely; to push, push there, or take over in {where}.
        </>
      )}
    </p>
  );
}

/**
 * On the repository's overview, one quiet line when no banner says it: a
 * mirror standing by, or the remotes that follow it, and when it last synced.
 */
export function MirrorOverviewNote({
  base,
  mirror,
  briefs,
  admin,
  syncedAt,
  lastError,
}: {
  base: string;
  mirror: RepoMirror | null | undefined;
  briefs: readonly MirrorBrief[];
  admin: boolean;
  syncedAt?: string | null;
  lastError?: string | null;
}) {
  const followers = followersOf(briefs);
  // A banner says it already.
  if (mirror && mirrorBanner(mirror, briefs)) return null;
  if (!mirror && followers.length === 0) return null;
  const stuck = followers.filter((brief) => brief.state === "stuck");
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted">
      <p className="min-w-0">
        {mirror ? (
          <>
            A read-only mirror of{" "}
            <a href={mirror.url} target="_blank" rel="noreferrer" className="font-mono break-all text-fg hover:text-accent">
              {mirror.remote}
            </a>
            .
          </>
        ) : (
          <>
            Mirrored to <span className="font-mono text-fg">{followers[0]!.name}</span>
            {followers.length > 1 && ` and ${followers.length - 1} more`}: every push here goes there too.
          </>
        )}
        {syncedAt && (
          <span className="text-faint">
            {" "}
            Synced <TimeAgo at={syncedAt} />.
          </span>
        )}
      </p>
      {admin && (
        <Link to={mirroringSettings(base)} className="text-xs text-muted hover:text-fg">
          Mirroring settings
        </Link>
      )}
      {(lastError || stuck.length > 0) && (
        <p className="w-full text-xs text-warn">
          {lastError ?? `${stuck.map((brief) => brief.name).join(", ")} stopped taking pushes. See Settings → Mirroring.`}
        </p>
      )}
    </div>
  );
}

/** What an action did that people should know, such as the pull requests it opened, with addresses as links. */
export function MirrorNotes({ notes }: { notes: readonly string[] | null | undefined }) {
  if (!notes || notes.length === 0) return null;
  return (
    <div role="status" className="rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-sm">
      <ul className="space-y-1">
        {notes.map((note, at) => (
          <li key={at} className="text-fg-soft">
            {note.split(/(https?:\/\/\S+?)(?=[.,;)]*(?:\s|$))/).map((piece, index) =>
              /^https?:\/\//.test(piece) ? (
                <a key={index} href={piece} className="break-all text-fg underline underline-offset-2 hover:text-accent">
                  {piece}
                </a>
              ) : (
                piece
              ),
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
