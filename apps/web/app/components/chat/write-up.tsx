import { FileText, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { DocsSidebar, Result } from "@g1t/contracts";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { SelectField } from "../ui/select";
import { ORCHESTRATOR, type WritableSpace, type WriteUpAgent, writableSpaces, writeUpMessage } from "../../lib/write-up";

// "Write this up in Docs" (docs/WORKSPACE.md, "Docs"): which space, a
// title if you have one, and which agent writes it. Sending posts the ask
// in the thread, as you, where everyone sees it; the agent answers it as
// it answers any mention, and links the page it made.

type Spaces = { state: "loading" } | { state: "ready"; spaces: WritableSpace[] } | { state: "failed"; message: string };

export function WriteUpDialog({
  open,
  onOpenChange,
  slug,
  agents,
  link,
  onSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  /** Who can write it: @g1t, then the conversation's agents (lib/write-up.ts `writeUpAgents`). */
  agents: WriteUpAgent[];
  /** The thread's link, cited as the source. */
  link: string;
  /** Posts the ask in the thread; answers with what went wrong, or null. */
  onSend: (body: string) => Promise<string | null>;
}) {
  const [spaces, setSpaces] = useState<Spaces>({ state: "loading" });
  const [space, setSpace] = useState("");
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
      try {
        const response = await fetch(`/${slug}/-/docs/api`);
        const result = (await response.json()) as Result<DocsSidebar>;
        if (!live) return;
        if (!result.ok) return setSpaces({ state: "failed", message: result.error.message });
        const list = writableSpaces(result.value.spaces);
        setSpaces({ state: "ready", spaces: list });
        setSpace((now) => (list.some((s) => s.id === now) ? now : (list[0]?.id ?? "")));
      } catch {
        if (live) setSpaces({ state: "failed", message: "Couldn't load your Docs spaces. Try again in a moment." });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, slug]);

  const chosen = spaces.state === "ready" ? spaces.spaces.find((s) => s.id === space) ?? null : null;
  const writer = agents.find((a) => a.handle === agent) ?? agents[0] ?? { handle: ORCHESTRATOR, name: ORCHESTRATOR };
  const body = chosen ? writeUpMessage({ agent: writer.handle, space: chosen.name, title, link }) : null;

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
          <DialogTitle>Write this up in Docs</DialogTitle>
          <DialogDescription>An agent turns this thread into a page: what was decided, why, and what's next, with a link back here.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field>
            <FieldLabel htmlFor="write-up-space">Space</FieldLabel>
            {spaces.state === "loading" ? (
              <div className="flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-faint">
                <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                Loading spaces…
              </div>
            ) : spaces.state === "failed" ? (
              <FieldError>{spaces.message}</FieldError>
            ) : spaces.spaces.length === 0 ? (
              <FieldDescription>
                There's no Docs space you can write in yet.{" "}
                <Link to={`/${slug}/-/docs/new`} className="font-medium text-accent hover:underline" onClick={() => onOpenChange(false)}>
                  Create one
                </Link>
              </FieldDescription>
            ) : (
              <SelectField
                id="write-up-space"
                value={space}
                onValueChange={setSpace}
                options={spaces.spaces.map((s) => ({ value: s.id, label: s.name }))}
              />
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="write-up-title">
              Title <span className="font-normal text-faint">(optional)</span>
            </FieldLabel>
            <Input
              id="write-up-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Left to the agent"
              maxLength={120}
              autoComplete="off"
            />
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
