import { FileText, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { FoliosSidebar, Result } from "@g1t/contracts";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Field, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { SelectField } from "../ui/select";
import { ORCHESTRATOR, type WritableSpace, type WriteUpAgent, type WriteUpWhere, defaultWhere, writableSpaces, writeUpMessage } from "../../lib/write-up";

// "Write this up as an artifact" (docs/ARTIFACTS_MODE.md section 4.4):
// where it goes, a title if you have one, and which agent writes it. The
// kind is a doc for now. Sending posts the ask in the thread, as you,
// where everyone sees it; the agent answers it as it answers any mention,
// and links the artifact it made.

type Spaces = { state: "loading" } | { state: "ready"; spaces: WritableSpace[] } | { state: "failed"; message: string };

export function WriteUpDialog({
  open,
  onOpenChange,
  slug,
  agents,
  link,
  shared,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  /** Who can write it: @g1t, then the conversation's agents (lib/write-up.ts `writeUpAgents`). */
  agents: WriteUpAgent[];
  /** The thread's link, cited as the source. */
  link: string;
  /** A DM or a private channel: "Shared with this conversation" is offered, and chosen first. */
  shared: boolean;
  /** Posts the ask in the thread; answers with what went wrong, or null. */
  onSend: (body: string) => Promise<string | null>;
}) {
  const [spaces, setSpaces] = useState<Spaces>({ state: "loading" });
  const [where, setWhere] = useState<string>("private");
  const [agent, setAgent] = useState(ORCHESTRATOR);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The spaces, read each time it opens: one may have been made meanwhile.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setSpaces({ state: "loading" });
    setError(null);
    setTitle("");
    setAgent(ORCHESTRATOR);
    (async () => {
      let list: WritableSpace[] = [];
      try {
        const response = await fetch(`/${slug}/-/artifacts/api`);
        const result = (await response.json()) as Result<FoliosSidebar>;
        if (!live) return;
        if (!result.ok) setSpaces({ state: "failed", message: result.error.message });
        else {
          list = writableSpaces(result.value.spaces);
          setSpaces({ state: "ready", spaces: list });
        }
      } catch {
        if (live) setSpaces({ state: "failed", message: "Couldn't load your spaces. Private and this conversation still work." });
      }
      if (!live) return;
      const first = defaultWhere(shared, list);
      setWhere(first.kind === "space" ? first.id : first.kind);
    })();
    return () => {
      live = false;
    };
  }, [open, slug, shared]);

  const list = spaces.state === "ready" ? spaces.spaces : [];
  const space = list.find((s) => s.id === where);
  const chosen: WriteUpWhere | null = where === "private" ? { kind: "private" } : where === "conversation" ? { kind: "conversation" } : space ? { kind: "space", id: space.id, name: space.name } : null;
  const writer = agents.find((a) => a.handle === agent) ?? agents[0] ?? { handle: ORCHESTRATOR, name: ORCHESTRATOR };
  const body = chosen ? writeUpMessage({ agent: writer.handle, where: chosen, title, link }) : null;

  const submit = async () => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    const failed = await onSend(body);
    setBusy(false);
    if (failed) return setError(failed);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Write this up as an artifact</DialogTitle>
          <DialogDescription>An agent turns this thread into a doc: what was decided, why, and what's next, with a link back here.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="write-up-where">Where</FieldLabel>
            {spaces.state === "loading" ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-faint">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                Loading spaces…
              </div>
            ) : (
              <SelectField
                id="write-up-where"
                value={where}
                onValueChange={setWhere}
                options={[
                  ...(shared ? [{ value: "conversation", label: "Shared with this conversation" }] : []),
                  { value: "private", label: "Private (just me)" },
                  ...list.map((s) => ({ value: s.id, label: s.name })),
                ]}
              />
            )}
            {spaces.state === "failed" && <FieldError>{spaces.message}</FieldError>}
          </Field>
          <Field>
            <FieldLabel htmlFor="write-up-title">
              Title <span className="font-normal text-faint">(optional)</span>
            </FieldLabel>
            <Input id="write-up-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Left to the agent" maxLength={120} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel htmlFor="write-up-agent">Written by</FieldLabel>
            <SelectField
              id="write-up-agent"
              value={writer.handle}
              onValueChange={setAgent}
              options={agents.map((a) => ({ value: a.handle, label: a.name === a.handle ? `@${a.handle}` : `${a.name} (@${a.handle})` }))}
            />
          </Field>
          {body && (
            <div className="rounded-lg border border-line bg-bg/60 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted">
                <FileText size={13} aria-hidden="true" />
                Posts in this thread, as you
              </p>
              <p className="text-[0.8125rem] leading-snug break-words text-fg-soft">{body}</p>
            </div>
          )}
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 items-center rounded-md border border-line px-3 text-sm font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!body || busy}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-accent px-3.5 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
              {busy ? "Asking…" : `Ask @${writer.handle}`}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
