/**
 * The card that opens over a person's name or avatar: who they are, as
 * their public profile says, and how they relate to what the viewer is
 * looking at. Only what the viewer may see: workspaces through
 * `profile_workspaces` (those the viewer shares with them, and those they
 * made a public project in), and commits to a repository only when the
 * viewer may read it. Never an address.
 *
 * The body is snake_case, like every API body g1t answers with.
 */
import type { Contributors, Profile, ProfileWorkspace, RepoPath, Result, Viewer } from "@g1t/contracts";

/** How recently someone committed to the repository the card opened in. */
export type CommittedWithin = "day" | "week" | "month";

export type UserCard = {
  kind: "user";
  username: string;
  name: string | null;
  pronouns: string | null;
  bio: string | null;
  location: string | null;
  avatar: string | null;
  /** Workspaces the viewer may know they belong to, at most `MAX_WORKSPACES`. */
  workspaces: { slug: string; name: string; avatar: string | null }[];
  /** Workspaces past those listed. */
  more_workspaces: number;
  /** Their latest commit to the repository, by how long ago; null when none or not asked. */
  committed: CommittedWithin | null;
};

/** g1t itself: no profile, a card of its own. */
export type G1tCard = { kind: "g1t"; username: "g1t" };

export type Card = UserCard | G1tCard;

export const MAX_WORKSPACES = 3;

const DAY_MS = 86_400_000;

/** `day`, `week` or `month` for a commit at `at` (RFC 3339), else null. */
export function committedWithin(at: string | null | undefined, now: number): CommittedWithin | null {
  if (!at) return null;
  const ago = now - Date.parse(at);
  if (!Number.isFinite(ago) || ago < -DAY_MS) return null;
  if (ago <= DAY_MS) return "day";
  if (ago <= 7 * DAY_MS) return "week";
  if (ago <= 31 * DAY_MS) return "month";
  return null;
}

/** The line the card shows for it. */
export function committedLabel(within: CommittedWithin): string {
  return `Committed to this repository in the past ${within}`;
}

/** `owner/name` from the card's `repo` parameter, or null. */
export function parseRepo(value: string | null | undefined): RepoPath | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9._-]{1,100})$/.exec(value?.trim() ?? "");
  return match ? { namespace: match[1]!, name: match[2]! } : null;
}

/** What building a card reads, so tests can stand in for the services. */
export type CardSources = {
  profile(username: string): Promise<Profile | null>;
  /** The account's id, to find where it has public projects. */
  accountId(username: string): Promise<string | null>;
  publicNamespaces(userId: string): Promise<string[]>;
  profileWorkspaces(username: string, viewer: Viewer, publicIn: string[]): Promise<ProfileWorkspace[]>;
  contributors(path: RepoPath, viewer: Viewer): Promise<Result<Contributors>>;
};

/**
 * The card for `username` as `viewer` sees it, opened in `repo` if any;
 * null when there is nobody by that name (or for ghost, a deleted
 * account, which has no card).
 */
export async function buildCard(
  username: string,
  viewer: Viewer,
  repo: RepoPath | null,
  sources: CardSources,
  now: number,
): Promise<Card | null> {
  const name = username.trim().toLowerCase();
  if (name === "g1t") return { kind: "g1t", username: "g1t" };
  if (!/^[a-z0-9-]{1,39}$/.test(name) || name === "ghost") return null;
  const profile = await sources.profile(name).catch(() => null);
  if (!profile) return null;
  const workspaces = sources
    .accountId(profile.username)
    .then((id) => (id ? sources.publicNamespaces(id) : []))
    .catch(() => [] as string[])
    .then((publicIn) => sources.profileWorkspaces(profile.username, viewer, publicIn))
    .catch(() => [] as ProfileWorkspace[]);
  // The repository answers for the viewer: one they cannot read says nothing.
  const committed = repo
    ? sources
        .contributors(repo, viewer)
        .then((found) => {
          if (!found.ok) return null;
          const them = found.value.contributors.find((one) => one.username?.toLowerCase() === profile.username.toLowerCase());
          return committedWithin(them?.lastAt, now);
        })
        .catch(() => null)
    : Promise.resolve(null);
  const [shown, within] = await Promise.all([workspaces, committed]);
  return {
    kind: "user",
    username: profile.username,
    name: profile.name,
    pronouns: profile.pronouns,
    bio: profile.bio,
    location: profile.location,
    avatar: profile.avatar,
    workspaces: shown.slice(0, MAX_WORKSPACES).map((one) => ({ slug: one.slug, name: one.name, avatar: one.avatar })),
    more_workspaces: Math.max(0, shown.length - MAX_WORKSPACES),
    committed: within,
  };
}

/** Where the card for `username` is read from, opened in `repo` if any. */
export function cardHref(username: string, repo: string | null): string {
  const path = `/-/hovercard/user/${encodeURIComponent(username.toLowerCase())}`;
  return repo ? `${path}?repo=${encodeURIComponent(repo)}` : path;
}
