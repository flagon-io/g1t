import { ArrowUpRight, ChevronDown, LoaderCircle, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { RepoPath } from "@g1t/contracts";

import { cn } from "../lib/cn";
import type { NotStarted } from "../lib/delegate";
import { Avatar } from "./ui";
import { CONTROL } from "./ui/input";

/** What the composer's action said back: why nothing opened, or the issue that opened without its agent. */
export type ComposerResult = { error: string | null; notStarted: NotStarted | null } | null;

/**
 * "Put an agent on it": a compact composer that opens an issue in one of
 * the viewer's projects and puts g1t-agent on it, in one step. Posts to
 * Mission control's action, which lands on the issue with the agent
 * running. A native `<details>`, so it opens and posts without script.
 */
export function AgentComposer({
  repos,
  open: openAtFirst,
  result,
  note,
  action = "/?index",
  children,
}: {
  repos: RepoPath[];
  /** Open from the start: asked for by the address, or a post came back. */
  open: boolean;
  /** What a post without script came back with. */
  result: ComposerResult;
  /** Said under the form, such as that agents need a model first. */
  note?: ReactNode;
  action?: string;
  /** The button that opens it. */
  children: ReactNode;
}) {
  const fetcher = useFetcher<ComposerResult>();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(openAtFirst);
  const busy = fetcher.state !== "idle";
  const said = fetcher.data ?? result;

  // Closed by Escape or by a click outside it, as a menu is.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <details
      ref={ref}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="group/composer relative"
    >
      <summary className="list-none [&::-webkit-details-marker]:hidden">{children}</summary>
      <div className="fixed inset-x-4 top-20 z-40 sm:absolute sm:inset-x-auto sm:top-full sm:left-0 sm:mt-2 sm:w-[28rem]">
        <fetcher.Form
          method="post"
          action={action}
          className="rounded-xl border border-line-strong bg-raised p-4 shadow-2xl shadow-black/50"
          aria-label="Put an agent on it"
        >
          <input type="hidden" name="intent" value="delegate" />
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={15} className="text-merged" />
            Put an agent on it
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            Opens an issue and assigns g1t-agent at once. It makes the change in a sandbox and sees it through checks
            and review.
          </p>

          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Project</span>
              <span className="relative block">
                <select name="repo" required className={cn(CONTROL, "h-9 appearance-none pr-8")} defaultValue={repos[0] ? `${repos[0].namespace}/${repos[0].name}` : ""}>
                  {repos.map((repo) => (
                    <option key={`${repo.namespace}/${repo.name}`} value={`${repo.namespace}/${repo.name}`}>
                      {repo.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-faint" />
              </span>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">Title</span>
              <input
                name="title"
                required
                maxLength={200}
                autoComplete="off"
                data-1p-ignore
                placeholder="Retry failed webhook deliveries"
                className={cn(CONTROL, "h-9")}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted">What you want done</span>
              <textarea
                name="body"
                rows={4}
                placeholder="In plain words: what is wrong or wanted, and anything the agent cannot see for itself."
                className={cn(CONTROL, "min-h-24 resize-y leading-relaxed")}
              />
            </label>
            <details className="group/checks">
              <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                <ChevronDown size={13} className="mr-1 inline -rotate-90 transition-transform group-open/checks:rotate-0" />
                Acceptance checks <span className="font-normal text-faint">(optional)</span>
              </summary>
              <textarea
                name="checks"
                rows={2}
                placeholder="npm test"
                aria-label="Acceptance checks, one command per line"
                className={cn(CONTROL, "mt-2 min-h-16 resize-y font-mono text-xs")}
              />
              <span className="mt-1 block text-xs text-faint">One command per line. Its pull request must make them all pass.</span>
            </details>
          </div>

          {said?.error && <p className="mt-3 text-sm text-danger">{said.error}</p>}
          {said?.notStarted && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.06] p-3 text-sm">
              <p className="text-fg-soft">
                Opened <Link to={said.notStarted.to} className="font-medium text-fg hover:underline">#{said.notStarted.number}</Link>, but
                g1t-agent did not start. {said.notStarted.message}
              </p>
              <p className="mt-2 flex flex-wrap gap-2">
                {said.notStarted.fix && (
                  <Link
                    to={said.notStarted.fix.to}
                    className="inline-flex items-center gap-1 rounded-md bg-fg px-2.5 py-1 text-xs font-medium text-bg hover:bg-white"
                  >
                    {said.notStarted.fix.label} <ArrowUpRight size={12} />
                  </Link>
                )}
                <Link to={said.notStarted.to} className="inline-flex items-center rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-fg/90 hover:bg-bg">
                  Open the issue
                </Link>
              </p>
            </div>
          )}
          {note && <p className="mt-3 text-xs leading-5 text-muted">{note}</p>}

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-faint">
              <Avatar name="g1t-agent" size={16} />
              <span className="truncate">g1t-agent · no model to choose</span>
            </span>
            <button
              type="submit"
              disabled={busy || repos.length === 0}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-merged px-3.5 py-2 text-sm font-semibold text-bg transition-colors hover:bg-[#c9bfff] disabled:opacity-60"
            >
              {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {busy ? "Starting…" : "Put an agent on it"}
            </button>
          </div>
        </fetcher.Form>
      </div>
    </details>
  );
}
