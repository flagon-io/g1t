import type { CommitMessageDefault, MergeChoices, MergeMethod, RepoSettings } from "@g1t/contracts";

/** Every way a pull request can land, in the order they are offered. */
export const MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase", "fast_forward"];

/** How each method is named and explained: in settings, on the merge button, and once merged. */
export const METHOD_INFO: Record<MergeMethod, { label: string; short: string; action: string; past: string; about: string; setting: keyof RepoSettings }> = {
  merge: {
    label: "Merge commits",
    short: "Merge",
    action: "Create a merge commit",
    past: "a merge commit",
    about: "Every commit of the pull request is added to the base branch through a merge commit.",
    setting: "allowMergeCommit",
  },
  squash: {
    label: "Squash merging",
    short: "Squash",
    action: "Squash and merge",
    past: "squash",
    about: "The pull request's commits are combined into one commit on the base branch.",
    setting: "allowSquashMerge",
  },
  rebase: {
    label: "Rebase merging",
    short: "Rebase",
    action: "Rebase and merge",
    past: "rebase",
    about: "The pull request's commits are made again, one by one, on top of the base branch, with no merge commit.",
    setting: "allowRebaseMerge",
  },
  fast_forward: {
    label: "Fast-forward merging",
    short: "Fast-forward",
    action: "Fast-forward",
    past: "fast-forward",
    about:
      "The base branch moves to the pull request's head as it is: the same commits, the same hashes, nothing new written. Only possible when the pull request is up to date with its base.",
    setting: "allowFastForward",
  },
};

/** Whether a string is a merge method. */
export function isMergeMethod(value: unknown): value is MergeMethod {
  return typeof value === "string" && (MERGE_METHODS as readonly string[]).includes(value);
}

/** The methods a repository's settings allow, in order. */
export function allowedMethods(settings: Pick<RepoSettings, "allowMergeCommit" | "allowSquashMerge" | "allowRebaseMerge" | "allowFastForward">): MergeMethod[] {
  return MERGE_METHODS.filter((method) => settings[METHOD_INFO[method].setting as keyof typeof settings]);
}

/** Whether a method writes a commit whose message can be chosen. */
export function writesMessage(method: MergeMethod): boolean {
  return method === "merge" || method === "squash";
}

/** The default commit message choices for merge commits, then squash commits. */
export const MESSAGE_CHOICES: Record<"merge" | "squash", { value: CommitMessageDefault; label: string }[]> = {
  merge: [
    { value: "default", label: "Default message" },
    { value: "pull_title", label: "Pull request title" },
    { value: "pull_title_and_description", label: "Pull request title and description" },
    { value: "custom", label: "Custom template" },
  ],
  squash: [
    { value: "default", label: "Default message" },
    { value: "pull_title", label: "Pull request title" },
    { value: "pull_title_and_commits", label: "Pull request title and commit details" },
    { value: "pull_title_and_description", label: "Pull request title and description" },
    { value: "custom", label: "Custom template" },
  ],
};

/** What a custom template can say, each filled in from the pull request. */
export const PLACEHOLDERS: { name: string; about: string }[] = [
  { name: "title", about: "Its title" },
  { name: "number", about: "Its number, without #" },
  { name: "body", about: "Its description" },
  { name: "branch", about: "The branch it merges from" },
  { name: "head_repo", about: "The repository that branch is in, as owner/name" },
  { name: "base", about: "The branch it merges into" },
  { name: "author", about: "Its author's username" },
  { name: "commits", about: "Its commits' subjects, one * subject line each" },
  { name: "items", about: "The work items it closes, as #12, #14" },
  { name: "co_authors", about: "A Co-authored-by line for each author of its commits, each once" },
];

/** One commit a pull request adds, as its message says. */
export type PullCommit = { message: string; authorEmail: string | null };

/**
 * What a default message is made from: the work service's `MessageFacts`
 * (services/work/src/merge_message.rs), which this mirrors exactly.
 */
export type TemplatePull = {
  number: number;
  title: string;
  body: string;
  /** The branch holding the change. */
  branch: string;
  /** Who the branch belongs to: the workspace of the repository or fork it is in. */
  headOwner: string;
  /** The repository or fork holding it, `owner/name`. */
  headRepo: string;
  /** The branch it merges into. */
  base: string;
  /** Its author's username. */
  author: string;
  /** Its commits, oldest first, merge commits left out. */
  commits: PullCommit[];
  /** The work items it closes. */
  items: number[];
};

/** A made-up pull request, to show what a choice or a template says. */
export const SAMPLE_PULL: TemplatePull = {
  number: 128,
  title: "Retry failed webhook deliveries",
  body: "Deliveries that time out are retried three times, with backoff.",
  branch: "webhook-retries",
  headOwner: "acme",
  headRepo: "acme/api",
  base: "main",
  author: "ana",
  commits: [
    { message: "Retry deliveries that time out", authorEmail: "ana@example.com" },
    { message: "Back off between retries\n\nDoubling each time, up to a minute.", authorEmail: "ben@example.com" },
    { message: "Test the retry schedule", authorEmail: "ana@example.com" },
  ],
  items: [97],
};

/** A commit message as a title (its first line) and the rest. */
export type CommitText = { title: string; message: string };

/** A whole message as its title (first line) and body (the rest, blank lines around it dropped). */
export function splitMessage(text: string): CommitText {
  const whole = text.trim();
  const at = whole.indexOf("\n");
  return at < 0 ? { title: whole, message: "" } : { title: whole.slice(0, at).trim(), message: whole.slice(at + 1).trim() };
}

/** A commit message's first line. */
function subject(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}

/** `* subject` for each commit, one per line. */
function bullets(commits: readonly PullCommit[]): string {
  return commits
    .map((commit) => subject(commit.message))
    .filter((line) => line !== "")
    .map((line) => `* ${line}`)
    .join("\n");
}

/** `Co-authored-by:` lines for the commits' authors, each once. */
function coAuthors(commits: readonly PullCommit[]): string {
  const seen: string[] = [];
  for (const commit of commits) {
    if (commit.authorEmail == null) continue;
    const email = commit.authorEmail.trim().toLowerCase();
    if (email !== "" && !seen.includes(email)) seen.push(email);
  }
  return seen.map((email) => `Co-authored-by: ${email.split("@")[0]} <${email}>`).join("\n");
}

/**
 * `template` with each `{name}` replaced once, left to right: what a value
 * holds is never filled in again. Unknown names stay as written.
 */
function fill(template: string, values: Record<string, string>): string {
  let out = "";
  let rest = template;
  for (let open = rest.indexOf("{"); open >= 0; open = rest.indexOf("{")) {
    out += rest.slice(0, open);
    const after = rest.slice(open + 1);
    const close = after.indexOf("}");
    const name = close >= 0 ? after.slice(0, close) : null;
    if (name != null && Object.prototype.hasOwnProperty.call(values, name)) {
      out += values[name];
      rest = after.slice(close + 1);
    } else {
      out += "{";
      rest = after;
    }
  }
  return out + rest;
}

/** A template with its placeholders filled in: its first line the title, the rest the message. */
export function fillTemplate(template: string, pull: TemplatePull): CommitText {
  return splitMessage(
    fill(template, {
      title: pull.title.trim(),
      number: String(pull.number),
      body: pull.body.trim(),
      branch: pull.branch,
      head_repo: pull.headRepo,
      base: pull.base,
      author: pull.author,
      commits: bullets(pull.commits),
      items: pull.items.map((number) => `#${number}`).join(", "),
      co_authors: coAuthors(pull.commits),
    }),
  );
}

/** The repository's template filled in, or null when there is none or its title comes out empty. */
function custom(template: string | null, pull: TemplatePull): CommitText | null {
  if (template == null) return null;
  const filled = fillTemplate(template, pull);
  return filled.title === "" ? null : filled;
}

/**
 * What a merge or squash commit says by default, as the repository chose:
 * exactly what the work service's `default_message` makes.
 */
export function defaultMessage(method: "merge" | "squash", choice: CommitMessageDefault, template: string | null, pull: TemplatePull): CommitText {
  const numbered = `${pull.title.trim()} (#${pull.number})`;
  const description = pull.body.trim();
  if (method === "merge") {
    // "Merge pull request #12 from owner/branch", and its title below.
    const merged = { title: `Merge pull request #${pull.number} from ${pull.headOwner}/${pull.branch}`, message: pull.title.trim() };
    switch (choice) {
      case "pull_title":
        return { title: numbered, message: "" };
      case "pull_title_and_description":
        return { title: numbered, message: description };
      case "custom":
        return custom(template, pull) ?? merged;
      // Listing commits is for squashes; settings refuse it for merges.
      default:
        return merged;
    }
  }
  // Its title and number; below, its commits' subjects when it has more than one.
  const squashed = { title: numbered, message: pull.commits.length > 1 ? bullets(pull.commits) : "" };
  switch (choice) {
    case "pull_title":
      return { title: numbered, message: "" };
    case "pull_title_and_description":
      return { title: numbered, message: description };
    case "pull_title_and_commits":
      return {
        title: numbered,
        message: pull.commits
          .map((commit) => commit.message.trim())
          .filter((message) => message !== "")
          .join("\n\n"),
      };
    case "custom":
      return custom(template, pull) ?? squashed;
    default:
      return squashed;
  }
}

const REMEMBERED = "g1t:merge-method:";

/** The method this viewer last merged with in a repository, if they did and it is still allowed. */
export function rememberedMethod(repo: string, allowed: readonly MergeMethod[]): MergeMethod | null {
  try {
    const value = window.localStorage.getItem(REMEMBERED + repo);
    return isMergeMethod(value) && allowed.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the method this viewer chose in a repository, for next time. */
export function rememberMethod(repo: string, method: MergeMethod) {
  try {
    window.localStorage.setItem(REMEMBERED + repo, method);
  } catch {
    // A private window: the choice lasts for this page.
  }
}

/**
 * What the merge box offers on one pull request: the methods it may merge
 * with (the repository's settings, narrowed by its base branch's rules), the
 * one offered first, what each commit says unless changed, and how it
 * stands against its base.
 */
export type MergeChoicesView = {
  methods: MergeMethod[];
  defaultMethod: MergeMethod;
  /**
   * For `merge` and `squash`: the commit's title and message as the
   * repository's choice makes them. Missing when the service could not say:
   * the merge box then sends only what the merger writes.
   */
  messages: Partial<Record<MergeMethod, CommitText>>;
  behind: boolean;
  /** Fast-forward needs the base to be an ancestor of its head. */
  canFastForward: boolean;
  autoMergeAllowed: boolean;
  /** Whether "Delete branch after merging" starts ticked. */
  deleteBranchDefault: boolean;
  /** Offer to update its branch whenever it is behind, not only when that is required. */
  suggestUpdate: boolean;
  /** Why a method cannot be used now, for those that cannot. */
  unavailable?: Partial<Record<MergeMethod, string>>;
  /** Its branch can be deleted once it merges. */
  canDeleteBranch?: boolean;
  /** Commits made merging it carry a `Signed-off-by:` trailer for the merger. */
  signOff?: boolean;
};

/** The merge box's choices as the work service worked them out. */
export function choicesFromService(choices: MergeChoices): MergeChoicesView {
  const messages: Partial<Record<MergeMethod, CommitText>> = {};
  const unavailable: Partial<Record<MergeMethod, string>> = {};
  for (const option of choices.options) {
    if (option.commitTitle != null) messages[option.method] = { title: option.commitTitle, message: option.commitMessage ?? "" };
    if (option.unavailable) unavailable[option.method] = option.unavailable;
  }
  return {
    methods: choices.methods,
    defaultMethod: choices.defaultMethod ?? choices.methods[0] ?? "merge",
    messages,
    behind: choices.behind,
    canFastForward: choices.canFastForward,
    autoMergeAllowed: choices.autoMergeAllowed,
    deleteBranchDefault: choices.deleteBranchDefault,
    suggestUpdate: choices.suggestUpdate,
    unavailable,
    canDeleteBranch: choices.canDeleteBranch,
    signOff: choices.signOff,
  };
}

/**
 * The merge box's choices worked out from the repository's settings, where
 * the service does not say. No default messages: the page cannot read the
 * pull request's commits, so what it made would differ from what the work
 * service writes; the merge box leaves the message to the service instead.
 */
export function choicesFromSettings(settings: RepoSettings, behind: boolean, ruleMethods: readonly MergeMethod[] = []): MergeChoicesView {
  const allowed = allowedMethods(settings).filter((method) => ruleMethods.length === 0 || ruleMethods.includes(method));
  const methods = allowed.length > 0 ? allowed : allowedMethods(settings);
  return {
    methods,
    defaultMethod: methods.includes(settings.defaultMergeMethod) ? settings.defaultMergeMethod : (methods[0] ?? "merge"),
    messages: {},
    behind,
    canFastForward: !behind,
    autoMergeAllowed: settings.allowAutoMerge,
    deleteBranchDefault: settings.deleteBranchOnMerge,
    suggestUpdate: settings.suggestUpdatingBranches,
  };
}
