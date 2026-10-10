/**
 * Apps: what the workspace installed from the Marketplace that you can
 * use, the ones pinned to your dock first. Built-in apps are always in the
 * dock, and their own pages are in their sidebars; Apps are only what was
 * added. Pins are yours alone, per workspace, kept with your account so
 * every device shows the same dock (lib/dock.server.ts), with a copy in a
 * cookie for when the account's cannot be read (lib/apps.ts). The pin
 * buttons post here, and the launcher reads its list from here.
 */
import { Store } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/apps";
import { AppTile, NoApps, useAppPins } from "../../components/apps";
import { DOCK_COOKIE, type InstalledAppData, appData, appPinFromForm, dockCookie, installedApps, pinsToShow, withPin, writeDock } from "../../lib/apps";
import { connectedStates } from "../../lib/connected.server";
import { savePins, savedPins } from "../../lib/dock.server";
import { workspaceAgents } from "../../lib/services.server";
import { page } from "../../lib/meta";
import { readCookie } from "../../lib/mission";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Apps · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const membership = viewer?.workspaces?.find((m) => m.slug === slug);
  if (!viewer || !membership) throw data(null, { status: 404 });
  const [connected, installs, saved] = await Promise.all([
    connectedStates(slug, viewer).catch(() => null),
    workspaceAgents
      .extensionInstalls(slug, viewer)
      .then((result) => (result.ok ? result.value : []))
      .catch(() => []),
    savedPins(viewer, slug),
  ]);
  return {
    slug,
    name: membership.name?.trim() || slug,
    /** Null when what is installed could not be read. */
    apps: connected ? installedApps(connected, installs).map((app) => appData(app, slug)) : (null as InstalledAppData[] | null),
    pins: pinsToShow(saved, readCookie(request.headers.get("cookie"), DOCK_COOKIE), slug),
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!user.workspaces?.some((m) => m.slug === slug)) throw data(null, { status: 404 });
  const change = appPinFromForm(await request.formData());
  if (!change) return data({ error: "Nothing to do." }, { status: 400 });
  const cookie = readCookie(request.headers.get("cookie"), DOCK_COOKIE);
  // The change is made to the pins as the account keeps them; pins only
  // ever kept in this device's cookie are carried over by the first one.
  const current = pinsToShow(await savedPins(user, slug), cookie, slug);
  const pins = await savePins(user, slug, withPin(current, change.app, change.pinned));
  if (!pins) return data({ error: "Your pins could not be saved. Try again.", pins: current }, { status: 503 });
  // This device's copy, drawn from when the account's cannot be read.
  const secure = new URL(request.url).protocol === "https:";
  return data({ error: null, pins }, { headers: { "Set-Cookie": dockCookie(writeDock(cookie, slug, pins), secure) } });
}

export default function Apps({ loaderData }: Route.ComponentProps) {
  const { slug, name, apps } = loaderData;
  const { pins, toggle } = useAppPins(slug, loaderData.pins);
  const usable = (apps ?? []).filter((app) => app.usable);
  const pinned = pins.map((key) => usable.find((app) => app.key === key)).filter((app) => app != null);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            What {name} added from the Marketplace. Pin the ones you want in your dock: your dock is yours, and nobody else sees your pins.
          </p>
        </div>
        <Link
          to={`/${slug}/-/marketplace`}
          prefetch="intent"
          className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-fg/85 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg"
        >
          <Store size={15} />
          Browse the Marketplace
        </Link>
      </div>

      {apps == null ? (
        <p className="mt-8 rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-muted">What is installed can't be read right now. Reload in a minute.</p>
      ) : apps.length === 0 ? (
        <div className="mt-8">
          <NoApps slug={slug} />
        </div>
      ) : (
        <>
          <section aria-labelledby="pinned" className="mt-8">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="pinned" className="text-sm font-semibold">
                Pinned to your dock
              </h2>
              <span className="text-xs text-faint">{pinned.length === 0 ? "None yet" : `${pinned.length} pinned`}</span>
            </div>
            {pinned.length === 0 ? (
              <p className="mt-3 rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
                Nothing pinned yet. Pin an app below and it shows in your dock, under the built-in ones.
              </p>
            ) : (
              <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
                {pinned.map((app) => (
                  <AppTile key={app.key} app={app} pinned onToggle={toggle} card />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="installed" className="mt-10">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="installed" className="text-sm font-semibold">
                Installed
              </h2>
              <span className="text-xs text-faint">{apps.length}</span>
            </div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
              {apps.map((app) => (
                <AppTile key={app.key} app={app} pinned={pins.includes(app.key)} onToggle={toggle} card />
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
