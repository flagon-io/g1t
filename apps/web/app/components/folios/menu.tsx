/**
 * An artifact's ⋯ menu, the same on Home's rows and cards and in its own
 * header: open in a new tab, favorite, share, rename, duplicate, move,
 * copy the link, export, save as a template, move to the trash. What the
 * viewer's role doesn't allow isn't offered.
 */
import type { Folio } from "@g1t/contracts";
import { ArrowRightLeft, Copy, Download, Ellipsis, ExternalLink, History, LayoutTemplate, Link2, PencilLine, Share2, Star, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";

import { canDo } from "../../lib/folios";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { foliosRequest, useFoliosData } from "./actions";
import { MoveDialog, RenameDialog, TemplateDialog } from "./dialogs";
import { ShareDialog } from "./share-dialog";

export function FolioMenu({
  slug,
  folio,
  onError,
  onTrashed,
  page = false,
  trigger,
}: {
  slug: string;
  folio: Folio;
  onError?: (message: string) => void;
  /** After it went to the trash (its own page goes back Home). */
  onTrashed?: () => void;
  /** On its own page: History is offered, and "Open in new tab" isn't. */
  page?: boolean;
  trigger?: ReactNode;
}) {
  const layout = useFoliosData();
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [templating, setTemplating] = useState(false);
  const editable = canDo(folio.viewer_role, "edit");
  const fail = (message: string) => onError?.(message);
  const send = async <T,>(intent: string, body: Record<string, unknown>) => {
    const done = await foliosRequest<T>(slug, intent, { folio_id: folio.id, ...body });
    if (done.ok) void revalidate();
    else fail(done.error.message);
    return done;
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? (
            <Button type="button" aria-label={`More for ${folio.title || "Untitled"}`} variant="ghost" size="icon-sm" className="text-faint max-md:size-10">
              <Ellipsis size={16} />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {!page && (
            <DropdownMenuItem asChild>
              <a href={folio.path} target="_blank" rel="noopener">
                <ExternalLink size={14} /> Open in new tab
              </a>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void send("favorite", { on: !folio.favorite })}>
            <Star size={14} className={folio.favorite ? "fill-current text-warn" : ""} /> {folio.favorite ? "Remove from Favorites" : "Add to Favorites"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setSharing(true)}>
            <Share2 size={14} /> Share…
          </DropdownMenuItem>
          {page && (
            <DropdownMenuItem asChild>
              <Link to={`${folio.path}/history`}>
                <History size={14} /> History
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {editable && (
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilLine size={14} /> Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={async () => {
              const made = await send<Folio>("duplicate", {});
              if (made.ok) navigate(made.value.path);
            }}
          >
            <Copy size={14} /> Duplicate
          </DropdownMenuItem>
          {editable && (
            <DropdownMenuItem onSelect={() => setMoving(true)}>
              <ArrowRightLeft size={14} /> Move to…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={async () => {
              try {
                await navigator.clipboard.writeText(`${window.location.origin}${folio.path}`);
              } catch {
                fail("Your browser didn't allow copying.");
              }
            }}
          >
            <Link2 size={14} /> Copy link
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`/${slug}/-/artifacts/export?folio=${encodeURIComponent(folio.id)}`}>
              <Download size={14} /> Export Markdown
            </a>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTemplating(true)}>
            <LayoutTemplate size={14} /> Save as template
          </DropdownMenuItem>
          {editable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={async () => {
                  const done = await send("trash", {});
                  if (done.ok) onTrashed?.();
                }}
                className="text-danger focus:text-danger"
              >
                <Trash2 size={14} /> Move to trash
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ShareDialog slug={slug} folio={folio} open={sharing} onOpenChange={setSharing} onChanged={() => void revalidate()} />
      <RenameDialog open={renaming} onOpenChange={setRenaming} title={folio.title} onSave={(title) => send("update", { change: { title } })} />
      <MoveDialog
        sidebar={layout?.sidebar}
        folio={folio}
        me={layout?.me.key ?? ""}
        open={moving}
        onOpenChange={setMoving}
        onMove={(spaceId, parentId) => send("move", { move: { space_id: spaceId, parent_id: parentId, before_id: null } })}
      />
      <TemplateDialog open={templating} onOpenChange={setTemplating} title={folio.title || "Untitled"} widens={folio.general_access !== "workspace" && !(folio.space?.kind === "workspace" && folio.inherit)} onSave={(name, description) => send("save_template", { name, description })} />
    </>
  );
}
