/**
 * The parts of signing in with GitHub and installing g1t's GitHub App that
 * the site itself decides: the cookies that bind a trip to GitHub to the
 * browser that started it, and checking what comes back.
 */

/** The state sent to GitHub to sign in or link, for ten minutes. */
export const STATE_COOKIE = "g1t_github_state";
/** A GitHub sign-in waiting on a username, or on signing in to link. */
export const PENDING_COOKIE = "g1t_github_pending";
/** A sign-in that gave the right password and waits for a two-factor code: identity's challenge. */
export const TWO_FACTOR_COOKIE = "g1t_two_factor";
/** How long that waits, in seconds, as identity's `TWO_FACTOR_CHALLENGE_SECONDS`. */
export const TWO_FACTOR_SECONDS = 600;
/** An installation under way: its state and the workspace it is for. */
export const INSTALL_COOKIE = "g1t_github_install";

/** The value of a cookie, or null. Values here are hex and slugs only. */
export function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=");
      return /^[0-9a-z.-]{1,200}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** A `Set-Cookie` value: HttpOnly, Secure, same-site Lax; 0 clears it. */
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * Whether the state GitHub sent back is the one this browser was given.
 * Both must be present: a callback without the cookie came from somewhere
 * else.
 */
export function stateMatches(fromCookie: string | null, fromGithub: string | null): boolean {
  if (!fromCookie || !fromGithub) return false;
  return sameString(fromCookie, fromGithub);
}

/** The install cookie's value: `<state>.<workspace>`. */
export function installCookieValue(state: string, workspace: string): string {
  return `${state}.${workspace}`;
}

/** The workspace an installation was started for, if the state matches. */
export function installWorkspace(fromCookie: string | null, fromGithub: string | null): string | null {
  if (!fromCookie) return null;
  const dot = fromCookie.indexOf(".");
  if (dot < 0) return null;
  const state = fromCookie.slice(0, dot);
  const workspace = fromCookie.slice(dot + 1);
  return stateMatches(state, fromGithub) && workspace ? workspace : null;
}

/** A fresh random state: 32 bytes, hex. */
export function newState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What each way of bringing a repository across does, for the picker. */
export const MODES = [
  {
    id: "import",
    title: "Import",
    text: "Copy it once: every branch and tag, and its issues if you like. The copy on g1t is then its own.",
  },
  {
    id: "mirror",
    title: "Standby mirror",
    text: "g1t keeps a read-only copy that follows GitHub. Take over whenever you need to work here.",
  },
  {
    id: "push",
    title: "Move to g1t",
    text: "g1t leads; GitHub follows every push.",
  },
] as const;
