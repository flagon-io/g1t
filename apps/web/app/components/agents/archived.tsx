import { Archive, ArchiveRestore, ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useFetcher, useLocation } from "react-router";

import type { ArchivedAgent } from "@g1t/contracts";

import { AgentAvatar } from "../agent-avatar";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input, InputAddon, InputGroup } from "../ui/input";
import { TimeAgo } from "../ui";
import { confirmsHandle, countsLine } from "../../lib/agents-archived";
import { type ActionResult, useDialogFetcher } from "./dialogs";

/**
 * The Archived section at the foot of the Agents page
 * (docs.g1t.sh/guides/agents/, "Archive, restore and delete"): the
 * workspace's archived agents for an owner, a member's own archived
 * personal agents for anyone else. Folded by default with its count;
 * `#archived` in the address opens it. Each row restores the agent, or
 * deletes it for good after its handle is typed back.
 */
export function ArchivedSection({ slug, agents, owner }: { slug: string; agents: ArchivedAgent[]; owner: boolean }) {
  const { hash } = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hash === "#archived") setOpen(true);
  }, [hash]);
  if (agents.length === 0) return null;
  return (
    <section id="archived" aria-labelledby="archived-heading">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="archived-heading" className="text-sm font-medium">
            <CollapsibleTrigger className="font-medium text-fg">
              <ChevronRight size={14} className="shrink-0 text-faint" />
              <Archive size={14} className="text-faint" />
              Archived <span className="font-normal text-faint">· {agents.length}</span>
            </CollapsibleTrigger>
          </h2>
          <span className="text-xs text-faint">{owner ? "Restore one, or delete it for good" : "Your archived personal agents"}</span>
        </div>
        <CollapsibleContent>
          <Card asChild divided className="mt-3 overflow-hidden">
            <ul>
              {agents.map((agent) => (
                <ArchivedRow key={agent.id} slug={slug} agent={agent} />
              ))}
            </ul>
          </Card>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** One archived agent: its face, dimmed, what it was, when it was archived, what is kept about it, and the two ways out. */
function ArchivedRow({ slug, agent }: { slug: string; agent: ArchivedAgent }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap">
      <span className="shrink-0 opacity-60 grayscale-[0.4]">
        <AgentAvatar agent={{ ...agent, status: null }} size={32} />
      </span>
      <div className="min-w-0 grow basis-48">
        <p className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium text-muted">{agent.display_name}</span>
          <span className="truncate text-faint">@{agent.handle}</span>
          {agent.scope === "personal" && (
            <Badge tone="neutral" className="shrink-0 font-normal">
              {agent.personal_owner ? `@${agent.personal_owner}'s` : "Personal"}
            </Badge>
          )}
        </p>
        <p className="truncate text-xs text-faint">
          {agent.title || agent.role}
          {" · "}
          Archived <TimeAgo at={agent.archived_at} />
          {agent.archived_by && ` by @${agent.archived_by}`}
        </p>
        <p className="truncate text-xs text-faint tabular-nums">{countsLine(agent.counts)}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <RestoreButton slug={slug} agent={agent} />
        <DeleteDialog slug={slug} agent={agent} />
      </div>
    </li>
  );
}

/**
 * Restore, in one press. When a live agent holds the handle now, the
 * service says so (`conflict`) and a dialog asks for a new handle to
 * restore under instead.
 */
function RestoreButton({ slug, agent }: { slug: string; agent: ArchivedAgent }) {
  const fetcher = useFetcher<ActionResult>({ key: `restore-${agent.id}` });
  const [rename, setRename] = useState(false);
  const idle = fetcher.state === "idle";
  const refused = idle && fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  useEffect(() => {
    if (refused?.code === "conflict") setRename(true);
  }, [refused]);
  const busy = !idle;
  return (
    <>
      <fetcher.Form method="post" action={`/${slug}/-/agents?index`} className="flex flex-col items-end gap-1">
        <input type="hidden" name="intent" value="restore" />
        <input type="hidden" name="id" value={agent.id} />
        <input type="hidden" name="handle" value={agent.handle} />
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          <ArchiveRestore size={14} />
          {busy ? "Restoring…" : "Restore"}
        </Button>
        {refused && refused.code !== "conflict" && (
          <p role="alert" className="text-xs text-danger">
            {refused.error}
          </p>
        )}
      </fetcher.Form>
      <RenameDialog slug={slug} agent={agent} open={rename} onOpenChange={setRename} why={refused?.code === "conflict" ? refused.error : null} />
    </>
  );
}

/** The handle is taken by a live agent: restore under a new one. */
function RenameDialog({ slug, agent, open, onOpenChange, why }: { slug: string; agent: ArchivedAgent; open: boolean; onOpenChange: (open: boolean) => void; why: string | null }) {
  const fetcher = useFetcher<ActionResult>({ key: `restore-as-${agent.id}` });
  const id = useId();
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) onOpenChange(false);
  }, [fetcher.state, fetcher.data, onOpenChange]);
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  const busy = fetcher.state !== "idle";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {agent.display_name} under a new handle</DialogTitle>
          <DialogDescription>{why ?? `A live agent is called @${agent.handle} now. Rename that one first, or restore this one under a new handle.`}</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={`/${slug}/-/agents?index`} className="grid gap-5">
          <input type="hidden" name="intent" value="restore" />
          <input type="hidden" name="id" value={agent.id} />
          <input type="hidden" name="handle" value={agent.handle} />
          <Field>
            <FieldLabel htmlFor={`${id}-handle`}>New handle</FieldLabel>
            <InputGroup>
              <InputAddon>@</InputAddon>
              <Input id={`${id}-handle`} name="new_handle" defaultValue={`${agent.handle}-2`} required autoComplete="off" autoFocus />
            </InputGroup>
            <FieldDescription>2 to 32 lowercase letters, digits and hyphens. People mention it by this; its name and face stay.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete permanently: asked once more, with what goes and what stays
 * spelled out, and the handle typed back before the button works.
 */
function DeleteDialog({ slug, agent }: { slug: string; agent: ArchivedAgent }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(`destroy-${agent.id}`);
  const [typed, setTyped] = useState("");
  const id = useId();
  const kept = countsLine(agent.counts);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setTyped("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <Trash2 size={14} />
          Delete permanently
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {agent.display_name} permanently?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This deletes <span className="font-medium text-fg">@{agent.handle}</span> for good: its definition and every version, {kept === "Nothing recorded" ? "what little it recorded" : kept.toLowerCase()}, its drafts and suggestions, its budget and its computer&apos;s disk. There is no undo.
              </p>
              <p>What stays: its messages in chat, shown under the name it had; what it spent, in the month&apos;s totals on the workspace&apos;s statement and on Usage; and the audit log.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fetcher.Form method="post" action={`/${slug}/-/agents?index`} className="grid gap-5">
          <input type="hidden" name="intent" value="destroy" />
          <input type="hidden" name="id" value={agent.id} />
          <input type="hidden" name="handle" value={agent.handle} />
          <Field>
            <FieldLabel htmlFor={`${id}-confirm`}>
              Type <span className="font-mono text-fg">@{agent.handle}</span> to confirm
            </FieldLabel>
            <Input id={`${id}-confirm`} name="confirm" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} aria-describedby={`${id}-confirm-hint`} />
            <FieldDescription id={`${id}-confirm-hint`}>Its handle, so nothing goes by accident.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={busy || !confirmsHandle(typed, agent.handle)}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </fetcher.Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
