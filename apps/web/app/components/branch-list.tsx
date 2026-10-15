/**
 * The Branches page's list: each branch with its latest commit's author
 * and time, its checks, how far it is behind and ahead of the default
 * branch, and its pull request, and, for people who can push, deleting it
 * (and restoring it for the rest of the visit), renaming it, and making a
 * new branch. The page's action (routes/repo/branches.tsx) does the work.
 */
import {
  Activity,
  Check,
  Copy,
  GitBranch,
  GitBranchPlus,
  GitPullRequestArrow,
  Globe,
  LoaderCircle,
  MoreHorizontal,
  PenLine,
  ShieldCheck,
  ShieldAlert,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useFetcher } from "react-router";

import type { ActiveBranch } from "./branches";
import type { ChecksSource } from "./commit-checks";
import { CommitChecksBadge } from "./commit-checks";
import { CommitAvatars } from "./commit-person";
import { host } from "./deploy";
import { CopyLine, TimeAgo } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { PullIcon } from "./work-icons";
import { isMerged } from "../lib/branches";
import { commitHint } from "../lib/commit-message";

/** What the page's action answers. */
export type BranchActionData = { intent: string; branch?: string; hash?: string; error?: string };

/** A row as the list shows it: a branch, or one deleted on this visit. */
export type BranchRowData = ActiveBranch & { deleted?: boolean };

/** What every row needs to know about the page. */
export type BranchListContext = {
  base: string;
  main: string;
  checks: ChecksSource;
  /** The longest behind or ahead count shown: a full bar. */
  scale: number;
  /** May push: make, delete, restore and rename branches. */
  canPush: boolean;
  /** May rename the default branch (Admin). */
  canRenameDefault: boolean;
  /** May see the rules (Admin). */
  canViewRules: boolean;
  onDeleted: (row: ActiveBranch) => void;
  onRestored: (name: string) => void;
  onError: (message: string) => void;
};

/** A branch name in an address: each part encoded, its slashes kept. */
export function refPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

/** A small copy button: a check for a moment once copied. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Hint label={copied ? "Copied" : label}>
      <Button
        type="button"
        variant="ghost"
        size="inline"
        aria-label={label}
        className="p-1 text-faint opacity-70 group-hover/row:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </Button>
    </Hint>
  );
}

/** The branch's name in a code chip, linked to its files, with a copy button. */
function BranchName({ row, base, isDefault }: { row: BranchRowData; base: string; isDefault: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      {row.deleted ? (
        <code className="truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.8125rem] text-faint line-through">{row.name}</code>
      ) : (
        <Link
          to={`${base}/tree/${encodeURIComponent(row.name)}`}
          className="min-w-0 truncate rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[0.8125rem] font-medium text-accent hover:bg-accent/20"
        >
          {row.name}
        </Link>
      )}
      {!row.deleted && <CopyButton text={row.name} label="Copy the branch name" />}
      {isDefault && <Badge className="ml-1">default</Badge>}
      {row.preview && !row.deleted && (
        <Hint label={`Preview at ${host(row.preview)}`}>
          <a href={row.preview} aria-label={`Preview at ${host(row.preview)}`} className="ml-1 inline-flex rounded p-0.5 text-accent hover:bg-raised">
            <Globe size={13} />
          </a>
        </Hint>
      )}
    </span>
  );
}

/** Who made the latest commit, and when, linked to it. */
function Updated({ row, base }: { row: BranchRowData; base: string }) {
  if (!row.commit) return <span className="text-faint">—</span>;
  return (
    // The avatars link to their people, so they sit beside the commit's
    // link rather than in it: a link inside a link is split apart by the
    // browser, and the page then fails to hydrate.
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <CommitAvatars commit={row.commit} size={18} max={2} />
      <Hint label={commitHint(row.commit.message)}>
        <Link to={`${base}/commit/${row.commit.hash}`} className="text-muted hover:text-fg">
          <TimeAgo at={row.commit.at} />
        </Link>
      </Hint>
    </span>
  );
}

function driftWords(drift: NonNullable<ActiveBranch["drift"]>, main: string): string {
  return `${drift.behind} ${drift.behind === 1 ? "commit" : "commits"} behind ${main}, ${drift.ahead} ahead`;
}

/** Behind on the left, ahead on the right, each with a bar against the longest shown. */
function DriftBars({ drift, scale, main }: { drift: ActiveBranch["drift"]; scale: number; main: string }) {
  if (!drift) return <span className="text-faint">—</span>;
  const width = (count: number) => `${count === 0 ? 0 : Math.max(6, Math.round((count / scale) * 100))}%`;
  return (
    <Hint label={driftWords(drift, main)}>
      <span className="inline-flex w-28 flex-col gap-1" tabIndex={0}>
        <span className="sr-only">{driftWords(drift, main)}</span>
        <span className="grid grid-cols-2 font-mono text-xs tabular-nums" aria-hidden>
          <span className="border-r border-line pr-1.5 text-right text-muted">{drift.behind}</span>
          <span className="pl-1.5 text-muted">{drift.ahead}</span>
        </span>
        <span className="grid h-1 grid-cols-2" aria-hidden>
          <span className="flex justify-end border-r border-line">
            <span className="h-full rounded-l-full bg-faint/60" style={{ width: width(drift.behind) }} />
          </span>
          <span className="flex">
            <span className="h-full rounded-r-full bg-accent/70" style={{ width: width(drift.ahead) }} />
          </span>
        </span>
      </span>
    </Hint>
  );
}

const PULL_STATE = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" } as const;

/** The branch's pull request: its state and number, linked. */
function PullLink({ pull, base }: { pull: ActiveBranch["pull"]; base: string }) {
  if (!pull) return null;
  return (
    <Hint label={pull.title}>
      <Link
        to={`${base}/pull/${pull.number}`}
        className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs whitespace-nowrap text-muted hover:border-line-strong hover:text-fg"
      >
        <PullIcon status={pull.status} size={13} />#{pull.number}
        <span className="sr-only">
          {PULL_STATE[pull.status]}: {pull.title}
        </span>
      </Link>
    </Hint>
  );
}

/**
 * A fetcher for one row's actions, calling `done` once with each answer
 * that comes back. It is called as soon as the answer is in, while the
 * page reloads: a deleted branch's row is gone once it has, and with it
 * this fetcher.
 */
function useBranchAction(done: (data: BranchActionData) => void) {
  const fetcher = useFetcher<BranchActionData>();
  const handled = useRef<BranchActionData | undefined>(undefined);
  const latest = useRef(done);
  latest.current = done;
  useEffect(() => {
    if (fetcher.state === "submitting" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    latest.current(fetcher.data);
  }, [fetcher.state, fetcher.data]);
  return fetcher;
}

/** Renaming a branch, with what it does to pull requests, addresses and clones. */
function RenameDialog({
  row,
  main,
  open,
  onOpenChange,
}: {
  row: BranchRowData;
  main: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [to, setTo] = useState(row.name);
  const [error, setError] = useState<string | null>(null);
  const fetcher = useBranchAction((data) => {
    if (data.error) setError(data.error);
    else onOpenChange(false);
  });
  const busy = fetcher.state !== "idle";
  const next = to.trim();
  const isDefault = row.name === main;
  const openPull = row.pull && (row.pull.status === "open" || row.pull.status === "draft") ? row.pull : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(now) => {
        if (now) {
          setTo(row.name);
          setError(null);
        }
        onOpenChange(now);
      }}
    >
      <DialogContent>
        <fetcher.Form method="post" className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Rename {row.name}</DialogTitle>
            <DialogDescription>
              {openPull ? (
                <>
                  Pull request #{openPull.number} from it follows it to the new name, and stays open.{" "}
                </>
              ) : (
                <>Open pull requests from it follow it to the new name. </>
              )}
              Addresses that name {row.name} redirect to the new name until a branch called {row.name} is made again.
              {isDefault && " It stays the default branch, and pull requests into it merge into the new name."}
            </DialogDescription>
          </DialogHeader>
          <input type="hidden" name="intent" value="rename" />
          <input type="hidden" name="branch" value={row.name} />
          <Field>
            <FieldLabel htmlFor={`rename-${row.name}`}>New name</FieldLabel>
            <Input
              id={`rename-${row.name}`}
              name="to"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              maxLength={200}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono"
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <div className="grid gap-1.5">
            <p className="text-xs text-muted">Clones keep the old name until they catch up:</p>
            <CopyLine
              text={`git branch -m ${row.name} ${next || "<new-name>"} && git fetch origin && git branch -u origin/${next || "<new-name>"} ${next || "<new-name>"}`}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || next === "" || next === row.name}>
              {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden />}
              Rename branch
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** The ⋯ menu of a row: a pull request, its activity, its rules, renaming it. */
function RowMenu({ row, context, onRename }: { row: BranchRowData; context: BranchListContext; onRename: () => void }) {
  const { base, main, canPush, canRenameDefault, canViewRules } = context;
  const isDefault = row.name === main;
  const canRename = isDefault ? canRenameDefault : canPush;
  return (
    <DropdownMenu>
      <Hint label="More">
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`More for ${row.name}`}>
            <MoreHorizontal size={15} />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end">
        {!isDefault && (
          <DropdownMenuItem asChild>
            <Link to={`${base}/compare/${refPath(main)}...${refPath(row.name)}`}>
              <GitPullRequestArrow />
              New pull request
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link to={`${base}/activity?branch=${encodeURIComponent(row.name)}`}>
            <Activity />
            Activity
          </Link>
        </DropdownMenuItem>
        {canViewRules && (
          <DropdownMenuItem asChild>
            <Link to={`${base}/settings/rules?branch=${encodeURIComponent(row.name)}`}>
              <ShieldCheck />
              View rules
            </Link>
          </DropdownMenuItem>
        )}
        {canRename && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRename}>
              <PenLine />
              Rename branch
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The trash button; branches with work the default branch lacks ask first. */
function DeleteButton({ row, context }: { row: BranchRowData; context: BranchListContext }) {
  const [asking, setAsking] = useState(false);
  const fetcher = useBranchAction((data) => {
    if (data.error) context.onError(data.error);
    else context.onDeleted(row);
  });
  const busy = fetcher.state !== "idle";
  const remove = () => fetcher.submit({ intent: "delete", branch: row.name, head: row.head }, { method: "post" });
  const ahead = row.drift?.ahead ?? null;
  const openPull = row.pull && (row.pull.status === "open" || row.pull.status === "draft") ? row.pull : null;
  return (
    <>
      <Hint label="Delete branch">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete ${row.name}`}
          disabled={busy}
          className="hover:text-danger"
          onClick={() => (isMerged(row) ? remove() : setAsking(true))}
        >
          {busy ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </Button>
      </Hint>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {row.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {ahead == null
                ? `It may have commits that are not on ${context.main}.`
                : `It has ${ahead} ${ahead === 1 ? "commit" : "commits"} that ${ahead === 1 ? "is" : "are"} not on ${context.main}.`}{" "}
              {openPull && `Pull request #${openPull.number} from it cannot be updated or merged while it is gone. `}
              You can restore it from this page until you leave it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="border border-danger/40 bg-transparent text-danger hover:border-danger hover:bg-danger/10"
              onClick={remove}
            >
              Delete branch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Making a deleted branch again at the commit it pointed to. */
function RestoreButton({ row, context }: { row: BranchRowData; context: BranchListContext }) {
  const fetcher = useBranchAction((data) => {
    if (data.error) context.onError(data.error);
    else context.onRestored(row.name);
  });
  const busy = fetcher.state !== "idle";
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={busy}
      onClick={() => fetcher.submit({ intent: "restore", branch: row.name, head: row.head }, { method: "post" })}
    >
      {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Undo2 size={13} />}
      Restore
    </Button>
  );
}

/** A row's buttons: restore once deleted; otherwise delete and the menu. */
function RowActions({ row, context }: { row: BranchRowData; context: BranchListContext }) {
  const [renaming, setRenaming] = useState(false);
  if (row.deleted) return context.canPush ? <RestoreButton row={row} context={context} /> : null;
  const isDefault = row.name === context.main;
  return (
    <span className="flex items-center justify-end gap-0.5">
      {context.canPush && !isDefault && <DeleteButton row={row} context={context} />}
      <RowMenu row={row} context={context} onRename={() => setRenaming(true)} />
      {renaming && <RenameDialog row={row} main={context.main} open={renaming} onOpenChange={setRenaming} />}
    </span>
  );
}

/** One branch as a table row; below `md`, its details fold under the name. */
function BranchRow({ row, context }: { row: BranchRowData; context: BranchListContext }) {
  const { base, main, checks, scale } = context;
  const isDefault = row.name === main;
  const sha = row.commit?.hash ?? row.head;
  return (
    <TableRow className={row.deleted ? "group/row bg-raised/30" : "group/row hover:bg-raised/30"}>
      <TableCell className="max-w-0 py-2.5 align-middle md:w-[40%]">
        <BranchName row={row} base={base} isDefault={isDefault} />
        {/* What the other columns say, for a narrow screen. */}
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs md:hidden">
          {row.deleted ? (
            <Badge tone="danger">Deleted</Badge>
          ) : (
            <>
              <Updated row={row} base={base} />
              {sha && <CommitChecksBadge checks={checks} sha={sha} className="size-5" />}
              {row.drift && !isDefault && (
                <span className="font-mono text-muted tabular-nums">
                  <span className="sr-only">{driftWords(row.drift, main)}</span>
                  <span aria-hidden>
                    ↓{row.drift.behind} ↑{row.drift.ahead}
                  </span>
                </span>
              )}
              <PullLink pull={row.pull} base={base} />
            </>
          )}
        </span>
      </TableCell>
      {row.deleted ? (
        <TableCell colSpan={4} className="align-middle max-md:hidden">
          <Badge tone="danger">Deleted</Badge>
        </TableCell>
      ) : (
        <>
          <TableCell className="align-middle max-md:hidden">
            <Updated row={row} base={base} />
          </TableCell>
          <TableCell className="align-middle max-md:hidden">
            {sha ? <CommitChecksBadge checks={checks} sha={sha} className="size-6" /> : null}
          </TableCell>
          <TableCell className="align-middle max-md:hidden">
            {isDefault ? <span className="text-xs text-faint">Default</span> : <DriftBars drift={row.drift} scale={scale} main={main} />}
          </TableCell>
          <TableCell className="align-middle max-md:hidden">
            <PullLink pull={row.pull} base={base} />
          </TableCell>
        </>
      )}
      <TableCell className="w-px py-2 pr-2 align-middle whitespace-nowrap">
        <RowActions row={row} context={context} />
      </TableCell>
    </TableRow>
  );
}

/** A section's branches as a table under the column names. */
export function BranchTable({ rows, context, label }: { rows: BranchRowData[]; context: BranchListContext; label: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead>Branch</TableHead>
            <TableHead className="max-md:hidden">Updated</TableHead>
            <TableHead className="max-md:hidden">Check status</TableHead>
            <TableHead className="max-md:hidden">
              <span className="inline-grid w-28 grid-cols-2">
                <span className="border-r border-line pr-1.5 text-right">Behind</span>
                <span className="pl-1.5">Ahead</span>
              </span>
            </TableHead>
            <TableHead className="max-md:hidden">Pull request</TableHead>
            <TableHead className="w-px">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <BranchRow key={row.name} row={row} context={context} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Making a branch: its name, and the branch, tag or commit it starts at. */
export function NewBranchDialog({
  branches,
  main,
  onMade,
}: {
  /** Every branch's name, the default first. */
  branches: string[];
  main: string;
  onMade: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [from, setFrom] = useState(main);
  const [byCommit, setByCommit] = useState(false);
  const [commit, setCommit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fetcher = useBranchAction((data) => {
    if (data.error) return setError(data.error);
    setOpen(false);
    onMade(data.branch ?? name.trim());
  });
  const busy = fetcher.state !== "idle";
  const source = byCommit ? commit.trim() : from;
  return (
    <Dialog
      open={open}
      onOpenChange={(now) => {
        if (now) {
          setName("");
          setFrom(main);
          setByCommit(false);
          setCommit("");
          setError(null);
        }
        setOpen(now);
      }}
    >
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <GitBranchPlus size={15} />
        New branch
      </Button>
      <DialogContent>
        <fetcher.Form method="post" className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a branch</DialogTitle>
            <DialogDescription>It starts at the same commit as the branch, tag or commit you pick. Push to it, or open a pull request from it.</DialogDescription>
          </DialogHeader>
          <input type="hidden" name="intent" value="create" />
          <input type="hidden" name="from" value={source} />
          <Field>
            <FieldLabel htmlFor="new-branch-name">Name</FieldLabel>
            <Input
              id="new-branch-name"
              name="branch"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="feature/sign-in"
              maxLength={200}
              spellCheck={false}
              autoCapitalize="off"
              className="font-mono placeholder:font-sans"
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="new-branch-from">{byCommit ? "Tag or commit" : "Start from"}</FieldLabel>
            {byCommit ? (
              <Input
                id="new-branch-from"
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
                placeholder="v1.2.0 or 9f2c4e1"
                spellCheck={false}
                autoCapitalize="off"
                className="font-mono placeholder:font-sans"
              />
            ) : (
              <Combobox
                id="new-branch-from"
                aria-label="Branch to start from"
                value={from}
                onValueChange={setFrom}
                searchPlaceholder="Find a branch…"
                emptyText="No branch matches."
                className="font-mono"
                options={branches.map((branch) => ({ value: branch, label: branch, icon: <GitBranch /> }))}
              />
            )}
            <FieldDescription>
              <Button type="button" variant="link" size="inline" className="text-xs" onClick={() => setByCommit(!byCommit)}>
                {byCommit ? "Start from a branch instead" : "Start from a tag or commit instead"}
              </Button>
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || name.trim() === "" || source === ""}>
              {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden />}
              Create branch
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

// --- The default branch's protection hint, dismissed per person and repository ---

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const storage = () => (typeof window === "undefined" ? null : window.localStorage);

/**
 * That the default branch has no rules, for people who can add them, until
 * they dismiss it: remembered by this browser for them and this repository.
 */
export function ProtectCallout({ base, main, dismissKey }: { base: string; main: string; dismissKey: string }) {
  const hidden = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return storage()?.getItem(dismissKey) === "1";
      } catch {
        return false;
      }
    }, [dismissKey]),
    () => false,
  );
  if (hidden) return null;
  const dismiss = () => {
    try {
      storage()?.setItem(dismissKey, "1");
    } catch {
      // Not remembered: it hides until the page is opened again.
    }
    for (const listener of listeners) listener();
  };
  return (
    <Alert tone="warn" className="flex flex-wrap items-start gap-3 px-4 py-3">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 grow basis-60">
        <AlertTitle>{main} isn’t protected</AlertTitle>
        <AlertDescription>
          Anyone who can push can push straight to it or force-push over it. Add a ruleset to require pull requests and passing checks before anything lands on it.
        </AlertDescription>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button asChild size="xs" variant="outline">
          <Link to={`${base}/settings/rules/new`}>Protect this branch</Link>
        </Button>
        <Hint label="Dismiss">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismiss}>
            <X size={14} />
          </Button>
        </Hint>
      </div>
    </Alert>
  );
}
