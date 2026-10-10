/**
 * An agent's old People address, `-/people/agents/:handle`. People lists
 * people only; an agent's profile is its page in Agents, so links to the
 * old address are sent there for good (lib/people.ts `agentPath`).
 */
import { redirect } from "react-router";

import type { Route } from "./+types/agent";
import { agentPath } from "../../../lib/people";

export function loader({ params }: Route.LoaderArgs) {
  return redirect(agentPath(params.owner.toLowerCase(), params.handle.toLowerCase()), 301);
}
