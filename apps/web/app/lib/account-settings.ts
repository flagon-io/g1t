/**
 * Your own settings: one page for each part, at `/settings/<page>`, so the
 * docs, emails and messages can link to exactly the one they mean.
 */

export type AccountSettingsPage =
  | "profile"
  | "emails"
  | "notifications"
  | "invites"
  | "keys"
  | "tokens"
  | "github"
  | "applications"
  | "security-log";

/** Each page's name and what it is for, in the sidebar's order. */
export const ACCOUNT_SETTINGS: Record<AccountSettingsPage, { title: string; about: string }> = {
  profile: { title: "Profile", about: "Your picture, and what everyone sees on your profile." },
  emails: {
    title: "Emails",
    about:
      "Your primary address gets account mail and password resets. Any confirmed address signs you in and can reset your password, and commits that carry it are shown as yours.",
  },
  notifications: {
    title: "Notifications",
    about: "What you are also emailed for, and how you watch repositories. Everything comes to your inbox either way.",
  },
  invites: { title: "Invites", about: "Bring people to g1t, and see which invites were used." },
  keys: { title: "SSH keys", about: "Keys that let git on your computers reach g1t as you." },
  tokens: {
    title: "Access tokens",
    about:
      "Use a token as the password when git asks for one over HTTPS, and to authenticate agents and the API. A token here acts as you.",
  },
  github: {
    title: "GitHub",
    about: "Sign in with your GitHub account, and import or mirror repositories you can reach there.",
  },
  applications: {
    title: "Connected applications",
    about:
      "Applications you signed in to through your browser, such as an agent connected to the g1t MCP server. Signing one out ends its access at once.",
  },
  "security-log": {
    title: "Security log",
    about:
      "Changes to your addresses and password, by you or by g1t staff. If you do not recognise one, reset your password.",
  },
};

/** Where the first page is: `/settings` goes there. */
export const FIRST_SETTINGS_PAGE = "/settings/profile";

/**
 * The sections of the old single settings page, by their `#anchor`, and
 * the page each now has. Links like `g1t.sh/settings#emails` in old email
 * and bookmarks still land in the right place.
 */
const OLD_ANCHORS: Record<string, AccountSettingsPage> = {
  picture: "profile",
  profile: "profile",
  emails: "emails",
  github: "github",
  invites: "invites",
  "ssh-keys": "keys",
  tokens: "tokens",
  applications: "applications",
  "security-log": "security-log",
};

/** The page an old `#anchor` of the settings page now lives at, if it was one. */
export function settingsPathForHash(hash: string): string | null {
  const page = OLD_ANCHORS[hash.replace(/^#/, "")];
  return page ? `/settings/${page}` : null;
}

/** Which settings page a path is, or null when it is none. */
export function accountSettingsPage(pathname: string): AccountSettingsPage | null {
  const match = /^\/settings\/([^/]+)\/?$/.exec(pathname);
  const page = match?.[1];
  return page && page in ACCOUNT_SETTINGS ? (page as AccountSettingsPage) : null;
}
