/**
 * A work item's sub-items, drawn on its page: the list with how far along
 * they are, adding and removing one, and closing a parent that still has
 * open ones, which asks what becomes of them. What each posts is read by
 * the work item's action (routes/workspace/work/item.tsx).
 */
import { Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Form, Link } from "react-router";

import type { CloseReason, ItemBrief, SubItemProgress } from "@g1t/contracts";

import { ErrorText, Input, SubmitButton } from "./ui";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Field, FieldError, FieldLabel } from "./ui/field";
import { Hint } from "./ui/hint";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Progress } from "./ui/progress";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { ItemIcon } from "./work-icons";
import { itemPath, subItemsDone, subItemsShare } from "../lib/work-items";

/** How far along a parent's sub-items are, as a bar and "3 of 7 done". */
export function SubItemsProgress({ progress }: { progress: SubItemProgress }) {
  const finished = progress.done >= progress.total;
  return (
    <span className="flex items-center gap-2 text-sm text-muted">
      <Progress
        value={subItemsShare(progress)}
        aria-label={`Sub-items: ${subItemsDone(progress)}`}
        className="h-1.5 w-20 sm:w-28"
        indicatorClassName={finished ? "bg-merged" : undefined}
      />
      <span className={finished ? "text-merged" : undefined}>{subItemsDone(progress)}</span>
    </span>
  );
}

/**
 * A work item's Sub-items: each with its state, how far along they are,
 * and for whoever may change them, adding one by number (or opening a new
 * one under it) and taking one out.
 */
export function SubItemsSection({
  workspace,
  subItems,
  progress,
  canEdit,
  newPath,
  error,
}: {
  workspace: string;
  /** Those the viewer may see. */
  subItems: ItemBrief[];
  progress: SubItemProgress | null | undefined;
  canEdit: boolean;
  /** A new work item filed under this one. */
  newPath: string;
  error?: string | null;
}) {
  // The progress counts every sub-item; some may not be the viewer's to see.
  const unseen = Math.max(0, (progress?.total ?? 0) - subItems.length);
  return (
    <section aria-labelledby="sub-items" className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sub-items" className="font-semibold tracking-tight">
          Sub-items
        </h2>
        <span className="flex items-center gap-3">
          {progress && progress.total > 0 && <SubItemsProgress progress={progress} />}
          {canEdit && <AddSubItem newPath={newPath} />}
        </span>
      </div>
      {subItems.length === 0 && unseen === 0 ? (
        <p className="mt-2 text-sm text-muted">None yet. Break the work into smaller work items that each close on their own.</p>
      ) : (
        <Card asChild divided className="mt-3">
          <ul>
            {subItems.map((sub) => (
              <li key={sub.number} className={`flex items-center gap-2.5 px-3 py-2 sm:px-4 ${sub.state === "closed" ? "opacity-70" : ""}`}>
                <ItemIcon item={{ state: sub.state, reason: null }} size={15} />
                <Link to={itemPath(workspace, sub.number)} prefetch="intent" className="min-w-0 grow truncate text-sm hover:text-accent">
                  {sub.title} <span className="text-faint">#{sub.number}</span>
                </Link>
                {canEdit && (
                  <Form method="post" className="shrink-0">
                    <input type="hidden" name="action" value="remove-sub-item" />
                    <input type="hidden" name="sub_item" value={sub.number} />
                    <Hint label={`Take #${sub.number} out of the sub-items`}>
                      <Button type="submit" variant="ghost" size="icon-xs" aria-label={`Take #${sub.number} out of the sub-items`} className="max-sm:size-9">
                        <X size={14} />
                      </Button>
                    </Hint>
                  </Form>
                )}
              </li>
            ))}
            {unseen > 0 && (
              <li className="px-3 py-2 text-xs text-faint sm:px-4">{unseen === 1 ? "1 more you cannot see." : `${unseen} more you cannot see.`}</li>
            )}
          </ul>
        </Card>
      )}
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </section>
  );
}

/** Adding a sub-item: one that exists, by number, or a new one filed under it. */
function AddSubItem({ newPath }: { newPath: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          Add sub-item
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Form method="post" className="space-y-2.5">
          <input type="hidden" name="action" value="add-sub-item" />
          <Label htmlFor="add-sub-item">Work item</Label>
          <Input id="add-sub-item" name="sub_item" placeholder="#230" autoComplete="off" required />
          <p className="text-xs text-muted">A work item of this workspace. One that is a sub-item of another moves here.</p>
          <div className="flex items-center justify-between gap-2">
            <SubmitButton size="sm" match={{ action: "add-sub-item" }} pending="Adding…">
              Add
            </SubmitButton>
            <Link to={newPath} className="text-xs text-muted hover:text-fg hover:underline">
              Open a new one
            </Link>
          </div>
        </Form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Closing a work item: a plain button, or, while it has open sub-items,
 * one that asks first what becomes of them (left open, closed too, or
 * moved to another work item), so none close silently. It opens by itself
 * with `error` when closing was refused for them.
 */
export function CloseButton({
  reason,
  openSubItems,
  error,
  className,
  children,
}: {
  reason: CloseReason;
  /** How many of its sub-items are open. */
  openSubItems: number;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const intent = reason === "not_planned" ? "close-not-planned" : "close-completed";
  const [open, setOpen] = useState(Boolean(error));
  // Refused for its open sub-items: the choices come up, with why.
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  if (openSubItems === 0 && !error) {
    return (
      <Form method="post" className={className}>
        <SubmitButton variant="outline" name="action" value={intent} pending="Closing…">
          {children}
        </SubmitButton>
      </Form>
    );
  }
  return (
    <>
      <span className={className}>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {children}
        </Button>
      </span>
      <CloseDialog reason={reason} openSubItems={openSubItems} error={error} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The dialog that closes a work item, opened by its caller: `CloseButton`
 * while it has open sub-items, which asks what becomes of them; or the
 * page's ⋯ menu and Shift C, which also ask how it ended (`chooseReason`).
 */
export function CloseDialog({
  reason,
  openSubItems,
  error,
  open,
  onOpenChange,
  chooseReason = false,
}: {
  reason: CloseReason;
  openSubItems: number;
  error?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ask how it ended, completed or not planned, starting from `reason`. */
  chooseReason?: boolean;
}) {
  const [ended, setEnded] = useState<CloseReason>(reason);
  useEffect(() => {
    if (open) setEnded(reason);
  }, [open, reason]);
  const intent = ended === "not_planned" ? "close-not-planned" : "close-completed";
  const [choice, setChoice] = useState("leave");
  const them = openSubItems === 1 ? "it" : "them";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <Form method="post" className="grid gap-5" onSubmit={() => openSubItems === 0 && !error && onOpenChange(false)}>
          <input type="hidden" name="action" value={intent} />
          <DialogHeader>
            <DialogTitle>{!chooseReason && ended === "not_planned" ? "Close as not planned" : "Close work item"}</DialogTitle>
            <DialogDescription>
              {openSubItems === 1
                ? "It has an open sub-item. Say what becomes of it."
                : openSubItems > 1
                  ? `It has ${openSubItems} open sub-items. Say what becomes of them.`
                  : chooseReason
                    ? "Its claims are released, and it leaves the plan. It can be reopened."
                    : "It has open sub-items. Say what becomes of them."}
            </DialogDescription>
          </DialogHeader>
          {chooseReason && (
            <RadioGroup value={ended} onValueChange={(value) => setEnded(value as CloseReason)} aria-label="How it ended">
              <RadioOption value="completed" label="Completed" description="Done: what it asked for is so." />
              <RadioOption value="not_planned" label="Not planned" description="It will not be done: a duplicate, out of scope, or no longer wanted." />
            </RadioGroup>
          )}
          {openSubItems > 0 && (
            <RadioGroup name="sub_items" value={choice} onValueChange={setChoice} aria-label="Its open sub-items">
              <RadioOption value="leave" label={`Leave ${them} open`} description="They stay sub-items of this one." />
              <RadioOption
                value="close"
                label={`Close ${them} too`}
                description={`As ${ended === "not_planned" ? "not planned" : "completed"}, and their own sub-items with them.`}
              />
              <RadioOption value="move" label={`Move ${them} to another work item`} description="They become its sub-items instead." />
            </RadioGroup>
          )}
          {openSubItems > 0 && choice === "move" && (
            <Field>
              <FieldLabel htmlFor={`${intent}-move-to`}>Move to</FieldLabel>
              <Input id={`${intent}-move-to`} name="move_to" placeholder="#212" autoComplete="off" required />
            </Field>
          )}
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <SubmitButton match={{ action: intent }} pending="Closing…">
              {chooseReason && ended === "not_planned" ? "Close as not planned" : "Close"}
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
