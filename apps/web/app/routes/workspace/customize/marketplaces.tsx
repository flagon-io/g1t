/**
 * The marketplaces a workspace reads plugins from: the ones every
 * workspace starts with (built in, read again on their own), and the ones
 * its owners added by address. Each says how many plugins it lists, when
 * it was last read, and what went wrong if it couldn't be. Owners add,
 * remove and read again; the Add menu's dialog posts here from any page.
 */
import { ArrowLeft, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Link, data, useFetcher } from "react-router";

import type { Marketplace, MarketplaceSource } from "@g1t/contracts";
import { customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/marketplaces";
import { useCustomize } from "./layout";
import { agentsAction, answer, readOrNull } from "../../../components/agents/actions.server";
import { type ActionResult, Confirm, useDialogFetcher } from "../../../components/agents/dialogs";
import { AddMarketplaceDialog, NoAnswer, SectionHead } from "../../../components/customize";
import { SubmitButton, TimeAgo } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { page } from "../../../lib/meta";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export { shouldRevalidate } from "../../../lib/customize.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Marketplaces · Customize · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ marketplaces: Marketplace[] | null }> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!roleIn(viewer, slug)) throw data(null, { status: 404 });
  return { marketplaces: await readOrNull(workspaceAgents.marketplaces(slug, viewer)) };
}

/** Add a marketplace by address, remove one, or read one again. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if (intent === "add") {
    const address = String(form.get("address") ?? "").trim();
    if (!address) return { ok: false, intent, error: "Give the marketplace's address." };
    return answer(intent, workspaceAgents.addMarketplace(slug, viewer, address, name || null));
  }
  if (intent === "remove") return answer(intent, workspaceAgents.removeMarketplace(slug, viewer, name));
  if (intent === "refresh") return answer(intent, workspaceAgents.refreshMarketplace(slug, viewer, name));
  return { ok: false, intent, error: "Unknown request." };
}

/** Where a marketplace is read from, in a few words. */
function sourceWords(source: MarketplaceSource): string {
  switch (source.source) {
    case "github":
      return `github.com/${source.repo}${source.ref ? ` at ${source.ref}` : ""}`;
    case "g1t":
      return `${source.repo} on this g1t${source.ref ? ` at ${source.ref}` : ""}`;
    case "git":
      return source.url;
    case "url":
      return source.url;
    case "builtin":
      return "Built into g1t";
  }
}

export default function Marketplaces({ loaderData }: Route.ComponentProps) {
  const { slug, owner } = useCustomize();
  const { marketplaces } = loaderData;
  const add = useDialogFetcher("add-marketplace");
  return (
    <div className="space-y-6">
      <Link to={customizePath("plugins", slug)} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Plugins
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionHead id="marketplaces" title="Marketplaces" aside={marketplaces ? `${marketplaces.length}` : undefined}>
          Where plugins come from: each a repository with a <code className="font-mono text-xs">.claude-plugin/marketplace.json</code>, read as Claude Code reads it. Every workspace starts with the public ones; owners add
          more, by address.
        </SectionHead>
        {owner && (
          <Button type="button" variant="accent" size="sm" onClick={() => add.setOpen(true)}>
            <Plus size={14} />
            Add a marketplace
          </Button>
        )}
      </div>
      {!marketplaces ? (
        <NoAnswer what="The marketplaces" />
      ) : (
        <Card asChild divided className="overflow-hidden">
          <ul>
            {marketplaces.map((marketplace) => (
              <MarketplaceRow key={marketplace.name} marketplace={marketplace} slug={slug} owner={owner} />
            ))}
          </ul>
        </Card>
      )}
      {owner && <AddMarketplaceDialog slug={slug} dialog={add} />}
    </div>
  );
}

function MarketplaceRow({ marketplace, slug, owner }: { marketplace: Marketplace; slug: string; owner: boolean }) {
  const fetcher = useFetcher<ActionResult>({ key: `marketplace-${marketplace.name}` });
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3.5">
      <div className="min-w-0 grow">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`${customizePath("plugins", slug)}?view=discover&marketplace=${encodeURIComponent(marketplace.name)}`} className="font-mono text-sm font-medium hover:underline">
            {marketplace.name}
          </Link>
          {marketplace.builtin && <Badge tone="accent">Built in</Badge>}
          {marketplace.problem && (
            <Hint label={marketplace.problem}>
              <span tabIndex={0} className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
                <Badge tone="danger">Couldn&apos;t be read</Badge>
              </span>
            </Hint>
          )}
        </div>
        {marketplace.about && <p className="mt-0.5 text-sm text-muted">{marketplace.about}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-faint">
          <span className="truncate">{sourceWords(marketplace.source)}</span>
          <span aria-hidden="true">·</span>
          <span>
            {marketplace.plugins} {marketplace.plugins === 1 ? "plugin" : "plugins"}
          </span>
          {marketplace.owner && (
            <>
              <span aria-hidden="true">·</span>
              <span>by {marketplace.owner}</span>
            </>
          )}
          {marketplace.fetched_at && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                Read <TimeAgo at={marketplace.fetched_at} />
              </span>
            </>
          )}
          {marketplace.added_by && (
            <>
              <span aria-hidden="true">·</span>
              <span>Added by @{marketplace.added_by}</span>
            </>
          )}
        </p>
        {error && <p className="mt-1.5 text-sm text-danger">{error}</p>}
      </div>
      {owner && (
        <div className="flex shrink-0 items-center gap-2">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <input type="hidden" name="name" value={marketplace.name} />
            <SubmitButton variant="outline" size="sm" fetcher={fetcher} match={{ intent: "refresh", name: marketplace.name }} pending="Reading…">
              <RefreshCw size={13} />
              Read again
            </SubmitButton>
          </fetcher.Form>
          {marketplace.can_remove && (
            <Confirm
              title={`Remove ${marketplace.name}?`}
              confirm="Remove marketplace"
              fields={{ intent: "remove", name: marketplace.name }}
              fetcherKey={`marketplace-remove-${marketplace.name}`}
              trigger={
                <Button type="button" variant="outline" size="sm" className="hover:border-danger/50 hover:text-danger">
                  <Trash2 size={13} />
                  Remove
                </Button>
              }
            >
              Its plugins leave Discover. Plugins already installed from it stay installed, at the commit they were read at, with no updates.
            </Confirm>
          )}
        </div>
      )}
    </li>
  );
}
