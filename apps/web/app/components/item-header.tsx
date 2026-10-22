/**
 * The top of a work item's page: where it is (its project, or Work, then
 * its parent), the list it was opened from with Previous and Next (K and
 * J), Start agent as a split button, and the ⋯ menu of everything else
 * (claim, release, hand off, move, close, reopen). Below it, its title and
 * description, edited in place with E.
 */
import {
  ArrowRightLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  CornerDownRight,
  GitPullRequest,
  Hand,
  HandHelping,
  Link2,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Sparkles,
  Terminal,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { type FetcherWithComponents, Form, Link, useFetcher } from "react-router";

import type { AgentSessionsSetup, ItemRepo, ReactionGroup, WorkProjectRef } from "@g1t/contracts";

import { cn } from "../lib/cn";
import { projectPath } from "../lib/projects";
import { keyFor } from "../lib/work-item-page";
import { ROLE_LABELS, itemPath, workPath } from "../lib/work-items";
import { StartSessionDialog } from "./coordination";
import { Markdown } from "./markdown";
import { MentionTextarea } from "./mention-textarea";
import { ProjectMark } from "./projects";
import { Reactions } from "./reactions";
import { CloseDialog } from "./sub-items";
import { ErrorText, Input, SubmitButton } from "./ui";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "./ui/breadcrumb";
import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Kbd } from "./ui/kbd";
import { SelectField } from "./ui/select";
import { SendKey } from "./item-activity";

/** A key's hint at the end of a menu item. */
function MenuKey({ children }: { children: ReactNode }) {
  return <Kbd className="ml-auto text-[0.625rem] text-faint pointer-coarse:hidden">{children}</Kbd>;
}

// --- Where it is ---------------------------------------------------------------

/** Its project (or Work), its parent, then its number. */
export function ItemCrumbs({
  workspace,
  number,
  project,
  parent,
}: {
  workspace: string;
  number: number;
  project: WorkProjectRef | null | undefined;
  parent: { number: number; title: string } | null;
}) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="-ml-1.5">
        <BreadcrumbItem>
          {project ? (
            <BreadcrumbLink asChild className="inline-flex items-center gap-1.5">
              <Link to={projectPath(workspace, project.slug)} prefetch="intent">
                <ProjectMark project={project} size={16} />
                <span className="truncate max-sm:hidden">{project.name}</span>
              </Link>
            </BreadcrumbLink>
          ) : (
            <BreadcrumbLink asChild>
              <Link to={workPath(workspace)} prefetch="intent">
                Work
              </Link>
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>
        <BreadcrumbSeparator>›</BreadcrumbSeparator>
        {parent && (
          <>
            <BreadcrumbItem className="max-sm:hidden">
              <Hint label={`Sub-item of #${parent.number}: ${parent.title}`}>
                <BreadcrumbLink asChild className="max-w-48">
                  <Link to={itemPath(workspace, parent.number)} prefetch="intent">
                    #{parent.number} {parent.title}
                  </Link>
                </BreadcrumbLink>
              </Hint>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="max-sm:hidden">›</BreadcrumbSeparator>
          </>
        )}
        <BreadcrumbItem>
          <BreadcrumbPage className="shrink-0 font-mono text-xs">#{number}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/** Its place in the list it was opened from, with Previous (K) and Next (J). */
export function ItemStepper({
  at,
  label,
  href,
  previous,
  next,
  state,
}: {
  at: { index: number; total: number };
  label: string;
  href: string;
  previous: string | null;
  next: string | null;
  /** The location state each link carries, so the list goes with it. */
  state?: unknown;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Hint label={`Back to ${label}`}>
        <Link to={href} className="mr-1 rounded-md px-1.5 py-1 text-xs text-faint tabular-nums transition-colors hover:bg-raised hover:text-fg max-sm:hidden">
          {at.index} / {at.total}
        </Link>
      </Hint>
      <Hint
        label={
          <>
            Previous <Kbd>K</Kbd>
          </>
        }
      >
        <Button variant="ghost" size="icon-xs" aria-label="Previous work item" aria-keyshortcuts="K" disabled={!previous} asChild={previous != null}>
          {previous ? (
            <Link to={previous} prefetch="intent" state={state}>
              <ChevronLeft size={15} />
            </Link>
          ) : (
            <ChevronLeft size={15} />
          )}
        </Button>
      </Hint>
      <Hint
        label={
          <>
            Next <Kbd>J</Kbd>
          </>
        }
      >
        <Button variant="ghost" size="icon-xs" aria-label="Next work item" aria-keyshortcuts="J" disabled={!next} asChild={next != null}>
          {next ? (
            <Link to={next} prefetch="intent" state={state}>
              <ChevronRight size={15} />
            </Link>
          ) : (
            <ChevronRight size={15} />
          )}
        </Button>
      </Hint>
    </div>
  );
}

// --- Start agent ------------------------------------------------------------------

/**
 * Start agent, as a split button: the button opens Start an agent (on the
 * workspace's Anthropic account where it is set up, else on your own
 * machine); its menu picks where, or another way to start: your own agent
 * on the reference, or a draft pull request of your own.
 */
export function StartAgentButton({
  setup,
  repo,
  error,
  command,
  setupHref,
  open,
  onOpenChange,
  reference,
  onOpenPull,
  branchHref,
}: {
  setup: AgentSessionsSetup | null;
  repo: string;
  error?: string | null;
  command?: string | null;
  setupHref?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `acme#12`, for your own agent. */
  reference: string;
  /** Opens a draft pull request of your own; absent when there is nowhere to open one. */
  onOpenPull?: () => void;
  /** Opening a pull request from a branch already pushed. */
  branchHref?: string | null;
}) {
  const hosted = setup?.available === true;
  const [where, setWhere] = useState<"hosted" | "local">(hosted ? "hosted" : "local");
  const [copied, setCopied] = useState(false);
  const start = (place: "hosted" | "local") => {
    setWhere(place);
    onOpenChange(true);
  };
  return (
    <>
      <div className="inline-flex shrink-0 items-stretch rounded-md shadow-xs">
        <Hint
          label={
            <>
              Start an agent <Kbd>{keyFor("agent")}</Kbd>
            </>
          }
        >
          <Button size="sm" variant="outline" className="rounded-r-none border-r-0" onClick={() => start(hosted ? "hosted" : "local")} aria-keyshortcuts="D">
            <Sparkles size={14} className="text-accent" />
            <span className="max-sm:hidden">Start agent</span>
            <span className="sm:hidden">Agent</span>
          </Button>
        </Hint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="outline" className="w-7 rounded-l-none" aria-label="More ways to start">
              <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Start an agent</DropdownMenuLabel>
            <DropdownMenuItem disabled={!hosted} onSelect={() => start("hosted")}>
              <Bot />
              <span className="min-w-0">
                <span className="block">On the workspace&apos;s Anthropic account</span>
                <span className="block text-xs text-faint">{hosted ? "Hosted: it shows here as it goes" : (setup?.problem ?? "Not set up yet")}</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => start("local")}>
              <Terminal />
              <span className="min-w-0">
                <span className="block">On your own machine</span>
                <span className="block text-xs text-faint">The Claude Code command to run</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                void navigator.clipboard.writeText(reference);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="text-success!" /> : <Copy />}
              <span className="min-w-0">
                <span className="block">{copied ? "Copied" : `Copy ${reference}`}</span>
                <span className="block text-xs text-faint">For your own agent, connected to g1t</span>
              </span>
            </DropdownMenuItem>
            {onOpenPull && (
              <DropdownMenuItem onSelect={onOpenPull}>
                <GitPullRequest />
                Open a draft pull request…
              </DropdownMenuItem>
            )}
            {branchHref && (
              <DropdownMenuItem asChild>
                <Link to={branchHref}>
                  <CornerDownRight />
                  Open a pull request from a branch
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <StartSessionDialog
        setup={setup}
        repo={repo}
        error={error}
        command={command}
        setupHref={setupHref}
        open={open}
        onOpenChange={onOpenChange}
        trigger={null}
        where={where}
      />
    </>
  );
}

/** Opening a draft pull request yourself, in one of its repositories, with a fork to push to. */
export function OpenPullDialog({
  repos,
  defaultRepo,
  error,
  open,
  onOpenChange,
}: {
  repos: ItemRepo[];
  defaultRepo: string | null;
  error?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="action" value="open-pull" />
          <DialogHeader>
            <DialogTitle>Open a draft pull request</DialogTitle>
            <DialogDescription>A draft for this work item, with a fork of its own to push to. Mark it ready once the work is in.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel>Repository</FieldLabel>
            <SelectField
              name="repo"
              aria-label="Repository"
              defaultValue={repos.some((repo) => repo.path === defaultRepo) ? defaultRepo! : repos[0]?.path}
              options={repos.map((repo) => ({ value: repo.path, label: `${repo.path} (${ROLE_LABELS[repo.role].toLowerCase()})` }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="open-pull-agent">Who is working</FieldLabel>
            <Input id="open-pull-agent" name="agent" placeholder="claude-code" maxLength={60} />
            <FieldDescription>Optional: the agent doing the work, shown on the pull request.</FieldDescription>
          </Field>
          {error && <ErrorText>{error}</ErrorText>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <SubmitButton match={{ action: "open-pull" }} pending="Opening…">
              Open pull request
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// --- The ⋯ menu ------------------------------------------------------------------

/** Handing your claim off: to someone or anyone, with where it stands. */
function HandOffDialog({ open, onOpenChange, members }: { open: boolean; onOpenChange: (open: boolean) => void; members: string[] }) {
  const fetcher = useFetcher<{ error?: string; handedOff?: boolean } | null>();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.handedOff) onOpenChange(false);
  }, [fetcher.state, fetcher.data, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <fetcher.Form method="post" className="grid gap-5">
          <input type="hidden" name="action" value="handoff" />
          <DialogHeader>
            <DialogTitle>Hand it off</DialogTitle>
            <DialogDescription>Your claim ends as handed off, and whoever picks it up reads your note.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="handoff-to">To</FieldLabel>
            <Input id="handoff-to" name="to" list="handoff-people" placeholder="Anyone" autoComplete="off" />
            <datalist id="handoff-people">
              {members.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <FieldDescription>A username, or leave it empty for anyone.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="handoff-note">Where it stands</FieldLabel>
            <MentionTextarea
              id="handoff-note"
              name="note"
              rows={4}
              required
              maxLength={2000}
              placeholder="What is done, what is left, and anything to watch for"
            />
          </Field>
          {fetcher.state === "idle" && fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <SubmitButton fetcher={fetcher} pending="Handing off…">
              Hand off
            </SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The ⋯ menu: claim it (I), release or hand off your claim, move it under
 * another work item, close it (Shift C) or reopen it, and copy its link.
 */
export function ItemMenu({
  open: isOpen,
  canClaim,
  claimed,
  canManage,
  canMove,
  parent,
  members,
  onClaim,
  onClose,
  onMove,
  claimError,
}: {
  /** The work item is open. */
  open: boolean;
  canClaim: boolean;
  /** The viewer holds an active claim on it. */
  claimed: boolean;
  canManage: boolean;
  canMove: boolean;
  parent: number | null;
  members: string[];
  onClaim: () => void;
  onClose: () => void;
  onMove: () => void;
  claimError?: string | null;
}) {
  const fetcher = useFetcher<{ error?: string } | null>();
  const [handingOff, setHandingOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const error = claimError ?? (fetcher.state === "idle" ? fetcher.data?.error : null);
  return (
    <>
      <DropdownMenu>
        <Hint label="More">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" className="max-sm:size-10">
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-60">
          {canClaim && isOpen && !claimed && (
            <DropdownMenuItem onSelect={onClaim}>
              <Hand />
              Claim it
              <MenuKey>{keyFor("claim")}</MenuKey>
            </DropdownMenuItem>
          )}
          {claimed && (
            <>
              <DropdownMenuItem onSelect={onClaim}>
                <Hand />
                Renew your claim
                <MenuKey>{keyFor("claim")}</MenuKey>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => fetcher.submit({ action: "release" }, { method: "post" })}>
                <HandHelping />
                Release your claim
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHandingOff(true)}>
                <ArrowRightLeft />
                Hand it off…
              </DropdownMenuItem>
            </>
          )}
          {canMove && (
            <>
              {(canClaim || claimed) && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={onMove}>
                <CornerDownRight />
                {parent ? "Move under another work item…" : "Make it a sub-item of…"}
              </DropdownMenuItem>
            </>
          )}
          {canManage && (
            <>
              <DropdownMenuSeparator />
              {isOpen ? (
                <DropdownMenuItem onSelect={onClose}>
                  <CircleCheck />
                  Close…
                  <MenuKey>{keyFor("close")}</MenuKey>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => fetcher.submit({ action: "reopen" }, { method: "post" })}>
                  <RotateCcw />
                  Reopen
                </DropdownMenuItem>
              )}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void navigator.clipboard.writeText(window.location.href.split("#")[0]!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="text-success!" /> : <Link2 />}
            {copied ? "Copied" : "Copy link"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span className="sr-only" role="status">
          {error}
        </span>
      )}
      <HandOffDialog open={handingOff} onOpenChange={setHandingOff} members={members} />
    </>
  );
}

// --- Its title and description, edited in place ------------------------------------

/** Saving an edit of its title and description: the page holds one, which its title and body share. */
export type EditFetcher = FetcherWithComponents<{ error?: string; edited?: boolean } | null>;

/** What an edit shows while it saves: what was written, else what is so. */
function shownText(fetcher: EditFetcher, title: string, body: string): { title: string; body: string; saving: boolean } {
  const posted = fetcher.state !== "idle" ? fetcher.formData : null;
  return { title: posted ? String(posted.get("title") ?? title) : title, body: posted ? String(posted.get("body") ?? body) : body, saving: posted != null };
}

/**
 * Its title, and with E, its title and description edited where they are:
 * ⌘ Enter or Ctrl Enter saves, Esc puts them back.
 */
export function ItemTitle({
  fetcher,
  title,
  body,
  canEdit,
  editing,
  onEditingChange,
  handles,
  aside,
}: {
  fetcher: EditFetcher;
  title: string;
  body: string;
  canEdit: boolean;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  handles: string[];
  /** Under the title: its state, who opened it. */
  aside?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.edited) onEditingChange(false);
  }, [fetcher.state, fetcher.data, onEditingChange]);
  const shown = shownText(fetcher, title, body);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      onEditingChange(false);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      form.current?.requestSubmit();
    }
  };
  if (editing && canEdit) {
    return (
      <fetcher.Form ref={form} method="post" className="grid gap-3" onKeyDown={keys}>
        <input type="hidden" name="action" value="edit" />
        <Input
          name="title"
          defaultValue={title}
          aria-label="Title"
          required
          maxLength={256}
          autoFocus
          className="h-auto py-1.5 text-xl font-semibold tracking-tight sm:text-2xl"
        />
        <MentionTextarea
          name="body"
          defaultValue={body}
          handles={handles}
          rows={Math.min(24, Math.max(6, body.split("\n").length + 2))}
          aria-label="Description"
          placeholder="What should change, and what done means. Markdown works."
        />
        {fetcher.state === "idle" && fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton fetcher={fetcher} pending="Saving…">
            Save
          </SubmitButton>
          <Button type="button" variant="ghost" onClick={() => onEditingChange(false)}>
            Cancel
          </Button>
          <span className="ml-auto flex items-center gap-1.5 text-xs text-faint pointer-coarse:hidden">
            <SendKey /> saves, <Kbd>Esc</Kbd> cancels
          </span>
        </div>
      </fetcher.Form>
    );
  }
  return (
    <div>
      <div className="group/title flex items-start gap-2">
        <h1 className="min-w-0 grow text-xl font-semibold tracking-tight text-balance wrap-break-word sm:text-2xl">{shown.title}</h1>
        {canEdit && (
          <Hint
            label={
              <>
                Edit <Kbd>{keyFor("edit")}</Kbd>
              </>
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit the title and description"
              aria-keyshortcuts="E"
              className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              onClick={() => onEditingChange(true)}
            >
              <Pencil size={15} />
            </Button>
          </Hint>
        )}
      </div>
      {aside && <div className="mt-2.5">{aside}</div>}
    </div>
  );
}

/** Its description, read as Markdown (its task list ticked in place by who may), with its reactions. Hidden while it is edited. */
export function ItemBody({
  fetcher,
  workspace,
  title,
  body,
  reactions,
  viewer,
  canEdit,
  editing,
  onEdit,
}: {
  fetcher: EditFetcher;
  workspace: string;
  title: string;
  body: string;
  reactions: ReactionGroup[] | undefined;
  viewer: string | null;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
}) {
  if (editing && canEdit) return null;
  const shown = shownText(fetcher, title, body);
  return (
    <div>
      {shown.body ? (
        <div className={cn(shown.saving && "opacity-70")}>
          <Markdown source={shown.body} workspace={workspace} checkable={canEdit} />
        </div>
      ) : canEdit ? (
        <button
          type="button"
          onClick={onEdit}
          className="w-full rounded-lg border border-dashed border-line px-4 py-3 text-left text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
        >
          Add a description…
        </button>
      ) : (
        <p className="text-sm text-faint">No description.</p>
      )}
      <Reactions reactions={reactions} viewer={viewer} className="mt-4" />
    </div>
  );
}
