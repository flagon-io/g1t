/**
 * What every Observability page loads first: that the viewer may see it,
 * and which project it is. Observability is for people with a role on the
 * project, even when its code is public: logs and request addresses can
 * hold what only the people running it should read. Its settings, tokens
 * and exports are for those who manage the project's integrations.
 */
import { data } from "react-router";

import type { Capability } from "@g1t/contracts";

import { requireInsider } from "./access.server";
import { projects, telemetry } from "./services.server";
import { parseView, filterOf, type View } from "./observability";

type Context = Parameters<typeof requireInsider>[0];
type Params = Parameters<typeof requireInsider>[1];

export async function observed(context: Context, params: Params, request: Request, capability: Capability = "read") {
  const { viewer, access, repo } = await requireInsider(context, params, capability);
  if (!telemetry) throw data("Observability is not set up on this installation.", { status: 503 });
  const found = await projects.get(params.owner ?? "", params.repo ?? "", viewer);
  if (!found.ok) throw data(null, { status: 404 });
  const view: View = parseView(new URL(request.url).searchParams);
  return {
    viewer,
    access,
    repo,
    project: found.value,
    projectId: found.value.id,
    service: telemetry,
    view,
    filter: filterOf(view),
  };
}

/** A part that fails shows as missing, with the page still up. */
export function soft<T>(work: Promise<T>, what: string): Promise<T | null> {
  return work.catch((error) => {
    console.warn(`observability ${what}:`, error);
    return null;
  });
}
