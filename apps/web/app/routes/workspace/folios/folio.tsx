import { FOLIO_KIND_NOUNS, folioIdFrom, type DocRole, type Folio, type FolioPage } from "@g1t/contracts";
import { Lock } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Link, data, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/folio";
import { foliosRequest } from "../../../components/folios/actions";
import { EditorSkeleton } from "../../../components/folios/doc/editor-skeleton";
import { FOLIO_KIND_UI } from "../../../components/folios/kinds";
import type { LiveStatus } from "../../../components/folios/provider";
import { FolioHeader, type Presence } from "../../../components/folios/shell";
import { ErrorText } from "../../../components/ui";
import { page as pageMeta } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  const f = loaded && "page" in loaded ? loaded.page.folio : null;
  return pageMeta(args, { title: `${f ? `${f.icon ? `${f.icon} ` : ""}${f.title || "Untitled"}` : "Artifact"} · ${params.owner} · g1t`, description: f?.excerpt, type: "article" });
}

type Loaded = { page: FolioPage } | { denied: string };

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const id = folioIdFrom(params.folio);
  if (!id) throw data(null, { status: 404 });
  const found = await folios.page(params.owner.toLowerCase(), viewer, id);
  if (!found.ok) {
    // One they can't read and one that doesn't exist look the same: both can be asked for.
    if (found.error.code === "not_found" || found.error.code === "forbidden") return data<Loaded>({ denied: id }, { status: 403 });
    throw data(null, { status: 503 });
  }
  // An old address (renamed since) goes to the current one.
  const url = new URL(request.url);
  if (url.pathname !== found.value.folio.path) throw redirect(`${found.value.folio.path}${url.search}`);
  return { page: found.value } as Loaded;
}

/** One artifact: the shared header, then its kind's page (a doc's editor, for now). */
export default function FolioView({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  if ("denied" in loaderData) return <NeedAccess slug={slug} id={loaderData.denied} />;
  return <Opened slug={slug} page={loaderData.page} />;
}

function Opened({ slug, page }: { slug: string; page: FolioPage }) {
  const navigate = useNavigate();
  const [folio, setFolio] = useState<Folio>(page.folio);
  useEffect(() => setFolio(page.folio), [page.folio]);
  const [role, setRole] = useState<DocRole>(page.folio.viewer_role);
  useEffect(() => setRole(page.folio.viewer_role), [page.folio.viewer_role, page.folio.id]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [showComments, setShowComments] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onRole = useCallback((next: DocRole | null) => next && setRole(next), []);
  const ui = FOLIO_KIND_UI[folio.kind];
  const Body = ui.Body;
  return (
    <div>
      <FolioHeader
        slug={slug}
        folio={{ ...folio, viewer_role: role }}
        breadcrumbs={page.breadcrumbs}
        presence={presence}
        status={status}
        comments={folio.kind === "doc" ? { open: showComments, onToggle: () => setShowComments(!showComments) } : null}
        onError={setError}
        onTrashed={() => navigate(`/${slug}/-/artifacts`)}
      />
      {error && (
        <div className="mx-auto mt-4 max-w-3xl">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {Body ? (
        <Suspense
          fallback={
            <div className="mx-auto max-w-3xl pt-10">
              <EditorSkeleton />
            </div>
          }
        >
          <Body slug={slug} page={page} folio={folio} role={role} showComments={showComments} onPresence={setPresence} onStatus={setStatus} onFolio={setFolio} onRole={onRole} onError={setError} />
        </Suspense>
      ) : (
        <p className="mx-auto mt-16 max-w-md text-center text-sm text-muted">This is a {FOLIO_KIND_NOUNS[folio.kind]}. Opening {ui.label.toLowerCase()} here is coming soon.</p>
      )}
    </div>
  );
}

/** "You need access": ask the owner and the people with full access, at most once a day. */
function NeedAccess({ slug, id }: { slug: string; id: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-raised text-muted">
        <Lock size={20} />
      </span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">You need access</h1>
      <p className="mt-1 text-sm text-muted">Ask for access, and its owner hears of it. If it was deleted, nobody can open it any more.</p>
      {state === "sent" ? (
        <p className="mt-6 text-sm text-success">Asked. You&apos;ll get a notification when they let you in.</p>
      ) : (
        <form
          className="mt-6 flex w-full flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setState("busy");
            setError(null);
            const done = await foliosRequest(slug, "request_access", { folio_id: id, message: message.trim() || null });
            if (done.ok) setState("sent");
            else {
              setState("idle");
              setError(done.error.message);
            }
          }}
        >
          <input aria-label="Message" placeholder="Add a message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} className="h-9 w-full rounded-md border border-line bg-bg px-3 text-sm outline-none focus:border-accent/60" />
          <button type="submit" disabled={state === "busy"} className="inline-flex h-9 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-bg hover:bg-accent-hover disabled:opacity-60">
            {state === "busy" ? "Asking…" : "Ask for access"}
          </button>
          {error && <ErrorText>{error}</ErrorText>}
        </form>
      )}
      <Link to={`/${slug}/-/artifacts`} className="mt-6 text-xs text-muted hover:text-fg">
        Back to Artifacts
      </Link>
    </div>
  );
}
