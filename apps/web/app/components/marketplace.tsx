/**
 * The Marketplace's pieces (routes/workspace/marketplace/): listings for
 * extensions and integrations, each with who stands behind it (its tier)
 * and whether it can be added here (its availability), the button that
 * adds one (owners) or asks an owner to (everyone else), the filters and
 * the legend for both, starter kits, and a request as owners and askers
 * see it.
 */
import { ArrowRight, Ban, Check, CircleAlert, Clock, Plus, Power, Send, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useFetcher, useLocation, useSearchParams } from "react-router";

import type { ExtensionManifest, InstallRequest, ListingKind, ListingTier } from "@g1t/contracts";
import { LISTING_TIERS } from "@g1t/contracts/marketplace";

import { ConnectorMark } from "./connectors";
import { Badge } from "./ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Hint } from "./ui/hint";
import { ErrorText, SubmitButton, Textarea, TimeAgo } from "./ui";
import {
  AVAILABILITIES,
  AVAILABILITY,
  type Availability,
  type ExtensionListing,
  type IntegrationListing,
  type ListingFilters,
  type StarterKit,
  TIERS,
  addedWord,
  extensionPath,
  marketplacePath,
} from "../lib/marketplace";
import { cn } from "../lib/cn";

const SMALL = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[0.8125rem] font-medium transition-colors";
export const ACTION = {
  primary: `${SMALL} bg-fg text-bg hover:bg-fg-hover`,
  quiet: `${SMALL} border border-line text-fg/85 hover:border-line-strong hover:bg-raised hover:text-fg`,
};

/** Each tier's colour: Official the accent, Verified green, Community amber, Internal blue. */
const TIER_TONE: Record<ListingTier, string> = {
  official: "bg-accent/12 text-accent",
  verified: "bg-success/12 text-success",
  community: "bg-warn/12 text-warn",
  internal: "bg-info/12 text-info",
};

/**
 * Who stands behind a listing: a small square badge in its tier's colour,
 * with the sentence on hover or focus. Inside a link, `focusable={false}`
 * keeps it from being a second stop for the keyboard.
 */
export function TierBadge({ tier, focusable = true, className }: { tier: ListingTier; focusable?: boolean; className?: string }) {
  return (
    <Hint label={`${TIERS[tier].label}: ${TIERS[tier].about}`}>
      <span
        tabIndex={focusable ? 0 : undefined}
        className={cn(
          "inline-flex shrink-0 items-center rounded-[5px] px-1.5 py-px font-mono text-[0.625rem] leading-4 font-medium tracking-[0.08em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-accent",
          TIER_TONE[tier],
          className,
        )}
      >
        {TIERS[tier].label}
      </span>
    </Hint>
  );
}

/**
 * Whether a listing can be added here: Available, Connected or Installed,
 * Soon, or Not available here, as an icon and a word (never a button),
 * with what it means, or why, on hover or focus.
 */
export function AvailabilityBadge({
  availability,
  kind,
  why,
  off = false,
  hint,
  focusable = true,
  className,
}: {
  availability: Availability;
  kind: ListingKind;
  /** Why it isn't available here. */
  why?: string | null;
  /** An installed extension that was switched off. */
  off?: boolean;
  /** A hint in place of the usual sentence. */
  hint?: string;
  /** False inside a link, so it isn't a second stop for the keyboard. */
  focusable?: boolean;
  className?: string;
}) {
  const label = availability === "added" ? (off ? "Switched off" : addedWord(kind)) : AVAILABILITY[availability].label;
  const about =
    hint ??
    (availability === "unavailable" && why
      ? why
      : availability === "added"
        ? off
          ? "Installed, and switched off: its token doesn't work and its page doesn't load until an owner switches it on."
          : `This workspace has it ${kind === "integration" ? "connected" : "installed"}.`
        : AVAILABILITY[availability].about);
  const icon =
    availability === "available" ? (
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-success" />
    ) : availability === "added" ? (
      off ? (
        <Power size={12} className="shrink-0" />
      ) : (
        <Check size={13} className="shrink-0" />
      )
    ) : availability === "soon" ? (
      <Clock size={12} className="shrink-0" />
    ) : (
      <Ban size={12} className="shrink-0" />
    );
  return (
    <Hint label={about}>
      <span
        tabIndex={focusable ? 0 : undefined}
        className={cn(
          "inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded text-xs whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-accent",
          availability === "available" ? "text-fg-soft" : availability === "added" ? (off ? "text-warn" : "text-success") : "text-muted",
          className,
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </Hint>
  );
}

/** "Soon", on what is planned and not built. */
export function ComingBadge() {
  return <AvailabilityBadge availability="soon" kind="extension" />;
}

/**
 * What the labels mean: who builds what (the four tiers) and whether a
 * listing can be added here. On Discover, and at the end of each tab.
 */
export function ListingLegend({ id = "legend", kind }: { id?: string; kind?: ListingKind }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
      <h2 id={id} className="text-base font-semibold tracking-tight">
        Who builds what
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">Every listing says who stands behind it, and whether it can be added here. Today, everything listed is g1t's own.</p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LISTING_TIERS.map((tier) => (
          <li key={tier} className="rounded-xl border border-line bg-bg p-4">
            <TierBadge tier={tier} />
            <p className="mt-2.5 text-[0.8125rem] leading-snug text-muted">{TIERS[tier].about}</p>
          </li>
        ))}
      </ul>
      <h3 className="mt-6 text-sm font-semibold">Whether you can add it</h3>
      <ul className="mt-3 grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {AVAILABILITIES.map((availability) => (
          <li key={availability} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.8125rem] text-muted">
            <span className="w-36 shrink-0">
              <AvailabilityBadge availability={availability} kind={kind ?? "integration"} />
            </span>
            <span className="min-w-0 basis-56 grow">
              {availability === "added"
                ? kind === "extension"
                  ? "Installed in this workspace."
                  : kind === "integration"
                    ? "Connected for this workspace."
                    : "Connected or installed in this workspace."
                : availability === "unavailable"
                  ? "This workspace or this g1t lacks something it needs, and the listing says what."
                  : AVAILABILITY[availability].about}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A tier's section while nothing in it is listed: said plainly, so the structure shows. */
export function TierEmpty({ tier, kind, filtered = false }: { tier: ListingTier; kind: ListingKind; filtered?: boolean }) {
  return (
    <p className="rounded-xl border border-dashed border-line px-4 py-4 text-sm text-muted">
      <span>{filtered && tier === "official" ? TIERS.official.none[kind] : filtered ? `None match. ${TIERS[tier].none[kind]}` : TIERS[tier].none[kind]}</span>
    </p>
  );
}

/**
 * Filters by tier and by availability, kept in the address
 * (`?tier=verified&availability=soon`) so a filtered page can be shared.
 * Each option shows how many listings it has before filtering.
 */
export function ListingFilterBar({
  kind,
  filters,
  counts,
}: {
  kind: ListingKind;
  filters: ListingFilters;
  counts: { tier: Record<ListingTier, number>; availability: Record<Availability, number>; all: number };
}) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const href = (key: "tier" | "availability", value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const Option = ({ group, value, current, count, children }: { group: "tier" | "availability"; value: string; current: string; count: number; children: ReactNode }) => (
    <Link
      to={href(group, value)}
      replace
      preventScrollReset
      aria-current={current === value ? "true" : undefined}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent",
        current === value ? "border-line-strong bg-raised font-medium text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg",
      )}
    >
      {children}
      <span className={cn("tabular-nums", current === value ? "text-muted" : "text-faint")}>{count}</span>
    </Link>
  );
  return (
    <div className="grid gap-2.5" role="group" aria-label={`Filter ${kind === "extension" ? "extensions" : "integrations"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-24 shrink-0 text-xs text-faint max-sm:w-full">Who builds it</span>
        <Option group="tier" value="all" current={filters.tier} count={counts.all}>
          All
        </Option>
        {LISTING_TIERS.map((tier) => (
          <Option key={tier} group="tier" value={tier} current={filters.tier} count={counts.tier[tier]}>
            <span aria-hidden="true" className={cn("size-1.5 rounded-full", TIER_DOT[tier])} />
            {TIERS[tier].label}
          </Option>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-24 shrink-0 text-xs text-faint max-sm:w-full">Availability</span>
        <Option group="availability" value="all" current={filters.availability} count={counts.all}>
          All
        </Option>
        {AVAILABILITIES.map((availability) => (
          <Option key={availability} group="availability" value={availability} current={filters.availability} count={counts.availability[availability]}>
            {availability === "added" ? addedWord(kind) : AVAILABILITY[availability].label}
          </Option>
        ))}
      </div>
    </div>
  );
}

const TIER_DOT: Record<ListingTier, string> = { official: "bg-accent", verified: "bg-success", community: "bg-warn", internal: "bg-info" };

/** How many listings each filter option has. */
export function filterCounts(listings: { tier: ListingTier; availability: Availability }[]) {
  const tier = Object.fromEntries(LISTING_TIERS.map((t) => [t, listings.filter((l) => l.tier === t).length])) as Record<ListingTier, number>;
  const availability = Object.fromEntries(AVAILABILITIES.map((a) => [a, listings.filter((l) => l.availability === a).length])) as Record<Availability, number>;
  return { tier, availability, all: listings.length };
}

/**
 * A listing page's header line: its tier, who publishes it, whether it can
 * be added here (`children`), and its category, each labelled.
 */
export function ListingFacts({ tier, publisher, category, children }: { tier: ListingTier; publisher: string; category: string; children: ReactNode }) {
  const Dot = () => (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm text-muted">
      <TierBadge tier={tier} />
      <span>
        by <span className="text-fg-soft">{publisher}</span>
      </span>
      <span className="inline-flex items-center gap-2.5">
        <Dot />
        {children}
      </span>
      <span className="inline-flex items-center gap-2.5">
        <Dot />
        {category}
      </span>
    </p>
  );
}

/** A section's heading, with a count or a link at its end. */
export function SectionHead({ id, title, aside, sub = false, children }: { id: string; title: ReactNode; aside?: ReactNode; sub?: boolean; children?: ReactNode }) {
  const Heading = sub ? "h3" : "h2";
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3">
        <Heading id={id} className={cn("flex items-center gap-2 font-semibold tracking-tight", sub ? "text-sm" : "text-base")}>
          {title}
        </Heading>
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

/** What a request's dialog shows of the listing asked for: its mark, tier, publisher and availability. */
export type RequestedListing = { kind: ListingKind; tier: ListingTier; publisher: string; mark: ReactNode };

/**
 * Asking the workspace's owners to add something: a dialog that says
 * exactly what is asked for (who builds it, and that it can be added),
 * with an optional note, sent to the requests route. Once sent, it says so.
 */
export function RequestButton({
  slug,
  listing,
  name,
  requested,
  about,
  className,
}: {
  slug: string;
  listing: string;
  name: string;
  requested: boolean;
  about?: RequestedListing;
  className?: string;
}) {
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
            <DialogDescription>Only the workspace's owners add extensions and integrations. Each of them is notified, and you hear back when one answers.</DialogDescription>
          </DialogHeader>
          {about && (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2.5">
              {about.mark}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <TierBadge tier={about.tier} />
                  <span>by {about.publisher}</span>
                  <span aria-hidden="true" className="text-faint">
                    ·
                  </span>
                  <AvailabilityBadge availability="available" kind={about.kind} hint="An owner can add it as soon as they agree." />
                </p>
              </div>
            </div>
          )}
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

/**
 * What an owner or a member can do with an integration: connect it, ask
 * for it, or manage it once connected; nothing while it is Soon or not
 * available here, where the availability says why instead.
 */
export function IntegrationAction({ listing, slug, owner, className }: { listing: IntegrationListing; slug: string; owner: boolean; className?: string }) {
  if (listing.availability === "soon" || listing.availability === "unavailable") return null;
  if (listing.scope === "personal") {
    return listing.href ? (
      <Link to={listing.href} className={cn(ACTION.quiet, className)}>
        Connect yours
      </Link>
    ) : null;
  }
  if (listing.connected) {
    return listing.href ? (
      <Link to={listing.href} className={cn(ACTION.quiet, className)}>
        Manage
      </Link>
    ) : null;
  }
  if (owner) {
    return listing.href ? (
      <Link to={listing.href} className={cn(ACTION.primary, className)}>
        <Plus size={14} />
        Connect
      </Link>
    ) : null;
  }
  return (
    <RequestButton
      slug={slug}
      listing={listing.ref}
      name={listing.view.name}
      requested={listing.requested}
      about={{ kind: "integration", tier: listing.tier, publisher: listing.publisher, mark: <ConnectorMark view={listing.view} size={32} /> }}
      className={className}
    />
  );
}

/** Whether a listing can't be added by anyone here: drawn muted and dashed, with nothing to press. */
function inert(availability: Availability): boolean {
  return availability === "soon" || availability === "unavailable";
}

/** The card every listing shares: a link to its page over the whole card, with its badges and actions above it. */
function ListingShell({ to, name, muted, children }: { to: string; name: string; muted: boolean; children: ReactNode }) {
  return (
    <article
      className={cn(
        "relative flex flex-col rounded-xl border p-4 transition-colors",
        muted ? "border-dashed border-line-strong/70 bg-transparent hover:border-line-strong" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <Link to={to} prefetch="intent" aria-label={name} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      {children}
    </article>
  );
}

/**
 * An integration as a card: its mark, who builds it, what it does for
 * agents, whether the workspace can add it or has it, and the way to.
 */
export function IntegrationCard({ listing, slug, owner }: { listing: IntegrationListing; slug: string; owner: boolean }) {
  const { view, connected } = listing;
  const muted = inert(listing.availability);
  return (
    <ListingShell to={listing.path} name={view.name} muted={muted}>
      <div className="flex items-start gap-3">
        <span className={cn("shrink-0", muted && "opacity-60 grayscale")}>
          <ConnectorMark view={view} size={40} />
        </span>
        <div className="min-w-0 grow">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h3 className={cn("truncate text-sm font-semibold", muted && "text-fg-soft")}>{view.name}</h3>
            <span className="relative shrink-0">
              <TierBadge tier={listing.tier} />
            </span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{view.description}</p>
        </div>
      </div>
      {view.capabilities.length > 0 && (
        <ul className="mt-3 flex grow flex-wrap content-start gap-1.5" aria-label={muted ? "What it will do" : "What it does"}>
          {view.capabilities.map((capability) => (
            <li key={capability} className={cn("rounded-full px-2 py-px text-[0.6875rem]", muted ? "border border-dashed border-line text-faint" : "bg-raised text-muted")}>
              {capability}
            </li>
          ))}
        </ul>
      )}
      <div className="relative mt-4 flex min-h-8 items-center justify-between gap-3 border-t border-line pt-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          {connected?.problem ? (
            <Hint label={connected.problem}>
              <span tabIndex={0} className="inline-flex min-w-0 items-center gap-1 text-warn outline-none focus-visible:ring-2 focus-visible:ring-accent">
                <CircleAlert size={13} className="shrink-0" />
                <span className="truncate">Needs attention</span>
              </span>
            </Hint>
          ) : (
            <AvailabilityBadge
              availability={listing.availability}
              kind="integration"
              why={listing.why}
              hint={
                listing.scope === "personal" && listing.availability === "available"
                  ? "Each person connects their own. Agents use it only when that person asks."
                  : listing.availability === "available" && !owner
                    ? "An owner connects it for everyone. Ask one with Request."
                    : undefined
              }
            />
          )}
          {listing.scope === "personal" && <span className="truncate text-faint">· Each person's own</span>}
          {owner && listing.waiting > 0 && (
            <>
              <span className="text-faint">·</span>
              <Waiting slug={slug} count={listing.waiting} />
            </>
          )}
        </span>
        <IntegrationAction listing={listing} slug={slug} owner={owner} />
      </div>
    </ListingShell>
  );
}

/**
 * An integration as a compact row, for the long list of coming ones:
 * muted and dashed, its tier and Soon, and nothing to press but its page.
 */
export function IntegrationRow({ listing }: { listing: IntegrationListing }) {
  const { view } = listing;
  return (
    <li className="relative flex items-center gap-3 rounded-lg border border-dashed border-line-strong/70 px-3 py-2.5 transition-colors hover:border-line-strong">
      <Link to={listing.path} prefetch="intent" aria-label={view.name} className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent" />
      <span className="shrink-0 opacity-60 grayscale">
        <ConnectorMark view={view} size={28} />
      </span>
      <span className="min-w-0 grow">
        <span className="block truncate text-sm text-fg-soft">{view.name}</span>
        <span className="block truncate text-xs text-faint">{view.description}</span>
      </span>
      <span className="relative flex shrink-0 flex-col items-end gap-1">
        <TierBadge tier={listing.tier} />
        <AvailabilityBadge availability={listing.availability} kind="integration" why={listing.why} />
      </span>
    </li>
  );
}

/** An extension's mark: its initials on a steady colour, until listings bring their own icon. */
export function ExtensionMark({ manifest, size = 40 }: { manifest: Pick<ExtensionManifest, "id" | "name">; size?: number }) {
  return <ConnectorMark view={{ id: manifest.id, name: manifest.name, provider: null }} size={size} />;
}

/** What an owner or a member can do with an extension: install or ask, once it is published; nothing before, or once installed. */
export function ExtensionAction({ listing, slug, owner, className }: { listing: ExtensionListing; slug: string; owner: boolean; className?: string }) {
  const fetcher = useFetcher<{ error: string | null }>();
  const { manifest } = listing;
  if (listing.availability !== "available") return null;
  if (!owner) {
    return (
      <RequestButton
        slug={slug}
        listing={listing.ref}
        name={manifest.name}
        requested={listing.requested}
        about={{ kind: "extension", tier: listing.tier, publisher: manifest.publisher.name, mark: <ExtensionMark manifest={manifest} size={32} /> }}
        className={className}
      />
    );
  }
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

/** An extension's availability, as its card and page show it. */
export function ExtensionAvailability({ listing, owner }: { listing: ExtensionListing; owner: boolean }) {
  return (
    <AvailabilityBadge
      availability={listing.availability}
      kind="extension"
      off={listing.install ? !listing.install.enabled : false}
      hint={
        listing.availability === "soon"
          ? "Not published yet. It can be installed from its first release."
          : listing.availability === "available" && !owner
            ? "An owner installs it for everyone. Ask one with Request."
            : listing.install?.enabled
              ? `Version ${listing.install.version} is installed.`
              : undefined
      }
    />
  );
}

/** Where an extension's data goes, in a few words for a card. */
function dataLine(manifest: Pick<ExtensionManifest, "domains" | "bridges">): string {
  // "the CRM you connect" reads, on a card, as "Works with your CRM".
  if (manifest.bridges) return `Works with ${manifest.bridges.replace(/^the (.+) you connect$/, "your $1")}`;
  return manifest.domains.length === 0 ? "Data stays in g1t" : `Data goes to ${manifest.domains[0]}`;
}

/** An extension as a card: its mark, publisher and tier, what it does, where its data goes, and whether it can be added. */
export function ExtensionCard({ listing, slug, owner }: { listing: ExtensionListing; slug: string; owner: boolean }) {
  const { manifest } = listing;
  const muted = inert(listing.availability);
  return (
    <ListingShell to={extensionPath(slug, manifest.id)} name={manifest.name} muted={muted}>
      <div className="flex items-start gap-3">
        <span className={cn("shrink-0", muted && "opacity-60 grayscale")}>
          <ExtensionMark manifest={manifest} />
        </span>
        <div className="min-w-0 grow">
          <h3 className={cn("truncate text-sm font-semibold", muted && "text-fg-soft")}>{manifest.name}</h3>
          <p className="truncate text-xs text-muted">
            by {manifest.publisher.name} · {manifest.category}
          </p>
        </div>
        <span className="relative shrink-0">
          <TierBadge tier={listing.tier} />
        </span>
      </div>
      <p className="mt-3 line-clamp-2 grow text-[0.8125rem] leading-snug text-muted">{manifest.tagline}</p>
      <p className="mt-2 truncate text-xs text-faint">{dataLine(manifest)}</p>
      <div className="relative mt-3 flex min-h-8 items-center justify-between gap-3 border-t border-line pt-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <ExtensionAvailability listing={listing} owner={owner} />
          {owner && listing.waiting > 0 && (
            <>
              <span className="text-faint">·</span>
              <Waiting slug={slug} count={listing.waiting} />
            </>
          )}
        </span>
        <ExtensionAction listing={listing} slug={slug} owner={owner} />
      </div>
    </ListingShell>
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
          <span className="text-xs text-faint">{request.kind === "extension" ? "Extension" : "Integration"}</span>
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
              {request.kind === "extension" ? "Install" : "Connect"}
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

/**
 * A starter kit as a card: the extensions it brings, overlapped, its name
 * and what it is for, who builds them, and whether it can be added.
 * Installed together once every one is published; until then it is Soon,
 * drawn muted with nothing to press.
 */
export function StarterKitCard({ kit, extensions, slug }: { kit: StarterKit; extensions: ExtensionManifest[]; slug: string }) {
  const ready = extensions.length > 0 && extensions.every((extension) => extension.status === "available");
  const tiers = [...new Set(extensions.map((extension) => extension.publisher.tier))];
  return (
    <article className={cn("flex flex-col rounded-xl border p-4", ready ? "border-line bg-surface" : "border-dashed border-line-strong/70")}>
      <div className="flex items-center justify-between gap-3">
        <div className={cn("flex items-center", !ready && "opacity-60 grayscale")}>
          {extensions.map((extension, index) => (
            <span key={extension.id} className={cn("rounded-[0.6rem] ring-2 ring-bg", index > 0 && "-ml-2")}>
              <ExtensionMark manifest={extension} size={30} />
            </span>
          ))}
        </div>
        <span className="flex gap-1">
          {tiers.map((tier) => (
            <TierBadge key={tier} tier={tier} />
          ))}
        </span>
      </div>
      <h3 className={cn("mt-3 text-sm font-semibold", !ready && "text-fg-soft")}>{kit.name}</h3>
      <p className="mt-0.5 grow text-[0.8125rem] leading-snug text-muted">{kit.about}</p>
      <p className="mt-2 truncate text-xs text-faint">
        {extensions.map((extension, index) => (
          <span key={extension.id}>
            {index > 0 && ", "}
            <Link to={extensionPath(slug, extension.id)} className="hover:text-fg hover:underline">
              {extension.name}
            </Link>
          </span>
        ))}
      </p>
      <div className="mt-3 flex min-h-8 items-center border-t border-line pt-3">
        <AvailabilityBadge
          availability={ready ? "available" : "soon"}
          kind="extension"
          hint={ready ? undefined : "Its extensions aren't all published yet. The kit installs them together once they are."}
        />
      </div>
    </article>
  );
}
