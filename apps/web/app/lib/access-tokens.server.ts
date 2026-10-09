import type { AccessToken, User, Viewer } from "@g1t/contracts";
import { data } from "react-router";

import type { WorkspaceChoice } from "../components/token-form";
import { identity, repos } from "./services.server";
import { unwrap } from "./session.server";

/** Each workspace you belong to, with its rules for tokens and the repositories you can choose from. */
export async function workspaceChoices(user: User): Promise<WorkspaceChoice[]> {
  return Promise.all(
    (user.workspaces ?? []).map(async (membership): Promise<WorkspaceChoice> => {
      const [policy, listed] = await Promise.all([
        identity.getTokenPolicy(membership.slug, user),
        repos.list(user, { namespace: membership.slug }).catch(() => []),
      ]);
      return {
        slug: membership.slug,
        owner: membership.role === "owner",
        policy: policy.ok ? policy.value : null,
        repos: listed.map((repo) => `${repo.namespace}/${repo.name}`).sort(),
      };
    }),
  );
}

/** A workspace's repositories, as `owner/name`, for choosing a token's. */
export async function workspaceRepos(viewer: Viewer, slug: string): Promise<string[]> {
  const listed = await repos.list(viewer, { namespace: slug }).catch(() => []);
  return listed.map((repo) => `${repo.namespace}/${repo.name}`).sort();
}

/** One of your own tokens, or a 404. */
export async function personalToken(user: User, id: string): Promise<AccessToken> {
  const token = (await identity.listAccessTokens(user)).find((token) => token.id === id);
  if (!token) throw data("No such token.", { status: 404 });
  return token;
}

/** One of a workspace's own tokens, or a 404. */
export async function workspaceToken(viewer: Viewer, slug: string, id: string): Promise<AccessToken> {
  const token = unwrap(await identity.listWorkspaceTokens(slug, viewer)).find((token) => token.id === id);
  if (!token) throw data("No such token.", { status: 404 });
  return token;
}
