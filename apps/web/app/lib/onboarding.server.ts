/**
 * Reads Getting started for a workspace's owner: their own state from
 * identity (`onboarding`), and each step's facts from the services that
 * keep them, all at once. A service that does not answer leaves its fact
 * null, and its step not done, rather than failing the page. Never awaited
 * by a page: Home and the Workspace page stream it, and the dialog opens
 * when it arrives (lib/onboarding.ts says when).
 */
import type { AiConnection, AskSetup, Onboarding, OnboardingChange, OnboardingStep, User, Viewer } from "@g1t/contracts";

import { githubApp } from "./github.server";
import { invitationFilterOf } from "./invites";
import { type OnboardingFacts, type OnboardingView, stepsFrom, withSkipped } from "./onboarding";
import { runners } from "./runners.server";
import { ai, billing, identity } from "./services.server";
import { roleIn } from "./session.server";
import { workspaceProjects } from "./workspace-projects.server";

/** Whether `viewer` is a person who owns `slug`: the only ones the guide is for. */
export function guideIsFor(viewer: Viewer, slug: string): viewer is User {
  return viewer != null && (viewer.kind ?? "user") === "user" && roleIn(viewer, slug) === "owner";
}

/** The g1t CLI names the token it signs in with `g1t CLI on <machine>` (crates/g1t, `g1t auth login`). */
const CLI_TOKEN = /^g1t CLI\b/;

const settle = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);

/** The facts each step is judged by, and the providers and Ask's setup the AI steps show. */
async function factsFor(user: User, slug: string): Promise<{ facts: OnboardingFacts; connections: AiConnection[] | null; ask: AskSetup | null }> {
  const [providers, ask, projects, github, tokens, apps, members, invites, free, own] = await Promise.all([
    settle(ai.list(slug, user)),
    settle(ai.askSettings(slug, user)),
    settle(workspaceProjects(slug, user)),
    settle(githubApp.status(user, slug)),
    settle(identity.listAccessTokens(user)),
    settle(identity.listOAuthGrants(user)),
    settle(identity.listMembers(slug, user)),
    settle(identity.workspaceInvites(slug, user)),
    settle(billing.freeWorkspaces([slug])),
    settle(runners.list(user, { workspace: slug })),
  ]);
  const connections = providers?.ok ? providers.value : null;
  const setup = ask?.ok ? ask.value : null;
  const facts: OnboardingFacts = {
    providers: connections ? { total: connections.length, working: connections.filter((c) => !c.lastError).length } : null,
    askReady: setup ? Boolean(setup.provider_id && !setup.problem) : null,
    askWith: setup?.provider_id ? [setup.provider_name, setup.auto ? "Auto" : setup.model].filter(Boolean).join(" · ") : null,
    projects: projects?.ok ? projects.value.length : null,
    github: github?.ok ? { configured: github.value.configured, connected: github.value.installations.some((i) => !i.suspended) } : null,
    cli: tokens ? tokens.some((token) => CLI_TOKEN.test(token.name)) : null,
    harnessApp: apps ? apps.length > 0 : null,
    people: members?.ok
      ? {
          others: members.value.filter((member) => member.username !== user.username).length,
          pending: invites?.ok ? invites.value.filter((invite) => invitationFilterOf(invite.status) === "pending").length : 0,
        }
      : null,
    invitesNeedPlan: free ? free.includes(slug) : false,
    runners: own?.ok ? own.value.length : null,
  };
  return { facts, connections, ask: setup };
}

/**
 * Getting started for `viewer` in `slug`, or null when it is not for them
 * or identity did not answer. `opening`: for a page where it only opens by
 * itself (Home, the Workspace page), so once the person has dismissed it
 * the facts are not read at all and this is null.
 */
export async function loadOnboarding(viewer: Viewer, slug: string, opening = false): Promise<OnboardingView | null> {
  if (!guideIsFor(viewer, slug)) return null;
  const stateP = settle(identity.onboarding(viewer, slug));
  if (opening) {
    const state = await stateP;
    if (!state?.ok || state.value.dismissed_at != null) return null;
  }
  const [state, read] = await Promise.all([stateP, factsFor(viewer, slug)]);
  if (!state?.ok) return null;
  const name = viewer.workspaces?.find((membership) => membership.slug === slug)?.name?.trim() || slug;
  const { facts, connections, ask } = read;
  return { slug, name, state: state.value, facts, connections, ask, steps: stepsFrom(facts, state.value) };
}

/** Saves a change to `user`'s own Getting started in `slug`: as kept, or the reason it was refused. */
export async function saveOnboarding(user: User, slug: string, change: OnboardingChange): Promise<{ state: Onboarding } | { error: string }> {
  try {
    const saved = await identity.setOnboarding(user, slug, change);
    return saved.ok ? { state: saved.value } : { error: saved.error.message };
  } catch (error) {
    console.error("onboarding: could not be saved", error);
    return { error: "Getting started couldn't be saved. Try again." };
  }
}

/** Skips `step`, or takes it back, keeping the other steps as the person left them. */
export async function skipStep(user: User, slug: string, step: OnboardingStep, skip: boolean): Promise<{ state: Onboarding } | { error: string }> {
  const current = await settle(identity.onboarding(user, slug));
  if (!current?.ok) return { error: current ? current.error.message : "Getting started couldn't be read. Try again." };
  return saveOnboarding(user, slug, { skipped: withSkipped(current.value.skipped, step, skip) });
}
