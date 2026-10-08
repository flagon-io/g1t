/**
 * What a free workspace may not do, and the way forward: a free workspace
 * adds no one (members, invites, outside collaborators) until it starts the
 * plan, and a person owns at most one free workspace. Identity refuses both
 * either way; these say so before anyone tries.
 */
import { Sparkles } from "lucide-react";

import { ButtonLink } from "./ui";

/** Where a workspace's plan is started. */
export function planHref(workspace: string): string {
  return `/${workspace}/-/billing#plan`;
}

/** "Start the plan to invite people", with the button, for a free workspace's owners. */
export function StartPlanToInvite({
  workspace,
  owner,
  outside = false,
}: {
  workspace: string;
  owner: boolean;
  /** On a repository's Access page: members can still be given roles. */
  outside?: boolean;
}) {
  return (
    <div role="note" className="rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Sparkles size={16} className="hidden shrink-0 text-accent sm:block" aria-hidden />
        <div className="min-w-0 grow">
          <p className="text-sm font-medium">Start the plan to invite people</p>
          <p className="mt-1 text-sm text-muted">
            {workspace} is a free workspace, so it cannot add people
            {outside ? " from outside it. Its members can still be given a role here." : ". Its members stay as they are."}{" "}
            {owner ? "The plan is for everyone in the workspace at one price, never per person." : "An owner can start it."}
          </p>
        </div>
        {owner && (
          <span className="shrink-0">
            <ButtonLink to={planHref(workspace)}>Start the plan</ButtonLink>
          </span>
        )}
      </div>
    </div>
  );
}
