/**
 * @g1t's side of chat, as the site shows it: the direct message every
 * member has with g1t, which the top bar's Ask (components/ask-composer)
 * and Chat both show. Pure, so it is tested on its own (g1t-chat.test.ts).
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

/** Who wrote an answer: "Anthropic · claude-…", once the provider said. */
export function answerLabel(answer: ChatAnswer | null | undefined): string | null {
  if (!answer?.provider_label) return null;
  return answer.model ? `${answer.provider_label} · ${answer.model}` : answer.provider_label;
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
    default:
      return list as ChatMessage[];
  }
}

/**
 * What a reader may ask first, from where they are: about the issue or
 * pull request in front of them, the repository, or their work.
 */
export function suggestions(page: AskPage): string[] {
  if (page.pull) return [`Summarize pull request #${page.pull}`, `What's left before #${page.pull} can merge?`, "What changed in this pull request, file by file?", "What should I check when reviewing this?"];
  if (page.issue) return [`Summarize issue #${page.issue}`, `What's blocking #${page.issue}?`, "How would you approach this issue?", "Which code does this issue touch?"];
  if (page.repo) return [`What is ${page.repo.name} for?`, "What shipped here this week?", "What's open and needs attention?", "Where do I start reading the code?"];
  return ["What shipped today?", "What needs my attention?", "Summarize what my team is working on", "How do I set up a deployment?"];
}

/** A link g1t knows how to show as a chip: an issue or pull request, a commit, or another page of the site. */
export type RefTarget =
  | { kind: "issue"; repo: string; number: number; href: string }
  | { kind: "commit"; repo: string; sha: string; href: string }
  | { kind: "page"; href: string };

/** The site's own hosts: a full link to one of them is shown as the page it leads to. */
const SITE_HOSTS = new Set(["g1t.sh", "www.g1t.sh"]);

/**
 * Where a link leads on the site, if it does: `/acme/web/issues/12`,
 * `/acme/web/pull/12`, `/acme/web/commit/<sha>`, or the same as a full
 * `https://g1t.sh/…` link (or one to `origin`, the site the reader is on).
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
  const issue = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/(?:issues|pull)\/(\d+)\/?$/i);
  if (issue) return { kind: "issue", repo: `${issue[1]!.toLowerCase()}/${issue[2]}`, number: Number(issue[3]), href: path };
  const commit = bare.match(/^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)\/commit\/([0-9a-f]{7,40})\/?$/i);
  if (commit) return { kind: "commit", repo: `${commit[1]!.toLowerCase()}/${commit[2]}`, sha: commit[3]!.toLowerCase(), href: path };
  return { kind: "page", href: path };
}
