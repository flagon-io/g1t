/**
 * The Marketplace's pieces (routes/workspace/marketplace/): listings for
 * agents and integrations with what the workspace has of each, the button
 * that adds one (owners) or asks an owner to (everyone else), and a
 * request as owners and askers see it.
 */
import { ArrowRight, Check, CircleAlert, Clock, Plus, Send, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { ExtensionManifest, InstallRequest, ListingTier } from "@g1t/contracts";

import { PixelCreature } from "./agent-avatar";
import { ConnectorMark } from "./connectors";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Hint } from "./ui/hint";
import { ErrorText, SubmitButton, Textarea, TimeAgo } from "./ui";
import { type AgentListing, type ExtensionListing, type IntegrationListing, TIERS, catalogAgentPath, extensionPath, hirePath, marketplacePath } from "../lib/marketplace";
import { cn } from "../lib/cn";

const SMALL = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors";
export const ACTION = {
  primary: `${SMALL} bg-fg text-bg hover:bg-fg-hover`,
  quiet: `${SMALL} border border-line text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg`,
};

/** Who stands behind a listing: a small badge, with the sentence on hover. */
export function TierBadge({ tier }: { tier: ListingTier }) {
  return (
    <Hint label={TIERS[tier].about}>
      <span tabIndex={0} className="inline-flex rounded outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <Badge tone={tier === "official" ? "accent" : tier === "verified" ? "success" : tier === "community" ? "warn" : "info"}>{TIERS[tier].label}</Badge>
      </span>
    </Hint>
  );
}

/** "Coming", on what is planned and not built. */
export function ComingBadge() {
  return <Badge tone="neutral">Coming</Badge>;
}

/** A section's heading, with a count or a link at its end. */
export function SectionHead({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {aside && <div className="shrink-0 text-xs text-muted">{aside}</div>}
      </div>
      {children && <p className="mt-1 max-w-2xl text-sm text-muted">{children}</p>}
    </div>
  );
}

/** A link at the end of a section's heading. */
export function SeeAll({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} prefetch="intent" className="inline-flex items-center gap-1 text-[0.8125rem] text-muted hover:text-fg">
      {children}
      <ArrowRight size={13} />
    </Link>
  );
}

/**
 * Asking the workspace's owners to add something: a dialog with an
 * optional note, sent to the requests route. Once sent, it says so.
 */
export function RequestButton({ slug, listing, name, requested, className }: { slug: string; listing: string; name: string; requested: boolean; className?: string }) {
  const fetcher = useFetcher<{ error: string | null }>({ key: `request:${listing}` });
  const [open, setOpen] = useState(false);
  const sent = fetcher.state === "idle" && fetcher.data?.error === null;
  useEffect(() => {
    if (sent) setOpen(false);
  }, [sent]);
  if (requested || sent) {
    return (
      <Hint label="The workspace's owners have your request. You'll hear when they answer.">
        <span tabIndex={0} className={cn(SMALL, "border border-line text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}>
          <Clock size={13} />
          Requested
        </span>
      </Hint>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className={cn(ACTION.quiet, className)}>
          <Send size={13} />
          Request
        </button>
      </DialogTrigger>
      <DialogContent>
        <fetcher.Form method="post" action={marketplacePath(slug, "requests")} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Ask to add {name}</DialogTitle>
            <DialogDescription>Only the workspace's owners add agents and integrations. Each of them is notified, and you hear back when one answers.</DialogDescription>
          </DialogHeader>
          <input type="hidden" name="intent" value="request" />
          <input type="hidden" name="listing" value={listing} />
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">
              Why you want it <span className="font-normal text-faint">(optional)</span>
            </span>
            <Textarea name="note" rows={3} maxLength={280} placeholder="What it would help with" />
          </label>
          {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
          <DialogFooter>
            <SubmitButton fetcher={fetcher} pending="Sending…">
              <Send size={14} />
              Send request
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** "3 waiting": open requests for a listing, for owners. */
function Waiting({ slug, count }: { slug: string; count: number }) {
  if (count === 0) return null;
  return (
    <Link to={marketplacePath(slug, "requests")} className="text-xs text-warn hover:underline">
      {count} {count === 1 ? "request" : "requests"}
    </Link>
  );
}

/** What an owner or a member can do with a role in the catalog. */
export function AgentAction({ listing, slug, owner, className }: { listing: AgentListing; slug: string; owner: boolean; className?: string }) {
  if (owner) {
    return (
      <Link to={hirePath(slug, listing.template.id)} className={cn(listing.hired.length > 0 ? ACTION.quiet : ACTION.primary, className)}>
        <Plus size={14} />
        {listing.hired.length > 0 ? "Add another" : "Add to workspace"}
      </Link>
    );
  }
  return <RequestButton slug={slug} listing={listing.ref} name={`${listing.template.display_name}, ${listing.template.title}`} requested={listing.requested} className={className} />;
}

/** A role in the agent catalog, as a card: its face, the name it suggests, what it does, and what the workspace has of it. */
export function AgentCard({ listing, slug, owner }: { listing: AgentListing; slug: string; owner: boolean }) {
  const { template, hired } = listing;
  return (
    <article className="group relative flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <PixelCreature seed={template.handle} size={44} />
        <div className="min-w-0 grow">
          <h3 className="truncate text-sm font-semibold">
            <Link to={catalogAgentPath(slug, template.id)} prefetch="intent" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">
              {template.display_name}
            </Link>
          </h3>
          <p className="truncate text-xs text-muted">
            {template.title}
          </p>
        </div>
        <TierBadge tier="official" />
      </div>
      <ul className="mt-3 grow space-y-1">
        {template.responsibilities.slice(0, 3).map((duty) => (
          <li key={duty} className="flex gap-2 text-[0.8125rem] leading-snug text-muted">
            <span className="mt-[0.45rem] size-1 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
            <span className="line-clamp-1">{duty}</span>
          </li>
        ))}
      </ul>
      <div className="relative mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="min-w-0 truncate text-xs text-faint">
          {/* What waits on an owner says more than what isn't there. */}
          {owner && listing.waiting > 0 && hired.length === 0 ? (
            <Waiting slug={slug} count={listing.waiting} />
          ) : hired.length === 0 ? (
            "Not added"
          ) : hired.length === 1 ? (
            `@${hired[0]!.handle} works here`
          ) : (
            `${hired.length} work here`
          )}
        </span>
        <AgentAction listing={listing} slug={slug} owner={owner} />
      </div>
    </article>
  );
}

/** What an owner or a member can do with an integration. */
export function IntegrationAction({ listing, slug, owner }: { listing: IntegrationListing; slug: string; owner: boolean }) {
  if (listing.connected) {
    return listing.href ? (
      <Link to={listing.href} className={ACTION.quiet}>
        Manage
      </Link>
    ) : null;
  }
  if (owner) {
    return listing.href ? (
      <Link to={listing.href} className={ACTION.primary}>
        <Plus size={14} />
        Connect
      </Link>
    ) : null;
  }
  return <RequestButton slug={slug} listing={listing.ref} name={listing.view.name} requested={listing.requested} />;
}

/** An integration as a card: its mark, what it does for agents, and whether the workspace has it. */
export function IntegrationCard({ listing, slug, owner }: { listing: IntegrationListing; slug: string; owner: boolean }) {
  const { view, connected } = listing;
  return (
    <article className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <ConnectorMark view={view} size={40} />
        <div className="min-w-0 grow">
          <h3 className="truncate text-sm font-semibold">{view.name}</h3>
          <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{view.description}</p>
        </div>
      </div>
      {view.capabilities.length > 0 && (
        <ul className="mt-3 flex grow flex-wrap content-start gap-1.5" aria-label="What it does">
          {view.capabilities.map((capability) => (
            <li key={capability} className="rounded-full bg-raised px-2 py-px text-[0.6875rem] text-muted">
              {capability}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          {connected ? (
            connected.problem ? (
              <Hint label={connected.problem}>
                <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1 text-warn outline-none">
                  <CircleAlert size={13} className="shrink-0" />
                  <span className="truncate">Needs attention</span>
                </span>
              </Hint>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1 text-success">
                <Check size={13} className="shrink-0" />
                <span className="truncate">Connected</span>
              </span>
            )
          ) : (
            <span className="truncate text-faint">Not connected</span>
          )}
          {owner && listing.waiting > 0 && (
            <>
              <span className="text-faint">·</span>
              <Waiting slug={slug} count={listing.waiting} />
            </>
          )}
        </span>
        <IntegrationAction listing={listing} slug={slug} owner={owner} />
      </div>
    </article>
  );
}

/** An extension's mark: its initials on a steady colour, until listings bring their own icon. */
export function ExtensionMark({ manifest, size = 40 }: { manifest: Pick<ExtensionManifest, "id" | "name">; size?: number }) {
  return <ConnectorMark view={{ id: manifest.id, name: manifest.name, provider: null }} size={size} />;
}

/** What an owner or a member can do with an extension: install or ask, once it is published; nothing before. */
export function ExtensionAction({ listing, slug, owner, className }: { listing: ExtensionListing; slug: string; owner: boolean; className?: string }) {
  const fetcher = useFetcher<{ error: string | null }>();
  const { manifest, install } = listing;
  if (manifest.status !== "available") {
    return (
      <Hint label="Not published yet. It can be installed from its first release.">
        <span tabIndex={0} className={cn(SMALL, "border border-dashed border-line-strong text-muted outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}>
          Soon
        </span>
      </Hint>
    );
  }
  if (install) return <Badge tone={install.enabled ? "success" : "warn"}>{install.enabled ? `Installed · ${install.version}` : "Switched off"}</Badge>;
  if (!owner) return <RequestButton slug={slug} listing={listing.ref} name={manifest.name} requested={listing.requested} className={className} />;
  return (
    <fetcher.Form method="post" action={marketplacePath(slug, "requests")}>
      <input type="hidden" name="intent" value="install" />
      <input type="hidden" name="extension" value={manifest.id} />
      <SubmitButton fetcher={fetcher} className={cn(ACTION.primary, className)} pending="Installing…">
        <Plus size={14} />
        Install
      </SubmitButton>
    </fetcher.Form>
  );
}

/** An extension as a card: its mark, publisher and tier, what it does, and where its data goes. */
export function ExtensionCard({ listing, slug, owner }: { listing: ExtensionListing; slug: string; owner: boolean }) {
  const { manifest } = listing;
  return (
    <article className="relative flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start gap-3">
        <ExtensionMark manifest={manifest} />
        <div className="min-w-0 grow">
          <h3 className="truncate text-sm font-semibold">
            <Link to={extensionPath(slug, manifest.id)} prefetch="intent" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">
              {manifest.name}
            </Link>
          </h3>
          <p className="truncate text-xs text-muted">
            {manifest.publisher.name} · {manifest.category}
          </p>
        </div>
        <span className="relative">
          <TierBadge tier={manifest.publisher.tier} />
        </span>
      </div>
      <p className="mt-3 line-clamp-2 grow text-[0.8125rem] leading-snug text-muted">{manifest.tagline}</p>
      <div className="relative mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="min-w-0 truncate text-xs text-faint">{manifest.domains.length === 0 ? "Data stays in g1t" : `Data goes to ${manifest.domains[0]}`}</span>
        <ExtensionAction listing={listing} slug={slug} owner={owner} />
      </div>
    </article>
  );
}

/** A request's status, in a word. */
export function RequestStatus({ request }: { request: InstallRequest }) {
  if (request.status === "open") return <Badge tone="warn">Waiting</Badge>;
  if (request.status === "done") return <Badge tone="success">Added</Badge>;
  return <Badge tone="neutral">Turned down</Badge>;
}

/**
 * One request as a row: what was asked for, by whom, why and when; for an
 * owner, while it waits, the way to add it, mark it added, or turn it down.
 */
export function RequestRow({ request, slug, owner, addTo }: { request: InstallRequest; slug: string; owner: boolean; addTo: string | null }) {
  const fetcher = useFetcher<{ error: string | null }>();
  const action = marketplacePath(slug, "requests");
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{request.name}</span>
          <span className="text-xs text-faint">{request.kind === "agent" ? "Agent" : request.kind === "extension" ? "Extension" : "Integration"}</span>
          <RequestStatus request={request} />
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {owner ? `@${request.requested_by} asked ` : "You asked "}
          <TimeAgo at={request.requested_at} />
          {request.resolved_by && request.status !== "open" && (
            <>
              {" · "}
              {request.status === "done" ? "added" : "turned down"} by @{request.resolved_by}
            </>
          )}
        </p>
        {request.note && <p className="mt-1.5 max-w-xl rounded-md border-l-2 border-line-strong pl-2.5 text-[0.8125rem] text-fg-soft">{request.note}</p>}
        {fetcher.data?.error && (
          <div className="mt-2">
            <ErrorText>{fetcher.data.error}</ErrorText>
          </div>
        )}
      </div>
      {owner && request.status === "open" && (
        <fetcher.Form method="post" action={action} className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <input type="hidden" name="intent" value="resolve" />
          <input type="hidden" name="id" value={request.id} />
          {addTo && (
            <Link to={addTo} className={ACTION.primary}>
              <Plus size={14} />
              {request.kind === "agent" ? "Add" : request.kind === "extension" ? "Install" : "Connect"}
            </Link>
          )}
          <SubmitButton fetcher={fetcher} name="status" value="done" className={ACTION.quiet} pending="Saving…">
            <Check size={14} />
            Mark added
          </SubmitButton>
          <SubmitButton fetcher={fetcher} name="status" value="declined" className={ACTION.quiet} pending="Saving…">
            <X size={14} />
            Turn down
          </SubmitButton>
        </fetcher.Form>
      )}
    </li>
  );
}
