/**
 * One extension's page: what it adds, what it may do (in words and as
 * scopes), where its data goes, where it runs, its version and source,
 * and, once installed, the switch that turns it off and the way to remove it.
 */
import { ArrowLeft, Globe, Power, ShieldCheck, Trash2 } from "lucide-react";
import { Link, data, useFetcher } from "react-router";

import { describeScope, isScope } from "@g1t/contracts/scopes";
import { dataDisclosure, extensionById } from "@g1t/contracts/marketplace";

import type { Route } from "./+types/extension";
import { ACTION, ExtensionAction, ExtensionAvailability, ExtensionMark, ListingFacts } from "../../../components/marketplace";
import { SubmitButton } from "../../../components/ui";
import { TIERS, extensionListings, marketplacePath, runtimeWords } from "../../../lib/marketplace";
import { page } from "../../../lib/meta";
import { useMarketplace } from "./layout";

export function meta({ params, ...args }: Route.MetaArgs) {
  const extension = extensionById(params.extension);
  return page(args, { title: `${extension?.name ?? "Extension"} · Marketplace · ${params.owner} · g1t` });
}

export function loader({ params }: Route.LoaderArgs) {
  if (!extensionById(params.extension)) throw data(null, { status: 404 });
  return null;
}

export default function MarketplaceExtension({ params }: Route.ComponentProps) {
  const { slug, owner, username, requests, installs } = useMarketplace();
  const manifest = extensionById(params.extension)!;
  const [listing] = extensionListings([manifest], installs, requests?.requests ?? [], username);
  const install = listing!.install;
  const fetcher = useFetcher<{ error: string | null }>();
  const action = marketplacePath(slug, "requests");
  const Group = ({ title, items, empty }: { title: string; items: string[]; empty: string }) => (
    <div className="rounded-xl border border-line bg-surface p-4">
      <h4 className="text-xs text-faint">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-sm">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div>
      <Link to={marketplacePath(slug, "extensions")} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        All extensions
      </Link>
      <header className="mt-5 flex flex-wrap items-center gap-4">
        <ExtensionMark manifest={manifest} size={64} />
        <div className="min-w-0 grow basis-60">
          <h2 className="text-xl font-semibold tracking-tight">{manifest.name}</h2>
          <ListingFacts tier={listing!.tier} publisher={manifest.publisher.name} category={manifest.category}>
            <ExtensionAvailability listing={listing!} owner={owner} />
          </ListingFacts>
        </div>
        <ExtensionAction listing={listing!} slug={slug} owner={owner} className="h-9 px-4 text-sm" />
      </header>
      {listing!.availability === "soon" && (
        <p className="mt-5 max-w-3xl rounded-lg border border-dashed border-line-strong px-4 py-3 text-sm text-muted">
          Not published yet: nobody can install it until its first release. This page shows what it will add and what it will be able to do.
        </p>
      )}
      <p className="mt-6 max-w-3xl text-[0.9375rem] leading-relaxed text-fg-soft">{manifest.description}</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="adds" className="min-w-0">
          <h3 id="adds" className="text-sm font-semibold">
            What it adds to the workspace
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Group title="Pages, in its sidebar" items={manifest.adds.pages} empty="None" />
            <Group title="Cards, in chat and elsewhere" items={manifest.adds.cards} empty="None" />
            <Group title="Agent roles it brings" items={manifest.adds.agent_roles} empty="None. Your agents get its tools." />
            <Group title="Tools for agents" items={manifest.adds.tools} empty="None" />
            <Group title="Notifications it sends" items={manifest.adds.notifications} empty="None" />
          </div>
        </section>

        <aside className="space-y-4 text-sm">
          <section aria-labelledby="may" className="rounded-xl border border-line bg-surface p-4">
            <h3 id="may" className="flex items-center gap-1.5 text-xs text-faint">
              <ShieldCheck size={13} />
              It will be able to
            </h3>
            <ul className="mt-2 space-y-1.5">
              {manifest.permissions.map((permission) => (
                <li key={permission}>{permission}</li>
              ))}
            </ul>
            <h4 className="mt-4 text-xs text-faint">With access to</h4>
            <ul className="mt-1.5 space-y-1 text-muted">
              {manifest.scopes.map((scope) => (
                <li key={scope}>
                  <span className="font-mono text-xs text-fg-soft">{scope}</span>
                  {isScope(scope) && <span className="block text-xs">{describeScope(scope)}</span>}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="where" className="rounded-xl border border-line bg-surface p-4">
            <h3 id="where" className="flex items-center gap-1.5 text-xs text-faint">
              <Globe size={13} />
              Where it runs, and where data goes
            </h3>
            <p className="mt-2">{runtimeWords(manifest)}</p>
            <p className={manifest.domains.length > 0 ? "mt-1 text-warn" : "mt-1 text-muted"}>{dataDisclosure(manifest)}</p>
          </section>
          <dl className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <dt className="text-xs text-faint">Publisher</dt>
              <dd className="mt-0.5">
                {manifest.publisher.name} · {TIERS[listing!.tier].label}
                <span className="block text-xs text-muted">{TIERS[listing!.tier].about}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Version</dt>
              <dd className="mt-0.5">{install ? `${install.version} installed` : (manifest.version ?? "Not published yet")}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Source</dt>
              <dd className="mt-0.5">
                {manifest.source ? (
                  <Link to={`/${manifest.source.repo}/tree/${manifest.source.tag}`} className="font-mono text-xs hover:underline">
                    {manifest.source.repo}@{manifest.source.tag}
                  </Link>
                ) : (
                  <span className="text-muted">Published with its first release</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Price</dt>
              <dd className="mt-0.5">Free. What its agents do is billed at what it costs, like any agent's work.</dd>
            </div>
          </dl>
          {install && owner && (
            <fetcher.Form method="post" action={action} className="flex flex-wrap gap-2">
              <input type="hidden" name="listing" value={listing!.ref} />
              <input type="hidden" name="enabled" value={install.enabled ? "off" : "on"} />
              <SubmitButton fetcher={fetcher} name="intent" value="switch" className={ACTION.quiet} pending="Saving…">
                <Power size={14} />
                {install.enabled ? "Switch off" : "Switch on"}
              </SubmitButton>
              <SubmitButton fetcher={fetcher} name="intent" value="uninstall" className={ACTION.quiet} pending="Removing…">
                <Trash2 size={14} />
                Uninstall
              </SubmitButton>
            </fetcher.Form>
          )}
        </aside>
      </div>
    </div>
  );
}
