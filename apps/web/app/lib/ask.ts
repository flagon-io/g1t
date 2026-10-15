/**
 * Ask g1t (components/ask-composer): where the person is when they ask,
 * which goes with each question to their direct message with @g1t, so g1t
 * is told the page and reads the issue or pull request on it. Pure, so it
 * is tested on its own.
 */
import type { AskEvent, AskPage, AskSource, AskToolStatus } from "@g1t/contracts";

/** First path segments that are g1t's own pages, never a workspace. */
const RESERVED = new Set([
  "settings", "u", "auth", "oauth", "integrations", "new", "invite", "workspaces", "device", "verify",
  "confirm-email", "login", "register", "logout", "forgot", "reset", "search", "status", "avatars", "docs", "-",
]);

/** Where the person is: the page, and the repository, issue or pull request on it. */
export function askPage(pathname: string): AskPage {
  const path = pathname.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const page: AskPage = { path: path || "/" };
  const [owner, name, section, number] = parts;
  if (!owner || !name || RESERVED.has(owner.toLowerCase()) || name === "-") return page;
  page.repo = { namespace: owner.toLowerCase(), name };
  const numbered = number && /^\d+$/.test(number) ? Number(number) : null;
  if (numbered != null && section === "issues") page.issue = numbered;
  if (numbered != null && section === "pull") page.pull = numbered;
  return page;
}

/** The window event a page sends to have the top bar's Ask open and ask a question (components/ask-button.tsx). */
export const ASK_EVENT = "g1t:ask";

/**
 * Opens the top bar's Ask panel and asks g1t this, as if it were typed
 * there: Home's box, its Summarize and Explain buttons. Where Ask is not
 * set up, the panel opens with the question in its box.
 */
export function askG1t(text: string) {
  const question = text.trim();
  if (!question) return;
  window.dispatchEvent(new CustomEvent<{ text: string }>(ASK_EVENT, { detail: { text: question } }));
}

/** Opens the top bar's Ask panel on the conversation as it is: a follow-up to an answer shown on a page. */
export function openAsk() {
  window.dispatchEvent(new CustomEvent<{ text: string }>(ASK_EVENT, { detail: { text: "" } }));
}

/** What the composer says about where the question is asked from. */
export function askWhere(page: AskPage): string | null {
  if (page.issue) return `On issue #${page.issue}`;
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

/** What a proposal asks the session to do, in a line: "Implement #12 in acme/web". */
export function proposalTitle(proposal: Proposal): string {
  const verb = { plan: "Plan", implement: "Implement", review: "Review" }[proposal.mode] ?? "Work on";
  return proposal.issue ? `${verb} #${proposal.issue} in ${proposal.repo}` : `${verb} “${proposal.title}” in ${proposal.repo}`;
}

/**
 * An answer's steps and sources from the raw events kept with it (a chat
 * message keeps the `tool` and `sources` lines it was streamed with):
 * each step once, as it last was, in the order they started; the last
 * `sources`; each proposal once. Anything else, or anything malformed, is skipped.
 */
export function foldAnswer(events: unknown): { steps: Step[]; sources: AskSource[]; proposals: Proposal[] } {
  let steps: Step[] = [];
  let sources: AskSource[] = [];
  const proposals: Proposal[] = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const line = event as AskEvent;
    if (line.type === "tool" && typeof line.id === "string" && typeof line.label === "string") steps = withStep(steps, line);
    if (line.type === "sources" && Array.isArray(line.sources)) {
      sources = line.sources.filter((source) => source && typeof source.url === "string" && typeof source.title === "string");
    }
    if (line.type === "proposal" && typeof line.id === "string" && typeof line.repo === "string" && (line.issue || line.title)) {
      if (!proposals.some((known) => known.id === line.id)) proposals.push(line);
    }
  }
  return { steps, sources, proposals };
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
