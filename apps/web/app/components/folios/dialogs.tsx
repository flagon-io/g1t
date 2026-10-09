/**
 * The small dialogs an artifact's ⋯ menu opens, from Home's rows and from
 * its own page: rename, move (to a space or Private, inside a doc), and
 * save as a template.
 */
import { FOLIO_MAX_TITLE, type Folio, type FoliosSidebar, type Result } from "@g1t/contracts";
import { useEffect, useMemo, useState } from "react";

import { buildTree, canDo, flatten } from "../../lib/folios";
import { Button, ErrorText } from "../ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { SelectField } from "../ui/select";

const FIELD = "h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent/60";

export function RenameDialog({ open, onOpenChange, title, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; onSave: (title: string) => Promise<Result<unknown>> }) {
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(title);
      setError(null);
    }
  }, [open, title]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const done = await onSave(value.trim());
            setBusy(false);
            if (done.ok) onOpenChange(false);
            else setError(done.error.message);
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>Its link keeps working: the address ends in its id.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <input aria-label="Title" autoFocus maxLength={FOLIO_MAX_TITLE} placeholder="Untitled" value={value} onChange={(e) => setValue(e.target.value)} className={FIELD} />
            {error && <ErrorText>{error}</ErrorText>}
          </div>
          <DialogFooter className="mt-4">
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Saving…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where an artifact can go: the top of a space the viewer can edit, or of
 * their own Private, or inside a doc there. Never inside itself or
 * anything under it.
 */
export function MoveDialog({
  sidebar,
  folio,
  me,
  open,
  onOpenChange,
  onMove,
}: {
  sidebar: FoliosSidebar | null | undefined;
  folio: Pick<Folio, "id" | "title" | "space" | "parent_id" | "owner">;
  /** The viewer's member key: only an artifact's owner can move it to their Private. */
  me: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onMove: (spaceId: string | null, parentId: string | null) => Promise<Result<unknown>>;
}) {
  const mine = `user:${folio.owner.id}` === me;
  const places = useMemo(() => {
    const out: { value: string; label: string; tree: ReturnType<typeof buildTree> }[] = [];
    if (mine) out.push({ value: "private", label: "Private (just you)", tree: buildTree(sidebar?.private_tree ?? []) });
    for (const s of sidebar?.spaces ?? []) if (canDo(s.viewer_role, "edit")) out.push({ value: s.id, label: s.name, tree: buildTree(s.tree) });
    return out;
  }, [sidebar, mine]);
  const [place, setPlace] = useState(folio.space?.id ?? "private");
  const [parent, setParent] = useState(folio.parent_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPlace(folio.space?.id ?? (mine ? "private" : (places[0]?.value ?? "")));
    setParent(folio.parent_id ?? "");
    setError(null);
  }, [open, folio.space?.id, folio.parent_id, mine, places]);
  const docs = useMemo(() => {
    const tree = flatten(places.find((p) => p.value === place)?.tree ?? []);
    const hidden = new Set<string>([folio.id]);
    for (const item of tree) if (item.parent_id && hidden.has(item.parent_id)) hidden.add(item.id);
    return tree.filter((i) => i.kind === "doc" && !hidden.has(i.id));
  }, [places, place, folio.id]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move “{folio.title || "Untitled"}”</DialogTitle>
          <DialogDescription>Everything inside it moves with it. In a space, it follows the space&apos;s access unless it&apos;s set to only people invited.</DialogDescription>
        </DialogHeader>
        {places.length === 0 ? (
          <p className="text-sm text-muted">There&apos;s nowhere you can move it: you can&apos;t add to any space, and only its owner can move it to their Private.</p>
        ) : (
          <div className="space-y-3">
            <SelectField
              aria-label="Where"
              value={place}
              onValueChange={(v) => {
                setPlace(v);
                setParent("");
              }}
              options={places.map((p) => ({ value: p.value, label: p.label }))}
              className="h-9 w-full"
            />
            <SelectField
              aria-label="Inside"
              value={parent}
              onValueChange={setParent}
              options={[{ value: "", label: "At the top" }, ...docs.map((p) => ({ value: p.id, label: `${"  ".repeat(p.depth)}${p.icon ?? ""} ${p.title || "Untitled"}`.trim() }))]}
              className="h-9 w-full"
            />
            {error && <ErrorText>{error}</ErrorText>}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="accent"
            disabled={busy || places.length === 0}
            onClick={async () => {
              setBusy(true);
              const done = await onMove(place === "private" ? null : place, parent || null);
              setBusy(false);
              if (done.ok) onOpenChange(false);
              else setError(done.error.message);
            }}
          >
            {busy ? "Moving…" : "Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Save as a template. From something not everyone can read, it says so first: the template is everyone's (plan section 4.3 rule 8). */
export function TemplateDialog({ open, onOpenChange, title, widens, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; widens: boolean; onSave: (name: string, description: string) => Promise<Result<unknown>> }) {
  const [name, setName] = useState(title);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(title);
      setError(null);
    }
  }, [open, title]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as a template</DialogTitle>
          <DialogDescription>Everyone in the workspace will be able to use this template.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {widens && <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">Not everyone in the workspace can open this now. Its content will be in the template, which everyone can use.</p>}
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
          <input aria-label="What it's for" placeholder="What it's for" value={description} onChange={(e) => setDescription(e.target.value)} className={FIELD} />
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="accent"
            onClick={async () => {
              const done = await onSave(name, description);
              if (done.ok) onOpenChange(false);
              else setError(done.error.message);
            }}
          >
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
