import { folioIdFrom, type DocDiffLine, type Folio, type FolioVersion, type FolioVersionDetail } from "@g1t/contracts";
import { ArrowLeft, History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, data, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/history";
import { foliosQuery, foliosRequest } from "../../../components/folios/actions";
import { FolioGlyph } from "../../../components/folios/kinds";
import { Face } from "../../../components/folios/parts";
import { Button, EmptyState, ErrorText } from "../../../components/ui";
import { canDo } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `History · ${loaded?.folio.title || "Untitled"} · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ folio: Folio; versions: FolioVersion[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const id = folioIdFrom(params.folio);
  if (!id) throw data(null, { status: 404 });
  const [folio, versions] = await Promise.all([folios.folio(slug, viewer, id), folios.versions(slug, viewer, id)]);
  if (!folio.ok || !versions.ok) throw data(null, { status: 404 });
  const url = new URL(request.url);
  if (url.pathname !== `${folio.value.path}/history`) throw redirect(`${folio.value.path}/history`);
  return { folio: folio.value, versions: versions.value };
}

const KIND_LABELS: Record<FolioVersion["kind"], string> = { created: "Created", edit: "Edited", agent: "Edited by an agent", suggestion: "Suggestion accepted", proposal: "Proposal applied", restore: "Restored" };

function DiffView({ lines }: { lines: DocDiffLine[] }) {
  if (!lines.length) return <p className="p-4 text-xs text-faint">No changes in the text.</p>;
  return (
    <div className="font-mono text-[0.75rem] leading-relaxed">
      {lines.map((l, i) => (
        <div key={i} className={`flex gap-2 px-3 whitespace-pre-wrap ${l.op === "add" ? "bg-success/10 text-fg" : l.op === "del" ? "bg-danger/10 text-fg-soft line-through decoration-danger/50" : "text-muted"}`}>
          <span className="w-3 shrink-0 text-faint select-none">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
          <span className="min-w-0">{l.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

/** An artifact's history: every version, who made it, what changed against the one before, and restoring one (a new version; nothing is lost). */
export default function FolioHistory({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { folio, versions } = loaderData;
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(versions[0]?.id ?? null);
  const [detail, setDetail] = useState<FolioVersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    if (!chosen) return setDetail(null);
    setDetail(null);
    void foliosQuery<FolioVersionDetail>(slug, { version: chosen, folio: folio.id }).then((r) => (r.ok ? setDetail(r.value) : setError(r.error.message)));
  }, [chosen, slug, folio.id]);
  const canRestore = canDo(folio.viewer_role, "edit") && !folio.trashed_at;
  return (
    <div className="mx-auto max-w-6xl">
      <Link to={folio.path} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} /> Back to <FolioGlyph folio={folio} size={12} /> {folio.title || "Untitled"}
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="flex grow items-center gap-2 text-xl font-semibold tracking-tight">
          <History size={18} className="text-faint" /> History
        </h1>
        {canRestore && chosen && versions[0]?.id !== chosen && (
          <Button
            type="button"
            variant="accent"
            disabled={restoring}
            onClick={async () => {
              setRestoring(true);
              const done = await foliosRequest(slug, "restore_version", { folio_id: folio.id, version_id: chosen });
              setRestoring(false);
              if (done.ok) navigate(folio.path);
              else setError(done.error.message);
            }}
          >
            <RotateCcw size={14} /> {restoring ? "Restoring…" : "Restore this version"}
          </Button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">Every version, who made it, and what changed. Restoring makes a new version; nothing is lost.</p>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {versions.length === 0 ? (
        <div className="mt-6">
          <EmptyState title="No versions yet">Versions are saved as people and agents edit.</EmptyState>
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)]">
          <ul className="space-y-px md:max-h-[calc(100dvh-14rem)] md:overflow-y-auto md:[scrollbar-width:thin]">
            {versions.map((v) => (
              <li key={v.id}>
                <button type="button" onClick={() => setChosen(v.id)} aria-current={chosen === v.id} className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${chosen === v.id ? "bg-raised" : "hover:bg-raised/60"}`}>
                  <span className="block text-xs font-medium text-fg" suppressHydrationWarning>
                    {new Date(v.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="mt-0.5 block text-[0.6875rem] text-faint">{v.note ?? KIND_LABELS[v.kind]}</span>
                  <span className="mt-1 flex items-center gap-1">
                    {v.authors.slice(0, 4).map((a) => (
                      <Face key={`${a.kind}:${a.id}`} who={a} size={14} />
                    ))}
                    <span className="ml-1 truncate text-[0.6875rem] text-muted">{v.authors.map((a) => a.display_name).join(", ")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
            {detail ? (
              <div className="max-h-[calc(100dvh-14rem)] overflow-auto py-2 [scrollbar-width:thin]">
                <DiffView lines={detail.diff} />
              </div>
            ) : (
              <p className="p-4 text-xs text-faint">{chosen ? "Loading…" : "Choose a version."}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
