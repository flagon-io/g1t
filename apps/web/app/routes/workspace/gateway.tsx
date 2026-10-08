import { BookOpen, KeyRound } from "lucide-react";
import { Suspense } from "react";
import { Await, Link, data } from "react-router";

import type { Route } from "./+types/gateway";
import { GatewaySkeleton, GatewayTable } from "../../components/gateway";
import { ButtonLink, CopyLine, EmptyState } from "../../components/ui";
import { GATEWAY_BASE_URL, GATEWAY_DOCS } from "../../lib/gateway";
import { page } from "../../lib/meta";
import { billing } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

const PAGE_SIZE = 50;

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `AI Gateway · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const before = new URL(request.url).searchParams.get("before")?.trim() || null;
  // Streamed: the page's frame comes at once, the log's skeleton holds
  // its place, and the requests fill it in.
  const log = billing
    .gatewayRequests(slug, viewer, { limit: PAGE_SIZE, before })
    .then((result) => (result.ok ? { page: result.value, error: null } : { page: null, error: result.error.message }));
  return { slug, owner: role === "owner", before, log };
}

export default function WorkspaceGateway({ loaderData }: Route.ComponentProps) {
  const { slug, owner, before, log } = loaderData;
  const base = `/${slug}/-/gateway`;
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <p className="max-w-3xl text-sm text-muted">
          Send your own code's model requests in Anthropic's Messages format to this base URL, with one of the workspace's
          access tokens that has the <code className="font-mono text-xs">models:write</code> scope as the API key. On g1t's
          models each request is charged at the model's price and paid from AI credit; with the workspace's own Anthropic key
          under Integrations it is only counted. Prompts and answers are never kept.
        </p>
        <div className="max-w-xl">
          <CopyLine text={GATEWAY_BASE_URL} />
        </div>
        <div className="flex flex-wrap gap-2">
          {owner && (
            <ButtonLink variant="quiet" to={`/${slug}/-/tokens`}>
              <KeyRound size={14} />
              Access tokens
            </ButtonLink>
          )}
          <ButtonLink variant="quiet" to={GATEWAY_DOCS} reloadDocument>
            <BookOpen size={14} />
            How to use it
          </ButtonLink>
        </div>
      </section>

      <Suspense fallback={<GatewaySkeleton />}>
        <Await resolve={log}>
          {(loaded) =>
            !loaded.page ? (
              <p className="rounded-lg border border-danger/40 bg-danger/5 px-4 py-2.5 text-sm">
                {loaded.error ?? "The requests could not be read. Try again in a minute."}
              </p>
            ) : (
              <div className="space-y-4">
                {loaded.page.requests.length === 0 ? (
                  <EmptyState title={before ? "No older requests" : "No requests yet"}>
                    {before
                      ? "Everything older has passed the log's 30 days."
                      : "Requests appear here as soon as code sends them to the AI Gateway with one of the workspace's tokens."}
                  </EmptyState>
                ) : (
                  <GatewayTable requests={loaded.page.requests} />
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  {before && (
                    <Link to={base} className="text-muted hover:text-fg">
                      Newest
                    </Link>
                  )}
                  {loaded.page.next && (
                    <Link to={`${base}?before=${encodeURIComponent(loaded.page.next)}`} className="text-muted hover:text-fg">
                      Older
                    </Link>
                  )}
                  <span className="grow" />
                  <span className="text-xs text-faint">
                    Kept {loaded.page.retentionDays} days. What requests were charged is also on{" "}
                    <Link to={`/${slug}/-/usage?product=gateway`} className="hover:text-fg hover:underline">
                      Usage
                    </Link>
                    .
                  </span>
                </div>
              </div>
            )
          }
        </Await>
      </Suspense>
    </div>
  );
}
