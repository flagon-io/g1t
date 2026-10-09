import type { Folio } from "@g1t/contracts";
import { AlertTriangle } from "lucide-react";
import { data } from "react-router";

import type { Route } from "./+types/stale";
import { useViewerZone } from "../../../components/folios/actions";
import { FolioDays } from "../../../components/folios/list";
import { EmptyState } from "../../../components/ui";
import { page } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Possibly out of date · Artifacts · ${params.owner} · g1t` });
}

/** The most recently edited artifacts looked through for ones marked possibly out of date. */
const LOOK_AT = 100;

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ items: Folio[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await folios.list(params.owner.toLowerCase(), viewer, { tab: "all", limit: LOOK_AT }).catch(() => null);
  return { items: found?.ok ? found.value.items.filter((f) => f.stale) : null };
}

/** Artifacts whose cited code changed since someone last marked them current. */
export default function FoliosStale({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const zone = useViewerZone();
  const { items } = loaderData;
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <AlertTriangle size={18} className="text-warn" /> Possibly out of date
      </h1>
      <p className="mt-1 text-sm text-muted">A merged pull request or a push to a default branch changed code these artifacts cite. Read what changed, update it (or ask an agent to), then mark it current.</p>
      <div className="mt-6">
        {items === null ? (
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        ) : items.length === 0 ? (
          <EmptyState title="Everything is current">Nothing you can open cites code that changed since it was last checked.</EmptyState>
        ) : (
          <FolioDays slug={slug} items={items} zone={zone} />
        )}
      </div>
    </div>
  );
}
