/**
 * Customize's pieces (routes/workspace/customize/): the card every listing
 * shares, the badges that say whether something can be added or is
 * connected, the Available-to control that says which agents something
 * reaches, the Request button members ask owners with, a request as owners
 * and askers see it, filter menus, and section headings.
 */
import { Check, ChevronDown, Clock, Info, Plus, Send, Users, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { ConnectorState, InstallRequest, PluginAvailability } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { useDialogFetcher } from "./agents/dialogs";
import { ConnectorMark } from "./connectors";
import { ButtonLink, ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Badge, type BadgeTone } from "./ui/badge";
import { Button, buttonVariants } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { cn } from "../lib/cn";
import { CONNECTOR_STATES, type Reach, type ReachOption, type ReachTargets, availabilityWord, kindWord, reachOptions, reachWords } from "../lib/customize";

/** A listing's mark: its letters on a steady colour, from its id and name. */
export function ListingMark({ id, name, size = 40 }: { id: string; name: string; size?: number }) {
  return <ConnectorMark view={{ id, name, provider: null }} size={size} />;
}

/**
 * The card every listing shares: its mark, its name (a link over the whole
 * card when it has a page), one line about it, what sits under it
 * (`children`), and a last line with where it is from (`meta`) and what
 * can be done with it (`action`). `muted` draws one nobody can add yet.
 */
export function ListingCard({
  mark,
  title,
  to,
  description,
  badge,
  meta,
  action,
  muted = false,
  children,
}: {
  mark: ReactNode;
  title: ReactNode;
  to?: string;
  description: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card asChild className={cn("relative flex flex-col gap-3 p-4 transition-colors", muted ? "border-dashed bg-transparent" : "hover:border-line-strong")}>
      <article>
        <div className="flex items-start gap-3">
          <span className={cn("shrink-0", muted && "opacity-60 grayscale")}>{mark}</span>
          <div className="min-w-0 grow">
            <div className="flex items-start justify-between gap-2">
              <h3 className={cn("min-w-0 truncate text-sm font-semibold", muted && "text-fg-soft")}>
                {to ? (
                  <Link to={to} prefetch="intent" className="outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-accent">
                    {title}
                  </Link>
                ) : (
                  title
                )}
              </h3>
              {badge && <span className="relative z-10 flex shrink-0 items-center gap-1.5">{badge}</span>}
            </div>
            <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{description}</p>
          </div>
        </div>
        {children && <div className="relative z-10">{children}</div>}
        <div className="relative z-10 mt-auto flex min-h-8 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs text-muted">{meta}</p>
          {action && <span className="flex shrink-0 items-center gap-2">{action}</span>}
        </div>
      </article>
    </Card>
  );
}

/** Small chips under a card: what a plugin brings, a connector's tools. */
export function Chips({ items, muted = false, label }: { items: readonly string[]; muted?: boolean; label?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={label}>
      {items.map((item) => (
        <li key={item} className={cn("rounded-full px-2 py-px text-[0.6875rem]", muted ? "border border-dashed border-line text-faint" : "bg-raised text-muted")}>
          {item}
        </li>
      ))}
    </ul>
  );
}

/** A section's heading, with a count or a link at its end, and a line under it. */
export function SectionHead({ id, title, aside, children }: { id: string; title: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="flex items-center gap-2 text-base font-semibold tracking-tight">
          {title}
        </h2>
        {aside && <div className="shrink-0 text-xs text-muted">{aside}</div>}
      </div>
      {children && <p className="mt-1 max-w-2xl text-sm text-muted">{children}</p>}
    </div>
  );
}

/** The grid listings sit in. */
export function ListingGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

/** Discover's banner: what is open to add here, in a wash of the accent. */
export function FeaturedBanner({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card asChild className="relative overflow-hidden p-5 sm:p-6">
      <section aria-label="Featured">
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_120%_at_100%_0%,var(--color-accent)_0%,transparent_55%)] opacity-[0.12]" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <p className="mt-1 text-sm text-muted">{children}</p>
          </div>
          {action}
        </div>
      </section>
    </Card>
  );
}

/** A plugin's or a skill's availability as a badge, with why it isn't available here on hover. */
export function AvailabilityBadge({ availability }: { availability: PluginAvailability }) {
  const { label, tone } = availabilityWord(availability);
  const hint =
    availability.kind === "unavailable"
      ? availability.why
      : availability.kind === "soon"
        ? "g1t's own, announced and not released yet. Nobody can install it until it is."
        : availability.kind === "installed" && !availability.enabled
          ? "Installed and switched off: its skills, agents and connectors are kept but reach no agent until an owner switches it on."
          : null;
  const badge = <Badge tone={tone}>{label}</Badge>;
  if (!hint) return badge;
  return (
    <Hint label={hint}>
      <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {badge}
      </span>
    </Hint>
  );
}

/** A connector's state as a badge: Connected, Needs sign-in, Needs a key, or Problem with what is wrong on hover. */
export function StateBadge({ state, problem }: { state: ConnectorState; problem?: string | null }) {
  const { label, tone } = CONNECTOR_STATES[state];
  const badge = <Badge tone={tone}>{label}</Badge>;
  if (!problem) return badge;
  return (
    <Hint label={problem}>
      <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        {badge}
      </span>
    </Hint>
  );
}

/** Something to know before connecting: an information mark with the words on hover. */
export function Caveat({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <Hint label={text}>
      <span tabIndex={0} aria-label="Something to know" className="inline-flex rounded-full text-warn outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
        <Info size={14} />
      </span>
    </Hint>
  );
}

/**
 * A menu that picks one of `options` (a category, a marketplace, a sort),
 * as a quiet button naming the choice; `all` is the word for none.
 */
export function FilterMenu({ label, all, value, options, onChange }: { label: string; all: string; value: string | null; options: readonly { value: string; label: string }[]; onChange: (value: string | null) => void }) {
  const chosen = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={chosen ? "soft" : "outline"} size="sm" aria-label={`${label}: ${chosen?.label ?? all}`}>
          <span className="text-muted">{label}</span>
          <span className="max-w-40 truncate">{chosen?.label ?? all}</span>
          <ChevronDown size={13} className="text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={(next) => onChange(next || null)}>
          <DropdownMenuRadioItem value="">{all}</DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where something reaches, and the control that changes it: a menu of
 * every agent, each team and each agent, checked where it already reaches.
 * Checking gives it there; unchecking takes it back. Without `targets`
 * (someone who may not change it) the line alone shows.
 */
export function AvailableTo({
  reach,
  targets,
  busy = false,
  onChange,
  size = "xs",
}: {
  reach: readonly Reach[];
  targets: ReachTargets | null;
  busy?: boolean;
  /** Give it where `option` says (`checked`), or take it back from there (`option.reach`). */
  onChange?: (option: ReachOption, checked: boolean) => void;
  size?: "xs" | "sm";
}) {
  const words = reachWords(reach);
  const options = targets ? reachOptions(reach, targets) : [];
  if (!targets || !onChange || options.length === 0) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 text-muted", size === "xs" ? "text-xs" : "text-[0.8125rem]")}>
        <Users size={size === "xs" ? 12 : 13} className="shrink-0 text-faint" aria-hidden />
        <span className="truncate">{reach.length === 0 ? "Not available to any agent yet" : `Available to ${words}`}</span>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size={size} disabled={busy} className="max-w-full" aria-label={`Available to ${words}; change where it reaches`}>
          <Users size={size === "xs" ? 12 : 13} className="text-faint" />
          <span className="text-muted">Available to</span>
          <span className="truncate">{words}</span>
          <ChevronDown size={12} className="text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuLabel>Available to</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuCheckboxItem key={option.value} checked={option.checked} onCheckedChange={(checked) => onChange(option, checked === true)}>
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "3 waiting": open requests for a listing, for owners, leading to the requests page. */
export function Waiting({ slug, count }: { slug: string; count: number }) {
  if (count === 0) return null;
  return (
    <Link to={customizePath("requests", slug)} className="text-xs text-warn hover:underline">
      {count} {count === 1 ? "request" : "requests"}
    </Link>
  );
}

/**
 * Asking the workspace's owners to add something: a dialog that says what
 * is asked for, with an optional note, sent to the requests page. Once
 * sent, it says so.
 */
export function RequestButton({ slug, listing, name, requested, className, size = "sm" }: { slug: string; listing: string; name: string; requested: boolean; className?: string; size?: "xs" | "sm" }) {
  const fetcher = useFetcher<{ error: string | null }>({ key: `request:${listing}` });
  const [open, setOpen] = useState(false);
  const sent = fetcher.state === "idle" && fetcher.data?.error === null;
  useEffect(() => {
    if (sent) setOpen(false);
  }, [sent]);
  if (requested || sent) {
    return (
      <Hint label="The workspace's owners have your request. You'll hear when they answer.">
        <span tabIndex={0} className={cn(buttonVariants({ variant: "outline", size }), "text-muted hover:border-line hover:bg-transparent hover:text-muted", className)}>
          <Clock size={13} />
          Requested
        </span>
      </Hint>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size={size} className={className}>
          <Send size={13} />
          Request
        </Button>
      </DialogTrigger>
      <DialogContent>
        <fetcher.Form method="post" action={customizePath("requests", slug)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Ask to add {name}</DialogTitle>
            <DialogDescription>Only the workspace's owners add skills, connectors and plugins. Each of them is notified, and you hear back when one answers.</DialogDescription>
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

/** A request's status, in a word. */
export function RequestStatus({ request }: { request: InstallRequest }) {
  const tone: BadgeTone = request.status === "open" ? "warn" : request.status === "done" ? "success" : "neutral";
  return <Badge tone={tone}>{request.status === "open" ? "Waiting" : request.status === "done" ? "Added" : "Turned down"}</Badge>;
}

/**
 * One request as a row: what was asked for, by whom, why and when; for an
 * owner, while it waits, the way to add it, mark it added, or turn it down.
 */
export function RequestRow({ request, slug, owner, addTo }: { request: InstallRequest; slug: string; owner: boolean; addTo: string | null }) {
  const fetcher = useFetcher<{ error: string | null }>();
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5 sm:flex-nowrap">
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{request.name}</span>
          <span className="text-xs text-faint">{kindWord(request.kind)}</span>
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
        {request.note && <p className="mt-1.5 max-w-xl border-l-2 border-line-strong pl-2.5 text-[0.8125rem] text-fg-soft">{request.note}</p>}
        {fetcher.data?.error && (
          <div className="mt-2">
            <ErrorText>{fetcher.data.error}</ErrorText>
          </div>
        )}
      </div>
      {owner && request.status === "open" && (
        <fetcher.Form method="post" action={customizePath("requests", slug)} className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          <input type="hidden" name="intent" value="resolve" />
          <input type="hidden" name="id" value={request.id} />
          {addTo && (
            <ButtonLink to={addTo} size="sm">
              <Plus size={14} />
              {request.kind === "connector" || request.kind === "integration" ? "Connect" : request.kind === "skill" ? "Add" : "Install"}
            </ButtonLink>
          )}
          <SubmitButton fetcher={fetcher} name="status" value="done" variant="outline" size="sm" pending="Saving…">
            <Check size={14} />
            Mark added
          </SubmitButton>
          <SubmitButton fetcher={fetcher} name="status" value="declined" variant="outline" size="sm" pending="Saving…">
            <X size={14} />
            Turn down
          </SubmitButton>
        </fetcher.Form>
      )}
    </li>
  );
}

/**
 * Owners add a marketplace by address: `owner/repo` on GitHub or a
 * repository here, a git address, or a link to its marketplace.json. Posted
 * to the Marketplaces page, from wherever the dialog opens.
 */
export function AddMarketplaceDialog({ slug, dialog }: { slug: string; dialog: ReturnType<typeof useDialogFetcher> }) {
  const { fetcher, open, setOpen, error, busy } = dialog;
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a marketplace</DialogTitle>
          <DialogDescription>
            A repository with <code className="font-mono text-xs">.claude-plugin/marketplace.json</code>: on GitHub as owner/repo, a repository here as workspace/name, a git address, or a link to the file itself. Its plugins
            show in Discover, in the formats Claude Code reads.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={customizePath("marketplaces", slug)} className="grid gap-5">
          <input type="hidden" name="intent" value="add" />
          <Field>
            <FieldLabel htmlFor={`${id}-address`}>Address</FieldLabel>
            <Input id={`${id}-address`} name="address" placeholder="anthropics/claude-plugins-official" required autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>
              Name <span className="font-normal text-faint">(optional)</span>
            </FieldLabel>
            <Input id={`${id}-name`} name="name" placeholder="As its manifest names it" autoComplete="off" spellCheck={false} />
            <FieldDescription>Plugins are named plugin@marketplace, so a name you choose is the one your people see.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton variant="accent" fetcher={fetcher} match={{ intent: "add" }} busy={busy} pending="Reading it…">
              Add marketplace
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** What a page says it can't show: the agents service didn't answer. */
export function NoAnswer({ what }: { what: string }) {
  return (
    <Card asChild tone="plain" className="border-dashed px-4 py-8 text-center text-sm text-muted">
      <p>{what} can't be shown right now. The agents service didn't answer; reload in a minute.</p>
    </Card>
  );
}
