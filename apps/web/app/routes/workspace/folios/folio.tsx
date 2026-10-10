import { FOLIO_KIND_NOUNS, folioIdFrom, type DocRole, type Folio, type FolioPage } from "@g1t/contracts";
import { Lock } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { type HtmlLinkDescriptor, Link, data, redirect, useNavigate } from "react-router";
import editorChunk from "virtual:g1t-editor-chunk";

import type { Route } from "./+types/folio";
import { foliosRequest } from "../../../components/folios/actions";
import { EditorSkeleton } from "../../../components/folios/doc/editor-skeleton";
import { FOLIO_KIND_UI } from "../../../components/folios/kinds";
import { FolioProvider, type LiveStatus, pageStateBytes } from "../../../components/folios/provider";
import { FolioHeader, type Presence } from "../../../components/folios/shell";
import { ErrorText } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { type OfferedTicket, offerTicket } from "../../../lib/live-socket";
import { page as pageMeta } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { socketTicketFor } from "../../../lib/socket-ticket.server";

export function meta({ loaderData: loaded, params, ...args }: Route.MetaArgs) {
  const f = loaded && "page" in loaded ? loaded.page.folio : null;
  return pageMeta(args, { title: `${f ? `${f.icon ? `${f.icon} ` : ""}${f.title || "Untitled"}` : "Artifact"} · ${params.owner} · g1t`, description: f?.excerpt, type: "article" });
}

/**
 * The doc editor's code and what it imports, fetched with the page rather
 * than after the page's own code has run and asked for them. The server
 * knows the files (vite.config.ts `editorChunk`); the browser reads them
 * back from the page the server sent, so both render the same links.
 */
function editorFiles(): string[] {
  if (editorChunk.length) return editorChunk;
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll('link[rel="modulepreload"][data-doc-editor]')].map((link) => link.getAttribute("href") ?? "").filter(Boolean);
}

export const links: Route.LinksFunction = () => editorFiles().map((href) => ({ rel: "modulepreload", href, "data-doc-editor": "" }) as unknown as HtmlLinkDescriptor);

/** The live socket's path in this workspace (lib/socket-ticket.ts `socketPath`). */
const livePath = (slug: string) => `/${slug}/-/artifacts/live`;

type Loaded = { page: FolioPage; ticket: OfferedTicket | null } | { denied: string };

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const id = folioIdFrom(params.folio);
  if (!id) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  // A page opened with an access token gets its room's socket ticket with
  // the page, so the socket opens without asking for one (lib/live-socket.ts).
  const [found, ticket] = await Promise.all([folios.page(slug, viewer, id), socketTicketFor(context, request, livePath(slug))]);
  if (!found.ok) {
    // One they can't read and one that doesn't exist look the same: both can be asked for.
    if (found.error.code === "not_found" || found.error.code === "forbidden") return data<Loaded>({ denied: id }, { status: 403 });
    throw data(null, { status: 503 });
  }
  // An old address (renamed since) goes to the current one.
  const url = new URL(request.url);
  if (url.pathname !== found.value.folio.path) throw redirect(`${found.value.folio.path}${url.search}`);
  return { page: found.value, ticket } as Loaded;
}

/** One artifact: the shared header, then its kind's page (a doc's editor, for now). */
export default function FolioView({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  if ("denied" in loaderData) return <NeedAccess slug={slug} id={loaderData.denied} />;
  return <Opened slug={slug} page={loaderData.page} ticket={loaderData.ticket} />;
}

/**
 * The page connects to the folio's room as soon as it hydrates, before
 * the body's code (and the editor's, far larger) has arrived, and seeds
 * the document from the state the page carried, so the editor opens on
 * it at once and the room sends only what changed since. The room never
 * gates the page: the text is readable from the first byte, the editor
 * works before the room answers, and the header's dot says when it has.
 */
function useLive(slug: string, page: FolioPage, ticket: OfferedTicket | null): { live: FolioProvider | null; status: LiveStatus } {
  const [live, setLive] = useState<FolioProvider | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const id = page.folio.id;
  const state = page.state;
  useEffect(() => {
    offerTicket(livePath(slug), ticket);
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const provider = new FolioProvider(`${scheme}://${window.location.host}${livePath(slug)}?folio=${encodeURIComponent(id)}`, { state: pageStateBytes(state) });
    const off = provider.onStatus(setStatus);
    setLive(provider);
    return () => {
      off();
      provider.destroy();
      setLive(null);
    };
    // The same folio keeps its connection through a revalidation; only another folio reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, id]);
  return { live, status };
}

function Opened({ slug, page, ticket }: { slug: string; page: FolioPage; ticket: OfferedTicket | null }) {
  const navigate = useNavigate();
  const [folio, setFolio] = useState<Folio>(page.folio);
  useEffect(() => setFolio(page.folio), [page.folio]);
  const [role, setRole] = useState<DocRole>(page.folio.viewer_role);
  useEffect(() => setRole(page.folio.viewer_role), [page.folio.viewer_role, page.folio.id]);
  const [presence, setPresence] = useState<Presence[]>([]);
  const { live, status } = useLive(slug, page, ticket);
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
          <Body slug={slug} page={page} folio={folio} live={live} role={role} showComments={showComments} onPresence={setPresence} onFolio={setFolio} onRole={onRole} onError={setError} />
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
          <Button type="submit" disabled={state === "busy"} variant="accent" className="px-4 disabled:opacity-60">
            {state === "busy" ? "Asking…" : "Ask for access"}
          </Button>
          {error && <ErrorText>{error}</ErrorText>}
        </form>
      )}
      <Link to={`/${slug}/-/artifacts`} className="mt-6 text-xs text-muted hover:text-fg">
        Back to Artifacts
      </Link>
    </div>
  );
}
