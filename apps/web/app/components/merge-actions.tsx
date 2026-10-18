import { ChevronDown, CircleDot, GitBranch, GitMerge, GitPullRequestArrow, RotateCcw, Trash2, Zap } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link, useSubmit } from "react-router";

import type { AutoMerge, MergeMethod, Pull, UpdateMethod } from "@g1t/contracts";

import { type MergeChoicesView, METHOD_INFO, rememberMethod, rememberedMethod, writesMessage } from "../lib/merge";
import { ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Button } from "./ui/button";
import { CheckboxOption } from "./ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Field, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { PersonLink } from "./work";
import { itemPath } from "../lib/refs";

/** The trigger half of a split button: the chevron that opens its menu. */
function SplitTrigger({ label, variant, disabled }: { label: string; variant: "accent" | "outline"; disabled?: boolean }) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <Button
        type="button"
        variant={variant}
        size="icon"
        aria-label={label}
        className={`w-8 rounded-l-none ${variant === "accent" ? "border-l border-bg/30" : "-ml-px"}`}
      >
        <ChevronDown size={15} />
      </Button>
    </DropdownMenuTrigger>
  );
}

/** Why a method cannot be used on this pull request now, if it cannot. */
function methodBlocked(method: MergeMethod, choices: MergeChoicesView, base: string): string | null {
  const said = choices.unavailable?.[method];
  if (said) return said;
  if (method === "fast_forward" && (choices.behind || !choices.canFastForward)) {
    return `Fast-forward needs the branch to contain every commit of ${base}: update it first.`;
  }
  return null;
}

/** The methods to choose from, each with what it does; one that cannot be used now says why. */
function MethodMenu({
  choices,
  method,
  onPick,
  base,
  heading,
}: {
  choices: MergeChoicesView;
  method: MergeMethod;
  onPick: (method: MergeMethod) => void;
  base: string;
  heading: string;
}) {
  return (
    <DropdownMenuContent align="end" className="w-80">
      <DropdownMenuLabel>{heading}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={method} onValueChange={(value) => onPick(value as MergeMethod)}>
        {choices.methods.map((option) => {
          const blocked = methodBlocked(option, choices, base);
          return (
            <DropdownMenuRadioItem key={option} value={option} disabled={blocked != null} className="items-start py-2">
              <span className="min-w-0">
                <span className="block font-medium">{METHOD_INFO[option].action}</span>
                <span className="mt-0.5 block text-xs text-muted">{blocked ?? METHOD_INFO[option].about}</span>
              </span>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  );
}

/**
 * The merge button: the method the viewer used here last (or the
 * repository's default) with a menu of the others, then a confirm step to
 * write the commit's message and choose what happens to the branch. When it
 * cannot merge yet and the repository allows it, auto-merge is offered in its
 * place. Inside the pull request's merge <Form>; `options` are the boxes
 * (bypass checks, bypass rules) shown above the button.
 */
export function MergeButton({
  repo,
  pull,
  choices,
  base,
  blocked,
  queue,
  canAutoMerge,
  item,
  options,
  error,
}: {
  /** `owner/name`, under which the viewer's last method is remembered. */
  repo: string;
  pull: Pull;
  choices: MergeChoicesView;
  base: string;
  /** Why it cannot merge now, if it cannot. */
  blocked: string | null;
  /** It merges through the merge queue, which picks the method. */
  queue: boolean;
  /** The viewer may turn auto-merge on: they may merge it. */
  canAutoMerge: boolean;
  /** The open work item it is for, which merging lands unless kept open. */
  item: { number: number } | null;
  options?: ReactNode;
  error?: string | null;
}) {
  const usable = choices.methods.filter((option) => methodBlocked(option, choices, base) == null);
  const fallback = usable.includes(choices.defaultMethod) ? choices.defaultMethod : (usable[0] ?? choices.defaultMethod);
  const [method, setMethod] = useState<MergeMethod>(fallback);
  // The viewer's last choice here, once the page is in the browser.
  useEffect(() => {
    const remembered = rememberedMethod(repo, usable);
    if (remembered) setMethod(remembered);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, and when what is usable changes
  }, [repo, usable.join()]);
  const chosen = usable.includes(method) ? method : fallback;
  const pick = (next: MergeMethod) => {
    setMethod(next);
    rememberMethod(repo, next);
  };
  // `merge` or `auto` while its confirm step is open.
  const [confirming, setConfirming] = useState<"merge" | "auto" | null>(null);
  const auto = blocked != null && choices.autoMergeAllowed && canAutoMerge && !pull.autoMerge && !queue;

  if (queue) {
    return (
      <div className="space-y-3">
        {options}
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
          <Hint label={blocked} disabled={blocked != null}>
            <SubmitButton variant="accent" name="action" value="merge" disabled={blocked != null} pending="Adding to the queue…">
              <GitMerge size={15} />
              Add to the merge queue
            </SubmitButton>
          </Hint>
          <span className={`text-xs ${blocked ? "text-danger" : "text-muted"}`}>
            {blocked ?? `Tested together with everything ahead of it, then lands on ${base}.`}
          </span>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    );
  }

  if (confirming) {
    return (
      <ConfirmMerge
        mode={confirming}
        method={chosen}
        choices={choices}
        pull={pull}
        base={base}
        repo={repo}
        item={item}
        blocked={confirming === "merge" ? blocked : null}
        options={confirming === "merge" ? options : null}
        error={error}
        onCancel={() => setConfirming(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      {options}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <div className="flex">
              <Hint label={blocked} disabled={blocked != null}>
                <Button
                  type="button"
                  variant={auto ? "outline" : "accent"}
                  disabled={blocked != null || usable.length === 0}
                  onClick={() => setConfirming("merge")}
                  className="rounded-r-none"
                >
                  <GitMerge size={15} />
                  {METHOD_INFO[chosen].action}
                </Button>
              </Hint>
              <SplitTrigger label="Choose how to merge" variant={auto ? "outline" : "accent"} />
            </div>
            <MethodMenu choices={choices} method={chosen} onPick={pick} base={base} heading="Merge with" />
          </DropdownMenu>
          {auto && (
            <Button type="button" variant="accent" onClick={() => setConfirming("auto")}>
              <Zap size={15} />
              Enable auto-merge
            </Button>
          )}
        </div>
        <span className={`text-xs ${blocked ? "text-danger" : "text-muted"}`}>
          {blocked ??
            (pull.closes?.length
              ? `Closes ${pull.closes.map((number) => `#${number}`).join(", ")}.`
              : `Lands its commits on ${base}.`)}
          {blocked && auto && <span className="text-muted"> Or turn on auto-merge to land it once it can.</span>}
        </span>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/**
 * The commit's title and message when the work service could not say what
 * they default to: left empty, and only what the merger types is sent. An
 * untouched field is not sent at all, so the service writes the repository's
 * default for it, from the pull request's commits.
 */
function UnwrittenMessage() {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <>
      <Field>
        <FieldLabel htmlFor="commit-title">Commit title</FieldLabel>
        <Input
          id="commit-title"
          name={title.trim() ? "commitTitle" : undefined}
          maxLength={500}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="The repository's default title"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="commit-message">Commit message</FieldLabel>
        <Textarea
          id="commit-message"
          name={body.trim() ? "commitMessage" : undefined}
          rows={6}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="The repository's default message"
          className="font-mono text-xs"
        />
      </Field>
    </>
  );
}

/** The confirm step: the commit's message, the branch, and the work items it closes. */
function ConfirmMerge({
  mode,
  method: initial,
  choices,
  pull,
  base,
  repo,
  item,
  blocked,
  options,
  error,
  onCancel,
}: {
  mode: "merge" | "auto";
  method: MergeMethod;
  choices: MergeChoicesView;
  pull: Pull;
  base: string;
  repo: string;
  item: { number: number } | null;
  blocked: string | null;
  options?: ReactNode;
  error?: string | null;
  onCancel: () => void;
}) {
  // Auto-merge happens later, when the branch may be up to date: every method is offered.
  const [method, setMethod] = useState(initial);
  const message = choices.messages[method];
  const [keepOpen, setKeepOpen] = useState(false);
  const closes = keepOpen ? (pull.closes ?? []).filter((number) => number !== item?.number) : (pull.closes ?? []);
  const deletable = choices.canDeleteBranch ?? (pull.branch != null && !pull.fork);
  return (
    <div className="space-y-4">
      <input type="hidden" name="mergeMethod" value={method} />
      {pull.headCommit && <input type="hidden" name="expectedHead" value={pull.headCommit} />}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{mode === "auto" ? "Enable auto-merge with" : "Merge with"}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {METHOD_INFO[method].action}
              <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <MethodMenu
            choices={mode === "auto" ? { ...choices, behind: false, canFastForward: true, unavailable: {} } : choices}
            method={method}
            onPick={setMethod}
            base={base}
            heading={mode === "auto" ? "Once it can merge, merge with" : "Merge with"}
          />
        </DropdownMenu>
      </div>
      {writesMessage(method) ? (
        // Keyed to the method, so switching starts from that method's default.
        <div key={method} className="space-y-3">
          {message ? (
            <>
              <Field>
                <FieldLabel htmlFor="commit-title">Commit title</FieldLabel>
                <Input id="commit-title" name="commitTitle" required maxLength={500} defaultValue={message.title} />
              </Field>
              <Field>
                <FieldLabel htmlFor="commit-message">Commit message</FieldLabel>
                <Textarea id="commit-message" name="commitMessage" rows={6} defaultValue={message.message} className="font-mono text-xs" />
              </Field>
            </>
          ) : (
            <UnwrittenMessage />
          )}
          {choices.signOff && (
            <p className="text-xs text-faint">
              This repository asks for sign-off: a <span className="font-mono">Signed-off-by:</span> line for you is added.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">{METHOD_INFO[method].about} No commit message to write.</p>
      )}
      <div className="space-y-2">
        {mode === "merge" && deletable && (
          <>
            <input type="hidden" name="deleteBranchAsked" value="1" />
            <CheckboxOption
              name="deleteBranch"
              defaultChecked={choices.deleteBranchDefault}
              label={
                <>
                  Delete <span className="font-mono">{pull.branch}</span> after merging
                </>
              }
              description="It can be restored from this pull request."
              labelClassName="text-xs"
            />
          </>
        )}
        {mode === "merge" && item && (
          <CheckboxOption
            name="keepItemOpen"
            checked={keepOpen}
            onCheckedChange={(checked) => setKeepOpen(checked === true)}
            label={`Keep #${item.number} open. This is only part of the work.`}
            labelClassName="text-xs text-muted"
          />
        )}
        {options}
      </div>
      {closes.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <CircleDot size={13} className="text-success" />
          {mode === "auto" ? "Once merged, closes" : "Closes"}
          {closes.map((number) => (
            <Link key={number} to={itemPath(repo.split("/")[0]!, number)} className="font-medium text-fg hover:underline">
              #{number}
            </Link>
          ))}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Hint label={blocked} disabled={blocked != null}>
        <SubmitButton
          variant="accent"
          name="action"
          disabled={blocked != null}
          value={mode === "auto" ? "auto-merge-on" : "merge"}
          pending={mode === "auto" ? "Enabling…" : "Merging…"}
        >
          {mode === "auto" ? <Zap size={15} /> : <GitMerge size={15} />}
          {mode === "auto" ? "Confirm auto-merge" : `Confirm ${METHOD_INFO[method].action.replace(/^Create a /, "").toLowerCase()}`}
        </SubmitButton>
        </Hint>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/** Auto-merge is on: who turned it on, how it will merge, and turning it off. */
export function AutoMergeBanner({ auto, canChange }: { auto: AutoMerge; canChange: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <Zap size={16} className="shrink-0 text-accent" />
      <div className="min-w-0 grow">
        <p className="font-medium">
          Auto-merge enabled by <PersonLink name={auto.enabledBy} className="hover:underline" />{" "}
          <span className="font-normal text-muted">· {METHOD_INFO[auto.method].action.toLowerCase()}</span>
        </p>
        <p className="mt-0.5 text-muted">
          It merges on its own once every review and check it needs has passed. Turned on <TimeAgo at={auto.enabledAt} />.
        </p>
      </div>
      {canChange && (
        <Form method="post">
          <SubmitButton variant="outline" size="sm" name="action" value="auto-merge-off" pending="Disabling…">
            Disable auto-merge
          </SubmitButton>
        </Form>
      )}
    </div>
  );
}

/**
 * Bringing a branch up to date: with a merge commit (the button), or a
 * rebase (its menu). Each refuses if the branch moved since the page loaded.
 */
export function UpdateBranchButton({ head, base }: { head: string | null; base: string }) {
  const submit = useSubmit();
  const update = (method: UpdateMethod) =>
    submit({ action: "update", updateMethod: method, ...(head ? { expectedHead: head } : {}) }, { method: "post" });
  return (
    <Form method="post" className="mt-2 flex">
      <input type="hidden" name="action" value="update" />
      <input type="hidden" name="updateMethod" value="merge" />
      {head && <input type="hidden" name="expectedHead" value={head} />}
      <DropdownMenu>
        <SubmitButton variant="outline" size="sm" match={{ action: "update" }} pending="Updating…" className="rounded-r-none">
          <GitPullRequestArrow size={14} />
          Update branch
        </SubmitButton>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Choose how to update" className="-ml-px rounded-l-none">
            <ChevronDown size={14} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuItem onSelect={() => update("merge")} className="items-start py-2">
            <span>
              <span className="block font-medium">Update with merge commit</span>
              <span className="mt-0.5 block text-xs text-muted">
                Merges {base} into the branch. Its commits stay as they are.
              </span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => update("rebase")} className="items-start py-2">
            <span>
              <span className="block font-medium">Update with rebase</span>
              <span className="mt-0.5 block text-xs text-muted">
                Makes its commits again on top of {base}. Anyone with the branch checked out has to reset to it.
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Form>
  );
}

/** A merged or closed pull request's branch: delete it, or restore it once deleted. */
export function BranchAfterwards({
  pull,
  merged,
  canChange,
  error,
}: {
  pull: Pull;
  merged: boolean;
  canChange: boolean;
  error?: string | null;
}) {
  if (!pull.branch || pull.fork) return null;
  const deleted = Boolean(pull.headBranchDeleted);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <GitBranch size={16} className={`shrink-0 ${deleted ? "text-faint" : "text-merged"}`} />
      <div className="min-w-0 grow">
        <p className="font-medium">
          {deleted ? (
            <>
              <span className="font-mono">{pull.branch}</span> was deleted
            </>
          ) : merged ? (
            "Merged and closed: the branch can be deleted safely"
          ) : (
            <>
              <span className="font-mono">{pull.branch}</span> is still there
            </>
          )}
        </p>
        <p className="mt-0.5 text-muted">
          {deleted
            ? `It can be made again at ${pull.headCommit?.slice(0, 7) ?? "its last commit"}, where it was.`
            : merged
              ? "Everything on it is in its base now."
              : "Closed without merging. Deleting it can be undone here."}
        </p>
      </div>
      {canChange && (
        <Form method="post">
          {deleted ? (
            <SubmitButton variant="outline" size="sm" name="action" value="restore-branch" pending="Restoring…">
              <RotateCcw size={14} />
              Restore branch
            </SubmitButton>
          ) : (
            <SubmitButton variant="outline" size="sm" name="action" value="delete-branch" pending="Deleting…">
              <Trash2 size={14} />
              Delete branch
            </SubmitButton>
          )}
        </Form>
      )}
      {error && (
        <div className="w-full">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </div>
  );
}
