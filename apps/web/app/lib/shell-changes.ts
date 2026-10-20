/**
 * Whether a form or fetcher submission may have changed what the frame
 * around every page shows: the account and its workspaces, the sidebar's
 * projects and pins, the workspace's plan and spend, the inbox's views and
 * a project's open counts. The root and the workspace layouts reload after
 * those and keep what they have after the rest (a comment, a review, a
 * label), which is nearly every submission and would otherwise pay for the
 * whole sidebar, billing included, each time.
 *
 * Unread counts in the rail and chat's sidebar come from the feed socket
 * (lib/notify-client.ts), and chat's own posts go by `fetch`, so neither
 * needs a reload here. When in doubt a page belongs on these lists: a
 * reload too many costs a moment, one too few shows something stale.
 */

/** Pages outside any workspace whose submissions change the account, its workspaces or the inbox. */
const ACCOUNT_PAGES = new Set([
  "auth",
  "confirm-email",
  "invitations",
  "invite",
  "login",
  "logout",
  "new",
  "notifications",
  "register",
  "reset",
  "settings",
  "verify",
  "workspaces",
]);

/**
 * A workspace's pages (`/:owner/-/<page>`) whose submissions change its
 * name or members, its projects and pins, its plan and spend, or the AI
 * providers its agent default is chosen from.
 */
const WORKSPACE_PAGES = new Set([
  "ai",
  "apps",
  "billing",
  "code-access",
  "integrations",
  "members",
  "people",
  "permissions",
  "pins",
  "projects",
  "provider-costs",
  "repositories",
  "settings",
  "sso",
  "teams",
  "usage",
]);

/**
 * A project's pages (`/:owner/:repo/<page>`) whose submissions rename,
 * move, share or delete it, or make a project of it ("" is its overview,
 * where its kind is set).
 */
const PROJECT_PAGES = new Set(["", "fork", "invitations", "settings"]);

/** What a pull request's page does that changes the project's open count. */
const OPENS_OR_CLOSES = new Set(["close", "merge", "reopen"]);

/** Whether a submission to `formAction`, with `formData`, may have changed the frame. */
export function changesShell(formAction: string | undefined, formData?: FormData): boolean {
  // Not known where it went: reload, as before.
  if (!formAction) return true;
  const [first = "", second = "", third = "", fourth = ""] = new URL(formAction, "https://g1t.invalid").pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (ACCOUNT_PAGES.has(first)) return true;
  if (second === "") return false;
  if (second === "-") return WORKSPACE_PAGES.has(third);
  // A new pull request is one more open; only "pulls/new" makes one.
  if (third === "pulls") return fourth === "new";
  if (third === "pull") return OPENS_OR_CLOSES.has(String(formData?.get("action") ?? ""));
  return PROJECT_PAGES.has(third);
}
