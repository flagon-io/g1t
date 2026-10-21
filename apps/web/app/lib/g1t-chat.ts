/**
 * @g1t's side of chat, as the site shows it: the direct message every
 * member has with g1t, where the top bar's Ask and Home's questions
 * go (lib/ask-in-chat.ts). Pure, so it is tested on its own (g1t-chat.test.ts).
 */
import type { AskPage, ChatAnswer, ChatLiveEvent, ChatMessage } from "@g1t/contracts";

/** Whether a message is from @g1t itself. */
export function fromG1t(message: Pick<ChatMessage, "author">): boolean {
  return message.author.kind === "system" && message.author.id === "g1t";
}

/** Whether an answer is still being written. */
export function answering(answer: ChatAnswer | null | undefined): boolean {
  return answer?.state === "thinking" || answer?.state === "streaming";
}

/** Whether any answer in the conversation is still being written: Stop shows, Send waits. */
export function anyAnswering(messages: readonly ChatMessage[]): boolean {
  return messages.some((message) => !message.deleted_at && answering(message.answer));
}

/** Who wrote an answer: "Anthropic · claude-…", or "Anthropic · Auto · claude-…" when Auto chose it, once the provider said. */
export function answerLabel(answer: ChatAnswer | null | undefined): string | null {
  if (!answer?.provider_label) return null;
  if (!answer.model) return answer.provider_label;
  return answer.auto ? `${answer.provider_label} · Auto · ${answer.model}` : `${answer.provider_label} · ${answer.model}`;
}

/** Whether an answer was cut off at its length limit. */
export function cutOff(answer: ChatAnswer | null | undefined): boolean {
  return answer?.stop_reason === "max_tokens" || answer?.stop_reason === "length";
}

/**
 * A conversation's top-level messages after one live event: new and
 * changed ones by id, oldest first; an answer as it streams; deleted ones
 * gone. Thread replies and other conversations' events change nothing.
 */
export function applyLive(list: readonly ChatMessage[], event: ChatLiveEvent, channelId: string): ChatMessage[] {
  switch (event.type) {
    case "message.created":
    case "message.updated": {
      const message = event.message;
      if (message.channel_id !== channelId || message.thread_root) return list as ChatMessage[];
      if (message.deleted_at) return list.filter((m) => m.id !== message.id);
      const at = list.findIndex((m) => m.id === message.id);
      if (at >= 0) return list.map((m) => (m.id === message.id ? { ...m, ...message } : m));
      return [...list, message].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    case "message.streaming": {
      if (event.channel_id !== channelId) return list as ChatMessage[];
      return list.map((m) =>
        // Never back over what a stored message already has: a late frame after the end changes nothing.
        m.id === event.id && answering(m.answer) ? { ...m, body: event.body, answer: event.answer } : m,
      );
    }
    case "message.deleted":
      if (event.channel_id !== channelId) return list as ChatMessage[];
      return list.filter((m) => m.id !== event.id);
    case "channel.cleared":
      // The person cleared the conversation: nothing in it is left.
      return event.channel_id === channelId ? [] : (list as ChatMessage[]);
    default:
      return list as ChatMessage[];
  }
}

/**
 * Whether what was typed to @g1t is `/clear`: it opens Clear conversation
 * (components/chat/clear-g1t.tsx) rather than being sent to g1t.
 */
export function isClearCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/clear";
}

/**
 * What a reader may ask first, from where they are: about the work item or
 * pull request in front of them, the repository, or their work.
 */
/** The work item a page's path is, by number: `/acme/-/work/12`. */
function itemAt(path: string | null | undefined): number | null {
  const found = path?.match(/^\/[a-z0-9][a-z0-9-]*\/-\/work\/(\d+)\/?$/i);
  return found ? Number(found[1]) : null;
}

export function suggestions(page: AskPage): string[] {
  if (page.pull)
    return [
      `Summarize pull request #${page.pull}`,
      `What's left before #${page.pull} can merge?`,
      "What changed in this pull request, file by file?",
      "What should I check when reviewing this?",
    ];
  const item = page.item ?? itemAt(page.path);
  if (item)
    return [`Summarize work item #${item}`, `What's blocking #${item}?`, "How would you approach this work item?", "Which code does this work item touch?"];
  if (page.repo)
    return [`What is ${page.repo.name} for?`, "What shipped here this week?", "What's open and needs attention?", "Where do I start reading the code?"];
  return ["What shipped today?", "What needs my attention?", "Summarize what my team is working on", "How do I set up a deployment?"];
}

/**
 * Where a question to @g1t was asked from, when it was asked on a page
 * (the top bar's Ask on a pull request, a work item or a repository): what
 * to call it and where it leads. Null for a question written in Chat.
 */
export function askedFrom(page: AskPage | null | undefined): { label: string; href: string } | null {
  if (!page) return null;
  const repo = page.repo ? `${page.repo.namespace}/${page.repo.name}` : null;
  if (repo && page.pull) return { label: `pull request #${page.pull} in ${repo}`, href: page.path ?? `/${repo}/pull/${page.pull}` };
  const workspace = page.workspace ?? page.path?.match(/^\/([a-z0-9][a-z0-9-]*)\/-\/work\/\d+\/?$/i)?.[1]?.toLowerCase() ?? null;
  const item = page.item ?? itemAt(page.path);
  if (workspace && item) return { label: `work item #${item} in ${workspace}`, href: page.path ?? `/${workspace}/-/work/${item}` };
  if (repo) return { label: repo, href: page.path ?? `/${repo}` };
  if (page.path && !/\/-\/chat(\/|$)/.test(page.path)) return { label: page.path, href: page.path };
  return null;
}

/** A link g1t knows how to show as a chip: a work item, a pull request, a reference read in a repository, a commit, or another page of the site. */
export type RefTarget =
  | { kind: "item"; workspace: string; number: number; href: string }
  | { kind: "pull"; repo: string; number: number; href: string }
  | { kind: "ref"; repo: string; number: number; href: string }
  | { kind: "commit"; repo: string; sha: string; href: string }
  | { kind: "page"; href: string };

/** The site's own hosts: a full link to one of them is shown as the page it leads to. */
const SITE_HOSTS = new Set(["g1t.sh", "www.g1t.sh"]);

/**
 * Where a link leads on the site, if it does: `/acme/-/work/12`,
 * `/acme/web/pull/12`, `/acme/web/ref/12` (and an old issue's
 * `/acme/web/issues/12`, read the same way), `/acme/web/commit/<sha>`, or
 * the same as a full `https://g1t.sh/…` link (or one to `origin`, the site
 * the reader is on).
 */
export function refTarget(href: string, origin: string | null = null): RefTarget | null {
  let path: string;
  if (href.startsWith("/") && !href.startsWith("//")) path = href;
  else {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!SITE_HOSTS.has(url.host) && url.origin !== origin) return null;
    path = `${url.pathname}${url.search}${url.hash}`;
  }
  const bare = path.split(/[?#]/)[0]!;
  const item = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/-\/work\/(\d+)\/?$/i);
  if (item) return { kind: "item", workspace: item[1]!.toLowerCase(), number: Number(item[2]), href: path };
  const pull = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/pull\/(\d+)\/?$/i);
  if (pull) return { kind: "pull", repo: `${pull[1]!.toLowerCase()}/${pull[2]}`, number: Number(pull[3]), href: path };
  const ref = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/(?:ref|issues)\/(\d+)\/?$/i);
  if (ref) return { kind: "ref", repo: `${ref[1]!.toLowerCase()}/${ref[2]}`, number: Number(ref[3]), href: path };
  const commit = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/commit\/([0-9a-f]{7,40})\/?$/i);
  if (commit) return { kind: "commit", repo: `${commit[1]!.toLowerCase()}/${commit[2]}`, sha: commit[3]!.toLowerCase(), href: path };
  return { kind: "page", href: path };
}
