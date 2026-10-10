import { Command as Cmdk } from "cmdk";
import { Code2, CornerDownLeft, Search } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";

import type { SiteHit } from "@g1t/contracts";

import { searchHref } from "../lib/search";
import { hitIcon } from "./search";
import type { PaletteCommand } from "./command-palette";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "./ui/command";
import { SkeletonRows } from "./ui/skeleton";

/** How long typing has to pause before results are asked for. */
const PAUSE_MS = 140;

function hitHint(hit: SiteHit): string {
  switch (hit.kind) {
    case "repository":
      return "Repository";
    case "issue":
      return `${hit.repo} #${hit.number}`;
    case "pull":
      return `${hit.repo} #${hit.number}`;
    case "user":
      return `Person · ${hit.slug}`;
    case "workspace":
      return `Workspace · ${hit.slug}`;
    default:
      return hit.repo ?? "";
  }
}

/**
 * ⌘K: pages and actions from what the page already knows, and, as someone
 * types, repositories, issues, pull requests and people from search,
 * public ones for anyone and private ones for their workspaces' members.
 * The first row always searches all of g1t for what was typed.
 */
export default function CommandPaletteDialog({
  open,
  onOpenChange,
  commands,
  repo,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: PaletteCommand[];
  /** The repository being looked at, `owner/name`, to offer searching its code. */
  repo?: string | null;
  /** Where focus goes once it closes (command-palette.tsx). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const navigate = useNavigate();
  const fetcher = useFetcher<{ q: string; hits: SiteHit[] }>();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  useEffect(() => {
    if (trimmed.length < 2) return;
    const timer = setTimeout(() => fetcher.load(`/search.json?q=${encodeURIComponent(trimmed)}`), PAUSE_MS);
    return () => clearTimeout(timer);
    // `fetcher` changes identity as it loads; only the text should restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const hits = trimmed.length >= 2 && fetcher.data?.q === trimmed ? fetcher.data.hits : [];
  const go = (to: string) => {
    onOpenChange(false);
    // The docs and other sites are full page loads.
    if (/^https?:\/\//.test(to)) window.location.assign(to);
    else navigate(to);
  };
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = commands.filter((command) => {
    const text = `${command.label} ${command.hint ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const pages = matching.filter((command) => command.to != null).slice(0, trimmed ? 8 : 12);
  // Things done in place, such as switching the theme, once something is typed.
  const actions = trimmed ? matching.filter((command) => command.run != null).slice(0, 6) : [];
  const itemClass = "gap-3 rounded-lg px-3 py-2";

  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none" />
        <Primitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-sm:top-[calc(env(safe-area-inset-top)+0.5rem)] max-sm:w-[calc(100vw-1rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-raised shadow-2xl shadow-black/60 outline-none"
        >
          <Primitive.Title className="sr-only">Go to or search</Primitive.Title>
          {/* Filtering is done here: search already filtered its results. */}
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={16} className="shrink-0 text-faint" />
              <Cmdk.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Search g1t, or go to a page…"
                autoComplete="off"
                data-1p-ignore
                className="h-12 grow border-0 bg-transparent text-sm shadow-none outline-none placeholder:text-faint focus-visible:outline-none"
              />
              <kbd className="rounded border border-line px-1.5 font-mono text-[0.6875rem] text-faint">esc</kbd>
            </div>
            <CommandList className="max-h-[55vh] p-1.5 max-sm:max-h-[calc(var(--vv-height,100dvh)-env(safe-area-inset-top)-5.5rem)]">
              <CommandEmpty>Nothing matches.</CommandEmpty>
              {trimmed && (
                <CommandGroup heading="Search">
                  <CommandItem value="search:all" onSelect={() => go(searchHref(trimmed))} className={itemClass}>
                    <Search />
                    <span className="min-w-0 grow truncate">
                      Search g1t for <span className="font-medium text-fg">“{trimmed}”</span>
                    </span>
                    <CornerDownLeft className="size-3.5! text-faint!" />
                  </CommandItem>
                  <CommandItem value="search:code" onSelect={() => go(searchHref(trimmed, "code"))} className={itemClass}>
                    <Code2 />
                    <span className="min-w-0 grow truncate">
                      Search code for <span className="font-medium text-fg">“{trimmed}”</span>
                    </span>
                  </CommandItem>
                  {repo && (
                    <CommandItem
                      value="search:repo"
                      onSelect={() => go(searchHref(`${trimmed} repo:${repo}`, "code"))}
                      className={itemClass}
                    >
                      <Code2 />
                      <span className="min-w-0 grow truncate">
                        Search <span className="font-mono">{repo}</span> for{" "}
                        <span className="font-medium text-fg">“{trimmed}”</span>
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
              )}
              {hits.length > 0 && (
                <CommandGroup heading="Results">
                  {hits.map((hit) => (
                    <CommandItem
                      key={`${hit.kind}:${hit.url}`}
                      value={`hit:${hit.kind}:${hit.url}`}
                      onSelect={() => go(hit.url)}
                      className={itemClass}
                    >
                      {hitIcon(hit)}
                      <span className="min-w-0 grow truncate">
                        {hit.kind === "repository" ? <span className="font-mono">{hit.title}</span> : hit.title}
                      </span>
                      <span className="shrink-0 truncate text-xs text-faint">{hitHint(hit)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {pages.length > 0 && (
                <CommandGroup heading="Go to">
                  {pages.map((command) => (
                    <CommandItem
                      key={`${command.to}-${command.label}`}
                      value={`page:${command.to}:${command.label}`}
                      onSelect={() => go(command.to!)}
                      className={itemClass}
                    >
                      <span className="shrink-0 text-faint">{command.icon}</span>
                      <span className="min-w-0 grow truncate">{command.label}</span>
                      {command.hint && <span className="shrink-0 truncate text-xs text-faint">{command.hint}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {actions.length > 0 && (
                <CommandGroup heading="Commands">
                  {actions.map((command) => (
                    <CommandItem
                      key={`run-${command.label}`}
                      value={`run:${command.label}`}
                      onSelect={() => {
                        onOpenChange(false);
                        command.run!();
                      }}
                      className={itemClass}
                    >
                      <span className="shrink-0 text-faint">{command.icon}</span>
                      <span className="min-w-0 grow truncate">{command.label}</span>
                      {command.hint && <span className="shrink-0 truncate text-xs text-faint">{command.hint}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {hits.length === 0 && fetcher.state === "loading" && trimmed.length >= 2 && (
            <div aria-busy="true" className="border-t border-line">
              <SkeletonRows rows={3} rowClassName="h-9 px-4" />
            </div>
          )}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
