/**
 * Memory, as a project's and a workspace's pages show it: what agents and
 * people learned, each with where it came from, to pin, edit or forget.
 * Both pages post to their own action with the intents in `memoryAction`.
 */
import { Bot, Brain, Pencil, Pin, PinOff, Trash2, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import { MEMORY_KINDS, type Memory, type MemoryKind, type MemoryScope, type Result, type User as Actor } from "@g1t/contracts";

import { TimeAgo } from "./ui";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

const KIND: Record<MemoryKind, { label: string; about: string; tone: string }> = {
  fact: { label: "Fact", about: "How something is", tone: "text-info border-info/40" },
  convention: { label: "Convention", about: "How things are done here", tone: "text-accent border-accent/40" },
  decision: { label: "Decision", about: "Something chosen, and why", tone: "text-merged border-merged/40" },
  gotcha: { label: "Gotcha", about: "A trap to avoid", tone: "text-warn border-warn/40" },
};

const TEXTAREA =
  "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";

type Done = { ok: boolean; error?: string } | undefined;

function KindBadge({ kind }: { kind: MemoryKind }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-px text-[0.6875rem] ${KIND[kind].tone}`}>
      {KIND[kind].label}
    </span>
  );
}

function KindSelect({ value }: { value?: MemoryKind }) {
  return (
    <Select name="kind" defaultValue={value ?? "fact"}>
      <SelectTrigger size="sm" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MEMORY_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind} description={KIND[kind].about}>
            {KIND[kind].label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Where a memory came from, linked where it can be. */
function Source({ memory }: { memory: Memory }) {
  const { source } = memory;
  const repo = source.repo;
  const where =
    repo && source.number != null ? (
      <>
        {" "}
        on{" "}
        <Link to={`/${repo.namespace}/${repo.name}/pull/${source.number}`} className="hover:text-fg">
          {memory.scope === "workspace" && `${repo.name}`}#{source.number}
        </Link>
      </>
    ) : repo && memory.scope === "workspace" ? (
      <>
        {" "}
        in <Link to={`/${repo.namespace}/${repo.name}`} className="hover:text-fg">{repo.name}</Link>
      </>
    ) : null;
  if (source.kind === "person") {
    return (
      <span className="inline-flex items-center gap-1">
        <User size={11} />
        {memory.createdBy}
        {where}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Bot size={11} />
      {source.runId && repo ? (
        <Link to={`/${repo.namespace}/${repo.name}/agents/runs/${source.runId}`} className="hover:text-fg">
          {memory.createdBy}'s run
        </Link>
      ) : (
        memory.createdBy
      )}
      {where}
    </span>
  );
}

function EditMemory({ memory, action }: { memory: Memory; action: string }) {
  const fetcher = useFetcher<Done>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger aria-label="Edit" className="rounded p-1 text-faint transition-colors hover:bg-raised hover:text-fg">
        <Pencil size={13} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit memory</DialogTitle>
          <DialogDescription>Agents get the new wording from their next run on.</DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="space-y-3">
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="id" value={memory.id} />
          <textarea name="text" required rows={4} maxLength={1000} defaultValue={memory.text} className={TEXTAREA} />
          <div className="flex items-center justify-between gap-3">
            <KindSelect value={memory.kind} />
            <button
              type="submit"
              disabled={fetcher.state !== "idle"}
              className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {fetcher.data?.error && <p className="text-sm text-danger">{fetcher.data.error}</p>}
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function MemoryItem({ memory, action, editable }: { memory: Memory; action: string; editable: boolean }) {
  const fetcher = useFetcher<Done>();
  const pinned = fetcher.formData ? fetcher.formData.get("pinned") === "true" : memory.pinned;
  const gone = fetcher.formData?.get("intent") === "delete";
  if (gone) return null;
  return (
    <li className="group flex gap-3 px-4 py-3">
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={memory.kind} />
          {pinned && (
            <span className="inline-flex items-center gap-1 text-[0.6875rem] text-accent">
              <Pin size={11} />
              pinned
            </span>
          )}
        </div>
        <p className="mt-1.5 text-sm whitespace-pre-wrap">{memory.text}</p>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <Source memory={memory} />
          <span>
            added <TimeAgo at={memory.createdAt} />
          </span>
          <span>{memory.lastUsedAt ? <>given to an agent <TimeAgo at={memory.lastUsedAt} /></> : "not given to an agent yet"}</span>
        </p>
        {fetcher.data?.error && <p className="mt-1.5 text-xs text-danger">{fetcher.data.error}</p>}
      </div>
      {editable && (
        <div className="flex shrink-0 items-start gap-0.5">
          <button
            type="button"
            aria-label={pinned ? "Unpin" : "Pin"}
            title={pinned ? "Unpin" : "Pin: given to every agent first"}
            onClick={() => fetcher.submit({ intent: "update", id: memory.id, pinned: String(!pinned) }, { method: "post", action })}
            className="rounded p-1 text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <EditMemory memory={memory} action={action} />
          <AlertDialog>
            <AlertDialogTrigger aria-label="Forget" className="rounded p-1 text-faint transition-colors hover:bg-raised hover:text-danger">
              <Trash2 size={13} />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Forget this?</AlertDialogTitle>
                <AlertDialogDescription>
                  No agent is given it again. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction onClick={() => fetcher.submit({ intent: "delete", id: memory.id }, { method: "post", action })}>
                  Forget
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </li>
  );
}

export function MemoryList({
  memories,
  action,
  editable,
  empty,
}: {
  memories: Memory[];
  action: string;
  editable: boolean;
  empty: string;
}) {
  if (memories.length === 0) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
      {memories.map((memory) => (
        <MemoryItem key={memory.id} memory={memory} action={action} editable={editable} />
      ))}
    </ul>
  );
}

/** A form to add a memory at one level. */
export function AddMemory({ scope, action, placeholder }: { scope: MemoryScope; action: string; placeholder: string }) {
  const fetcher = useFetcher<Done>();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <fetcher.Form ref={form} method="post" action={action} className="rounded-xl border border-line bg-surface p-4">
      <input type="hidden" name="intent" value="add" />
      <input type="hidden" name="scope" value={scope} />
      <label className="flex items-center gap-2 text-sm font-medium">
        <Brain size={15} className="text-merged" />
        Add to {scope === "workspace" ? "the workspace's" : "this project's"} memory
      </label>
      <textarea name="text" required rows={2} maxLength={1000} placeholder={placeholder} className={`${TEXTAREA} mt-3`} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <KindSelect />
        <label className="flex items-center gap-2 text-xs text-muted">
          <Switch name="pinned" value="true" size="sm" />
          Pin it
        </label>
        <span className="grow" />
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white disabled:opacity-50"
        >
          {fetcher.state !== "idle" ? "Adding…" : "Add"}
        </button>
      </div>
      {fetcher.data?.error && <p className="mt-2 text-sm text-danger">{fetcher.data.error}</p>}
      <p className="mt-2 text-xs text-faint">
        One fact, convention, decision or gotcha each. Never a secret: say where it lives instead, and
        g1t refuses anything that looks like a key or a token.
      </p>
    </fetcher.Form>
  );
}

type MemoryApi = {
  addMemory(actor: Actor, workspace: string, memory: { scope: MemoryScope; repo?: { namespace: string; name: string } | null; text: string; kind?: MemoryKind; pinned?: boolean }): Promise<Result<Memory>>;
  updateMemory(actor: Actor, workspace: string, id: string, change: { text?: string; kind?: MemoryKind; pinned?: boolean }): Promise<Result<Memory>>;
  deleteMemory(actor: Actor, workspace: string, id: string): Promise<Result<boolean>>;
};

/** The action both memory pages share: add, update and delete. */
export async function memoryAction(
  api: MemoryApi,
  actor: Actor,
  workspace: string,
  repo: { namespace: string; name: string } | null,
  form: FormData,
): Promise<Done> {
  const intent = String(form.get("intent") ?? "");
  const kindValue = String(form.get("kind") ?? "");
  const kind = MEMORY_KINDS.includes(kindValue as MemoryKind) ? (kindValue as MemoryKind) : undefined;
  if (intent === "add") {
    const scope: MemoryScope = form.get("scope") === "workspace" ? "workspace" : "project";
    const added = await api.addMemory(actor, workspace, {
      scope,
      repo,
      text: String(form.get("text") ?? ""),
      kind,
      pinned: form.get("pinned") === "true",
    });
    return added.ok ? { ok: true } : { ok: false, error: added.error.message };
  }
  if (intent === "update") {
    const pinned = form.get("pinned");
    const text = form.get("text");
    const changed = await api.updateMemory(actor, workspace, String(form.get("id") ?? ""), {
      text: text == null ? undefined : String(text),
      kind,
      pinned: pinned == null ? undefined : pinned === "true",
    });
    return changed.ok ? { ok: true } : { ok: false, error: changed.error.message };
  }
  if (intent === "delete") {
    const gone = await api.deleteMemory(actor, workspace, String(form.get("id") ?? ""));
    return gone.ok ? { ok: true } : { ok: false, error: gone.error.message };
  }
  return { ok: false, error: "Unknown action." };
}
