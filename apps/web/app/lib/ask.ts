/**
 * Ask g1t (lib/ask-in-chat.ts): where the person is when they ask,
 * which goes with each question to their direct message with @g1t, so g1t
 * is told the page and reads the work item or pull request on it. Pure, so it
 * is tested on its own.
 */
import type { AskEvent, AskPage, AskProposalState, AskSource, AskToolStatus } from "@g1t/contracts";

/** First path segments that are g1t's own pages, never a workspace. */
const RESERVED = new Set([
  "settings",
  "u",
  "auth",
  "oauth",
  "integrations",
  "new",
  "invite",
  "workspaces",
  "device",
  "verify",
  "confirm-email",
  "login",
  "register",
  "logout",
  "forgot",
  "reset",
  "search",
  "status",
  "avatars",
  "docs",
  "-",
]);

/** Where the person is: the page, and the repository, work item or pull request on it. */
export function askPage(pathname: string): AskPage {
  const path = pathname.split(/[?#]/)[0] ?? "";
  const parts = path
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  const page: AskPage = { path: path || "/" };
  const [owner, name, section, number] = parts;
  if (!owner || !name || RESERVED.has(owner.toLowerCase())) return page;
  // A work item's page: `/<workspace>/-/work/<n>`, numbered in the workspace.
  if (name === "-") {
    const item = section === "work" && number && /^\d+$/.test(number) ? Number(number) : null;
    if (item != null) Object.assign(page, { workspace: owner.toLowerCase(), item });
    return page;
  }
  page.repo = { namespace: owner.toLowerCase(), name };
  const numbered = number && /^\d+$/.test(number) ? Number(number) : null;
  if (numbered != null && section === "pull") page.pull = numbered;
  return page;
}

/** The window event a page sends to ask g1t a question, which the top bar's Ask sends to Chat (components/ask-button.tsx). */
export const ASK_EVENT = "g1t:ask";

/**
 * Asks g1t this in your direct message with it, and opens it in Chat:
 * Home's box, its Summarize and Explain buttons. Where it cannot be sent,
 * Chat's New opens with the question in its box.
 */
export function askG1t(text: string) {
  const question = text.trim();
  if (!question) return;
  window.dispatchEvent(new CustomEvent<{ text: string }>(ASK_EVENT, { detail: { text: question } }));
}

/** Opens your direct message with g1t in Chat as it is: a follow-up to an answer shown on a page. */
export function openAsk() {
  window.dispatchEvent(new CustomEvent<{ text: string }>(ASK_EVENT, { detail: { text: "" } }));
}

/** What the composer says about where the question is asked from. */
export function askWhere(page: AskPage): string | null {
  if (page.item) return `On work item #${page.item}`;
  if (page.pull) return `On pull request #${page.pull}`;
  if (page.repo) return `In ${page.repo.name}`;
  return null;
}

/**
 * A step an answer took: one of g1t's tools, run as the person asking. Its
 * `tool` line comes when it starts and again, with the same id, when it ends.
 */
export type Step = {
  id: string;
  name: string;
  action: string | null;
  label: string;
  status: AskToolStatus;
  summary: string | null;
  link: string | null;
};

/** A session g1t proposed in an answer: the person starts it, or copies its command. */
export type Proposal = Extract<AskEvent, { type: "proposal" }>;

/** What starting a proposal does, in a line, under its title. */
export function proposalSteps(proposal: Proposal): string {
  if (proposal.new_repository) {
    const made = `Creates ${proposal.private ? "the private" : "the public"} repository`;
    return proposal.deploy
      ? `${made}, turns on its deployments, then runs in your own harness and pushes the first version, which goes live on g1t.page.`
      : `${made}, then runs in your own harness and pushes the first version.`;
  }
  return proposal.item
    ? "Runs in your own harness, with your skills, tied to the work item."
    : "Opens the work item, then runs in your own harness, tied to it.";
}

/** What a proposal asks the session to do, in a line: "Implement #12 in acme/web". */
export function proposalTitle(proposal: Proposal): string {
  if (proposal.new_repository) return `Build “${proposal.title}” in ${proposal.repo}`;
  const verb = { plan: "Plan", implement: "Implement", review: "Review" }[proposal.mode] ?? "Work on";
  return proposal.item ? `${verb} #${proposal.item} in ${proposal.repo}` : `${verb} “${proposal.title}” in ${proposal.repo}`;
}

/**
 * An answer's steps and sources from the raw events kept with it (a chat
 * message keeps the `tool` and `sources` lines it was streamed with):
 * each step once, as it last was, in the order they started; the last
 * `sources`; each proposal once, and what its card did (`kept`, by its id).
 * Anything else, or anything malformed, is skipped.
 */
export function foldAnswer(events: unknown): { steps: Step[]; sources: AskSource[]; proposals: Proposal[]; kept: Record<string, AskProposalState> } {
  let steps: Step[] = [];
  let sources: AskSource[] = [];
  const proposals: Proposal[] = [];
  const kept: Record<string, AskProposalState> = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    // What a proposal's card did, kept on the answer by chat's g1t_proposal.
    const state = event as AskProposalState & { type?: string };
    if (state.type === "proposal_state" && typeof state.id === "string") {
      const { type: _, ...rest } = state;
      kept[state.id] = rest;
      continue;
    }
    const line = event as AskEvent;
    if (line.type === "tool" && typeof line.id === "string" && typeof line.label === "string") steps = withStep(steps, line);
    if (line.type === "sources" && Array.isArray(line.sources)) {
      sources = line.sources.filter((source) => source && typeof source.url === "string" && typeof source.title === "string");
    }
    if (line.type === "proposal" && typeof line.id === "string" && typeof line.repo === "string" && (line.item || line.title)) {
      if (!proposals.some((known) => known.id === line.id)) proposals.push(line);
    }
  }
  return { steps, sources, proposals, kept };
}

/** The steps with this one in its place: a new one at the end, a known one updated. */
export function withStep(steps: Step[] | undefined, event: Extract<AskEvent, { type: "tool" }>): Step[] {
  const step: Step = {
    id: event.id,
    name: event.name,
    action: event.action ?? null,
    label: event.label,
    status: event.status,
    summary: event.summary ?? null,
    link: event.link ?? null,
  };
  const list = steps ?? [];
  const at = list.findIndex((known) => known.id === step.id);
  if (at === -1) return [...list, step];
  return list.map((known, index) => (index === at ? step : known));
}
