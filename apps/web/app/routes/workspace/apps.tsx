/**
 * Apps: the integrations the workspace connected that you can use, the ones
 * pinned to your rail first. Built-in apps are always in the
 * rail, and their own pages are in their sidebars; Apps are only what was
 * added. Pins are yours alone, per workspace, kept with your account so
 * every device shows the same dock (lib/dock.server.ts), with a copy in a
 * cookie for when the account's cannot be read (lib/apps.ts). The pin
 * buttons post here, and the launcher reads its list from here.
 */
import { Plug } from "lucide-react";
import { data } from "react-router";

import type { Route } from "./+types/apps";
import { AppTile, NoApps, useAppPins } from "../../components/apps";
import { ButtonLink } from "../../components/ui";
import { DOCK_COOKIE, type InstalledAppData, appData, appPinFromForm, dockCookie, installedApps, pinsToShow, withPin, writeDock } from "../../lib/apps";
import { connectedStates } from "../../lib/connected.server";
import { savePins, savedPins } from "../../lib/dock.server";
import { page } from "../../lib/meta";
import { readCookie } from "../../lib/mission";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { Card } from "../../components/ui/card";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Apps · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const membership = viewer?.workspaces?.find((m) => m.slug === slug);
  if (!viewer || !membership) throw data(null, { status: 404 });
  const [connected, saved] = await Promise.all([connectedStates(slug, viewer).catch(() => null), savedPins(viewer, slug)]);
  return {
    slug,
    name: membership.name?.trim() || slug,
    /** Null when what is installed could not be read. */
    apps: connected ? installedApps(connected).map((app) => appData(app, slug)) : (null as InstalledAppData[] | null),
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
            The integrations {name} connected. Pin the ones you want in your rail: your rail is yours, and nobody else sees your pins.
          </p>
        </div>
        <ButtonLink to={`/${slug}/-/integrations`} prefetch="intent" variant="outline">
          <Plug size={15} />
          Integrations
        </ButtonLink>
      </div>

      {apps == null ? (
        <Card asChild className="mt-8 px-4 py-6 text-center text-sm text-muted">
          <p>What is installed can't be read right now. Reload in a minute.</p>
        </Card>
      ) : apps.length === 0 ? (
        <div className="mt-8">
          <NoApps slug={slug} />
        </div>
      ) : (
        <>
          <section aria-labelledby="pinned" className="mt-8">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="pinned" className="text-sm font-semibold">
                Pinned to your rail
              </h2>
              <span className="text-xs text-faint">{pinned.length === 0 ? "None yet" : `${pinned.length} pinned`}</span>
            </div>
            {pinned.length === 0 ? (
              <Card asChild tone="plain" className="mt-3 border-dashed px-4 py-6 text-center text-sm text-muted">
                <p>
                  Nothing pinned yet. Pin an app below and it shows in your rail, under the built-in ones.
                </p>
              </Card>
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
