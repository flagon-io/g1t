import { CalendarClock, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, useActionData } from "react-router";

import type { Milestone } from "@g1t/contracts";

import { dueInWords, isOverdue, percentDone } from "../lib/labels";
import { cn } from "../lib/cn";
import { ErrorText, SubmitButton, Textarea, usePending } from "./ui";
import { Input } from "./ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** What the milestone forms post back. */
export type MilestoneResult = { intent: string; number?: number; error?: string };

/** When it is due, or that it is late, in words, with an icon. */
export function DueLine({ milestone, today }: { milestone: Milestone; today: Date }) {
  const due = dueInWords(milestone, today);
  if (!due) return <span className="text-faint">No due date</span>;
  return (
    <span className={cn("inline-flex items-center gap-1", isOverdue(milestone, today) ? "text-danger" : "text-muted")}>
      <CalendarClock size={13} className="shrink-0" />
      {due}
    </span>
  );
}

/** "40% complete · 3 open · 2 closed". */
export function ProgressLine({ milestone }: { milestone: Milestone }) {
  return (
    <span className="text-xs text-muted">
      <span className="font-medium text-fg">{percentDone(milestone)}%</span> complete
      <span className="text-faint"> · </span>
      {milestone.openItems} open
      <span className="text-faint"> · </span>
      {milestone.closedItems} closed
    </span>
  );
}

/** Creating a milestone, or editing one: title, due date, description. */
export function MilestoneForm({ milestone, onDone }: { milestone?: Milestone; onDone: () => void }) {
  const intent = milestone ? "edit" : "create";
  const result = useActionData<MilestoneResult>();
  const pending = usePending({ intent });
  const sent = useRef(false);
  const mine = result?.intent === intent;
  useEffect(() => {
    if (sent.current && !pending && mine && !result?.error) onDone();
    sent.current = pending;
  }, [mine, result, pending, onDone]);
  return (
    <Card asChild className="grid gap-3 p-4">
      <Form method="post">
        <input type="hidden" name="intent" value={intent} />
        {milestone && <input type="hidden" name="number" value={milestone.number} />}
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Title</span>
            <Input
              name="title"
              defaultValue={milestone?.title ?? ""}
              required
              maxLength={100}
              autoFocus
              autoComplete="off"
              data-1p-ignore
              placeholder="Launch"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted">Due date (optional)</span>
            <Input type="date" name="dueOn" defaultValue={milestone?.dueOn ?? ""} />
          </label>
        </div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted">Description (optional)</span>
          <Textarea name="description" rows={3} defaultValue={milestone?.description ?? ""} maxLength={4000} />
        </label>
        {mine && result?.error && <ErrorText>{result.error}</ErrorText>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <SubmitButton match={{ intent }} pending="Saving…">
            {milestone ? "Save milestone" : "Create milestone"}
          </SubmitButton>
        </div>
      </Form>
    </Card>
  );
}

/** Closing or reopening a milestone. */
export function MilestoneStateButton({ milestone }: { milestone: Milestone }) {
  const next = milestone.state === "open" ? "closed" : "open";
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="state" />
      <input type="hidden" name="number" value={milestone.number} />
      <input type="hidden" name="state" value={next} />
      <SubmitButton variant="outline" match={{ intent: "state", number: String(milestone.number) }} pending="Saving…">
        {next === "closed" ? "Close" : "Reopen"}
      </SubmitButton>
    </Form>
  );
}

export function DeleteMilestone({ milestone }: { milestone: Milestone }) {
  const deleting = usePending({ intent: "delete", number: String(milestone.number) });
  const items = milestone.openItems + milestone.closedItems;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" disabled={deleting} aria-label={`Delete ${milestone.title}`}>
          {deleting ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} />}
          <span className="hidden sm:inline">{deleting ? "Deleting…" : "Delete"}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="number" value={milestone.number} />
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {milestone.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {items === 0
                ? "Nothing is in it. "
                : `The ${items} ${items === 1 ? "issue or pull request" : "issues and pull requests"} in it stay as they are, in no milestone. `}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <button type="submit">
                <Trash2 size={14} />
                Delete milestone
              </button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
