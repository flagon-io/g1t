import type { MirrorAddInput, MirrorView, Result } from "@g1t/contracts";

import type { Route } from "./+types/settings-mirroring";
import { type MirrorOutcome, MirroringSettings } from "../../components/mirror-settings";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { page } from "../../lib/meta";
import { decisionsFrom, mirrorSettingsFrom } from "../../lib/mirror";
import { refusal, requireInsider } from "../../lib/access.server";
import { mirrors, repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Mirroring · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  const { viewer, repo } = await requireInsider(context, params, "manage_integrations");
  const mirror = repo.mirror ?? null;
  // The hand-back plan asks the remote about every branch, so it is read
  // only when someone asks to review it, and only while g1t has taken over.
  const planRequested = new URL(request.url).searchParams.has("plan") && mirror?.state === "takeover";
  if (planRequested && viewer) {
    const planned = await mirrors.plan(viewer, repo.id);
    if (planned.ok) return { mirror, view: planned.value, planRequested, planError: null };
    return { mirror, view: unwrap(await mirrors.view(viewer, repo.id)), planRequested, planError: planned.error.message };
  }
  return { mirror, view: unwrap(await mirrors.view(viewer, repo.id)), planRequested, planError: null };
}

export async function action({ request, params, context }: Route.ActionArgs): Promise<MirrorOutcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const failed = (error: string): MirrorOutcome => ({ intent, ok: false, message: null, error });
  const [refused, found] = await Promise.all([
    refusal(context, params, "manage_integrations"),
    repos.get({ namespace: params.owner, name: params.repo }, user),
  ]);
  if (refused) return failed(refused);
  if (!found.ok) return failed(found.error.message);
  const repoId = found.value.id;
  const done = (result: Result<MirrorView | unknown>, message: string | null): MirrorOutcome =>
    result.ok
      ? {
          intent,
          ok: true,
          message,
          error: null,
          notes: (result.value as Partial<MirrorView> | null)?.notes ?? [],
        }
      : failed(result.error.message);
  switch (intent) {
    case "take-over":
      return done(await mirrors.takeOver(user, repoId), "g1t leads now.");
    case "ci-on":
      return done(await mirrors.ci(user, repoId, true), "CI failover is on.");
    case "ci-off":
      return done(await mirrors.ci(user, repoId, false), "CI failover is off.");
    case "sync":
      return done(await mirrors.sync(user, repoId), "Synced.");
    case "hand-back":
      return done(await mirrors.handBack(user, repoId, decisionsFrom(form.entries())), "Handing back.");
    case "move-in":
      return done(await mirrors.moveIn(user, repoId, form.get("keepRemoteUpdated") === "on"), "Moved to g1t.");
    case "settings": {
      // The settings the form does not carry keep their values.
      const view = await mirrors.view(user, repoId);
      if (!view.ok) return failed(view.error.message);
      const remote = view.value.remotes.find((one) => one.id === String(form.get("remoteId") ?? ""));
      if (!remote) return failed("That remote is no longer linked to this repository.");
      return done(await mirrors.settings(user, remote.id, mirrorSettingsFrom(form, remote.settings)), "Saved.");
    }
    case "add": {
      const text = (name: string) => String(form.get(name) ?? "").trim() || null;
      const input: MirrorAddInput = {
        provider: form.get("provider") === "g1t" ? "g1t" : "git",
        role: form.get("role") === "leader" ? "leader" : "follower",
        url: text("url") ?? "",
        username: text("username"),
        token: text("token"),
      };
      const added = await mirrors.add(user, repoId, input);
      return added.ok ? { intent, ok: true, message: `Added ${added.value.name}.`, error: null } : failed(added.error.message);
    }
    case "remove":
      return done(await mirrors.remove(user, String(form.get("remoteId") ?? "")), "Removed.");
  }
  return failed("Unknown action.");
}

export default function Mirroring({ loaderData, actionData, params }: Route.ComponentProps) {
  const base = `/${params.owner}/${params.repo}`;
  return (
    <>
      <RepoSettingsHeading base={base} />
      <MirroringSettings
        base={base}
        full={`${params.owner}/${params.repo}`}
        mirror={loaderData.mirror}
        view={loaderData.view}
        planRequested={loaderData.planRequested}
        planError={loaderData.planError}
        result={actionData}
      />
    </>
  );
}
