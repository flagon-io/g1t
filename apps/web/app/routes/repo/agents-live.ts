/**
 * A project's agent runs as JSON, for the parts of other pages that show
 * them live (a pull request's Agent panel, the pull request list), and
 * the one place runs are stopped and messaged from.
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";

import { RUN_KINDS, type RunKind, takesMessages } from "@g1t/contracts";

import type { Route } from "./+types/agents-live";
import { agents, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer } from "../../lib/session.server";
import { accessTo, refusal } from "../../lib/access.server";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const query = new URL(request.url).searchParams;
  const number = Number(query.get("number"));
  const kind = query.get("kind");
  const found = await agents.listRuns(viewer, {
    repo: { namespace: params.owner, name: params.repo },
    active: query.get("active") === "1",
    number: number > 0 ? number : undefined,
    kind: kind && RUN_KINDS.includes(kind as RunKind) ? (kind as RunKind) : undefined,
    limit: Math.min(Number(query.get("limit")) || 50, 200),
  });
  if (!found.ok) throw data({ error: found.error.message }, { status: 404 });
  return Response.json(
    { runs: found.value, member: (await accessTo(context, params)).can.run },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = getViewer(context);
  if (!viewer) return { ok: false, error: "Sign in first." };
  const path = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // Stopping or messaging an agent needs Write: Read cannot spend compute.
  const refused = await refusal(context, params, "run");
  if (refused) return { ok: false, error: refused };
  if (intent === "stop") {
    const stopped = await env.RUNNER.stopRun(viewer, path, String(form.get("run") ?? ""));
    return stopped.ok ? { ok: true, notice: "Stopped." } : { ok: false, error: stopped.error.message };
  }
  if (intent === "message") {
    const number = Number(form.get("number"));
    const sent = await work.messageAgent(viewer, path, number, String(form.get("body") ?? ""));
    if (!sent.ok) return { ok: false, error: sent.error.message };
    // Whether the agent reads it now, or its next run on the pull request does.
    const active = await agents.listRuns(viewer, { repo: path, number, active: true, limit: 1 });
    const run = active.ok ? active.value[0] : undefined;
    return {
      ok: true,
      notice:
        run && takesMessages(run.kind)
          ? "Sent. The agent reads it at its next step."
          : "Sent. This run does not read messages while it works, so the agent's next run on this pull request gets it.",
    };
  }
  return { ok: false, error: "Unknown action." };
}
