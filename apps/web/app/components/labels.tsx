import { Check, ChevronDown, Milestone as MilestoneIcon, Plus, Settings2, Tag, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useNavigate } from "react-router";

import type { Label as RepoLabel, Milestone, MilestoneRef } from "@g1t/contracts";

import { chipStyle, matchLabels, percentDone, tidyColor, tidyLabelName } from "../lib/labels";
import { cn } from "../lib/cn";
import { ErrorText } from "./ui";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/** A label as a colored chip. Without a known color it is neutral. */
export function LabelChip({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  const tinted = tidyColor(color) != null;
  return (
    <span
      style={chipStyle(color)}
      className={cn(
        "inline-flex max-w-full shrink-0 items-center truncate rounded-full border px-2 py-px text-xs font-medium",
        !tinted && "border-line text-muted",
        className,
      )}
    >
      {name}
    </span>
  );
}

/** A swatch of a label's color, for lists and pickers. */
export function Swatch({ color }: { color?: string | null }) {
  const hex = tidyColor(color);
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3 shrink-0 rounded-full border border-line-strong"
      style={hex ? { backgroundColor: `#${hex}`, borderColor: `color-mix(in oklab, #${hex} 70%, var(--color-fg))` } : undefined}
    />
  );
}

/** How far along a milestone is, as a bar. */
export function MilestoneBar({ milestone, className }: { milestone: Milestone; className?: string }) {
  const percent = percentDone(milestone);
  return (
    <span
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={`${percent}% complete`}
      className={cn("block h-2 overflow-hidden rounded-full bg-line", className)}
    >
      <span className="block h-full rounded-full bg-success transition-[width]" style={{ width: `${percent}%` }} />
    </span>
  );
}

/**
 * The sidebar's Labels: the item's chips, and for someone who may change
 * them, a menu to tick labels on and off, find one, or make one. It saves
 * when the menu closes, posting `action=labels` with each `label`.
 */
export function LabelsBox({
  labels,
  chosen,
  canEdit,
  canCreate,
  manageUrl,
}: {
  labels: RepoLabel[];
  chosen: string[];
  canEdit: boolean;
  canCreate: boolean;
  /** The labels page, for someone who may manage them. */
  manageUrl?: string;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(chosen);
  const [query, setQuery] = useState("");
  // What the page says now, once a save has come back.
  useEffect(() => {
    if (!open) setPicked(chosen);
  }, [chosen, open]);
  const colors = useMemo(() => new Map(labels.map((label) => [label.name, label.color])), [labels]);
  const typed = tidyLabelName(query);
  const offerNew = canCreate && typed !== "" && !labels.some((label) => label.name === typed) && !picked.includes(typed);
  const toggle = (name: string) =>
    setPicked((now) => (now.includes(name) ? now.filter((other) => other !== name) : [...now, name]));
  const save = (next: string[]) => {
    const same = next.length === chosen.length && next.every((name) => chosen.includes(name));
    if (same) return;
    const form = new FormData();
    form.set("action", "labels");
    for (const name of next) form.append("label", name);
    fetcher.submit(form, { method: "post" });
  };
  // While saving, show what was picked.
  const shown = fetcher.state !== "idle" ? picked : chosen;
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Labels</h3>
        {canEdit && (
          <Popover
            open={open}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) {
                setQuery("");
                save(picked);
              }
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Edit labels"
                className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
              >
                <Settings2 size={15} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <Command shouldFilter={false}>
                <CommandInput value={query} onValueChange={setQuery} placeholder="Find or make a label" />
                <CommandList>
                  {!offerNew && <CommandEmpty>No label matches.</CommandEmpty>}
                  <CommandGroup heading="Labels">
                    {matchLabels(labels, query).map((label) => (
                      <CommandItem key={label.name} value={label.name} onSelect={() => toggle(label.name)}>
                        <span className="flex size-4 items-center justify-center">
                          {picked.includes(label.name) && <Check className="text-accent" />}
                        </span>
                        <Swatch color={label.color} />
                        <span className="min-w-0 grow">
                          <span className="block truncate">{label.name}</span>
                          {label.description && (
                            <span className="block truncate text-xs text-faint">{label.description}</span>
                          )}
                        </span>
                      </CommandItem>
                    ))}
                    {picked
                      .filter((name) => !colors.has(name) && name.includes(typed))
                      .map((name) => (
                        <CommandItem key={name} value={`new:${name}`} onSelect={() => toggle(name)}>
                          <span className="flex size-4 items-center justify-center">
                            <Check className="text-accent" />
                          </span>
                          <Swatch />
                          <span className="grow truncate">{name}</span>
                          <span className="text-xs text-faint">new</span>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                  {offerNew && (
                    <CommandGroup heading="New label">
                      <CommandItem
                        value={`create:${typed}`}
                        onSelect={() => {
                          toggle(typed);
                          setQuery("");
                        }}
                      >
                        <Plus />
                        <span className="truncate">
                          Create <span className="font-medium">{typed}</span>
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
              {manageUrl && (
                <Link
                  to={manageUrl}
                  className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted hover:text-fg"
                >
                  <Tag size={13} />
                  Edit labels
                </Link>
              )}
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {shown.length === 0 ? (
          <span className="text-xs text-faint">None yet</span>
        ) : (
          shown.map((name) => <LabelChip key={name} name={name} color={colors.get(name)} />)
        )}
      </div>
      {fetcher.data?.error && (
        <div className="mt-2">
          <ErrorText>{fetcher.data.error}</ErrorText>
        </div>
      )}
    </section>
  );
}

/**
 * The sidebar's Milestone: the one the item is in, with its progress, and
 * for someone with the Triage role a menu to move it, posting
 * `action=milestone` with `milestone` (0 for none).
 */
export function MilestoneBox({
  milestones,
  current,
  canEdit,
  base,
}: {
  milestones: Milestone[];
  current: MilestoneRef | null | undefined;
  canEdit: boolean;
  /** The repository's address, for links to milestones. */
  base: string;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [open, setOpen] = useState(false);
  const choose = (number: number) => {
    setOpen(false);
    if (number === (current?.number ?? 0)) return;
    const form = new FormData();
    form.set("action", "milestone");
    form.set("milestone", String(number));
    fetcher.submit(form, { method: "post" });
  };
  const pending = fetcher.state !== "idle" ? Number(fetcher.formData?.get("milestone") ?? 0) : null;
  const shownNumber = pending ?? current?.number ?? 0;
  const shown = milestones.find((milestone) => milestone.number === shownNumber);
  const title = shown?.title ?? (shownNumber === current?.number ? current?.title : undefined);
  return (
    <section>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Milestone</h3>
        {canEdit && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Choose a milestone"
                className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
              >
                <Settings2 size={15} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <Command>
                <CommandInput placeholder="Find a milestone" />
                <CommandList>
                  <CommandEmpty>No milestone matches.</CommandEmpty>
                  {current && (
                    <CommandGroup>
                      <CommandItem value="none" onSelect={() => choose(0)}>
                        <X />
                        Clear milestone
                      </CommandItem>
                    </CommandGroup>
                  )}
                  <CommandGroup heading="Open">
                    {milestones
                      .filter((milestone) => milestone.state === "open")
                      .map((milestone) => (
                        <CommandItem
                          key={milestone.number}
                          value={`${milestone.title} ${milestone.number}`}
                          onSelect={() => choose(milestone.number)}
                        >
                          <span className="flex size-4 items-center justify-center">
                            {milestone.number === current?.number && <Check className="text-accent" />}
                          </span>
                          <span className="min-w-0 grow truncate">{milestone.title}</span>
                          {milestone.dueOn && <span className="text-xs text-faint">{milestone.dueOn}</span>}
                        </CommandItem>
                      ))}
                  </CommandGroup>
                </CommandList>
              </Command>
              <Link
                to={`${base}/milestones`}
                className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-muted hover:text-fg"
              >
                <MilestoneIcon size={13} />
                All milestones
              </Link>
            </PopoverContent>
          </Popover>
        )}
      </div>
      <div className="mt-2">
        {shownNumber && title ? (
          <Link to={`${base}/milestones/${shownNumber}`} className="group block">
            {shown && <MilestoneBar milestone={shown} className="mb-1.5" />}
            <span className="flex items-center gap-1.5 text-sm group-hover:text-accent">
              <MilestoneIcon size={14} className="shrink-0 text-faint" />
              <span className="truncate">{title}</span>
            </span>
          </Link>
        ) : (
          <span className="text-xs text-faint">None</span>
        )}
      </div>
      {fetcher.data?.error && (
        <div className="mt-2">
          <ErrorText>{fetcher.data.error}</ErrorText>
        </div>
      )}
    </section>
  );
}

/**
 * A list's filter: a button that opens a searchable menu of choices, each
 * a link to the list filtered that way.
 */
export function FilterMenu({
  label,
  active,
  options,
  clearTo,
  searchPlaceholder,
  emptyText,
}: {
  label: string;
  /** What it is filtered by now, shown on the button. */
  active?: ReactNode;
  options: { key: string; to: string; label: ReactNode; keywords: string; selected?: boolean }[];
  /** Where "Clear" goes, when something is chosen. */
  clearTo?: string;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors",
            active ? "border-accent/40 bg-accent/5 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg",
          )}
        >
          {label}
          {active && <span className="max-w-32 truncate font-medium">{active}</span>}
          <ChevronDown size={14} className="text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {clearTo && (
              <CommandGroup>
                <CommandItem value="clear-filter" onSelect={() => go(clearTo)}>
                  <X />
                  Clear
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup>
              {options.map((option) => (
                <CommandItem key={option.key} value={option.keywords} onSelect={() => go(option.to)}>
                  <span className="flex size-4 items-center justify-center">
                    {option.selected && <Check className="text-accent" />}
                  </span>
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
