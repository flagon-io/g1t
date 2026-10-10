/**
 * Apps: every app in the workspace that you can use, the ones pinned to
 * your dock first. Built-in apps are always in the dock; the rest you pin
 * or unpin here, from the launcher, or on a phone from More. Pins are
 * yours alone, per workspace, kept in a cookie (lib/apps.ts) so the dock
 * is drawn right from the server. The pin buttons post here.
 */
import { Store } from "lucide-react";
import { data } from "react-router";

import { hasCodeAccess } from "@g1t/contracts";

import type { Route } from "./+types/apps";
import { AppTile, useAppPins } from "../../components/apps";
import { DOCK_COOKIE, type PinnableApp, appPinFromForm, appsFor, dockCookie, pinsIn, withPin, writeDock } from "../../lib/apps";
import { page } from "../../lib/meta";
import { readCookie } from "../../lib/mission";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Apps · ${params.owner} · g1t` });
}

export function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const slug = params.owner.toLowerCase();
  const membership = viewer?.workspaces?.find((m) => m.slug === slug);
  if (!membership) throw data(null, { status: 404 });
  return {
    slug,
    name: membership.name?.trim() || slug,
    code: hasCodeAccess(membership),
    pins: pinsIn(readCookie(request.headers.get("cookie"), DOCK_COOKIE), slug),
  };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  if (!user.workspaces?.some((m) => m.slug === slug)) throw data(null, { status: 404 });
  const change = appPinFromForm(await request.formData());
  if (!change) return data({ error: "Nothing to do." }, { status: 400 });
  const saved = readCookie(request.headers.get("cookie"), DOCK_COOKIE);
  const pins = withPin(pinsIn(saved, slug), change.app, change.pinned);
  const secure = new URL(request.url).protocol === "https:";
  return data({ error: null, pins }, { headers: { "Set-Cookie": dockCookie(writeDock(saved, slug, pins), secure) } });
}

export default function Apps({ loaderData }: Route.ComponentProps) {
  const { slug, name, code } = loaderData;
  const { pins, toggle } = useAppPins(slug, loaderData.pins);
  const apps = appsFor(code);
  const pinned = pins.map((key) => apps.find((app) => app.key === key)).filter((app) => app != null);
  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">
            Everything in {name} that you can use. Pin the ones you want in your dock: your dock is yours, and nobody else sees your pins.
          </p>
        </div>
        <span className="inline-flex h-9 items-center gap-2 rounded-md border border-line px-3 text-sm text-faint">
          <Store size={15} />
          Marketplace
          <span className="rounded-full bg-line px-1.5 text-[0.6875rem] font-medium text-muted">Coming</span>
        </span>
      </div>

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
              <AppTile key={app.key} app={app} slug={slug} pinned onToggle={toggle} card />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="yours" className="mt-10">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="yours" className="text-sm font-semibold">
            Your apps
          </h2>
          <span className="text-xs text-faint">Built-in apps are always in your dock</span>
        </div>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
          {apps.map((app) => (
            <AppTile key={app.key} app={app} slug={slug} pinned={pins.includes(app.key as PinnableApp)} onToggle={toggle} card />
          ))}
        </div>
      </section>
    </main>
  );
}
