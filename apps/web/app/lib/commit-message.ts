/**
 * A commit message's parts: its subject, the prose of its body, and the
 * trailers git and tools add at the end (`Co-Authored-By: …`), which read
 * better as metadata than as prose.
 */
export type CommitMessage = {
  subject: string;
  body: string;
  /** The names in `Co-Authored-By` trailers, without their addresses. */
  coAuthors: string[];
  /** Every other trailer, as written but for any email address in it. */
  trailers: { key: string; value: string }[];
};

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/;

export function parseCommitMessage(message: string): CommitMessage {
  const [subject = "", ...rest] = message.split("\n");
  const lines = rest.join("\n").trim().split("\n");
  // Trailers are the last paragraph, when every line of it is one.
  const lastBreak = lines.lastIndexOf("");
  const last = lines.slice(lastBreak + 1);
  const isTrailers = last.length > 0 && last.every((line) => TRAILER.test(line.trim()));
  const prose = isTrailers ? lines.slice(0, Math.max(lastBreak, 0)) : lines;
  const coAuthors: string[] = [];
  const trailers: { key: string; value: string }[] = [];
  if (isTrailers) {
    for (const line of last) {
      const [, key, value] = TRAILER.exec(line.trim())!;
      if (key.toLowerCase() === "co-authored-by") coAuthors.push(value.replace(/\s*<[^>]*>\s*$/, "").trim());
      else {
        // `Signed-off-by: Ada <ada@example.com>` shows Ada: g1t never shows an address.
        const shown = value.replace(/\s*<[^<>]*@[^<>]*>/g, "").trim();
        if (shown) trailers.push({ key, value: shown });
      }
    }
  }
  return { subject, body: prose.join("\n").trim(), coAuthors, trailers };
}

/**
 * A run of a commit message, or of a note on an issue's timeline: plain
 * text, a reference to an issue or pull request (`#12` in the repository
 * it is in, `acme/web#12` in another), a commit by its full hash, or a
 * session by its id (`ses_…`, as in "closed this in … via session ses_…").
 */
export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "ref"; text: string; repo: string | null; number: number }
  | { kind: "commit"; text: string; sha: string }
  | { kind: "session"; text: string; id: string };

// `#12` and `acme/web#12`, but not `a#12` or a link's `/page#12`; a full hash on its own; a session's id.
const REFERENCE =
  /(?<![\w/#.-])(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+))?#(\d+)\b|\b([0-9a-f]{40})\b|\b(ses_[0-9a-z]{10,60})\b/g;

/** Splits text into its references and the text between them; `Closes #12` keeps `Closes ` as text. */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const start = match.index;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    if (match[3]) parts.push({ kind: "commit", text: match[0], sha: match[3] });
    else if (match[4]) parts.push({ kind: "session", text: match[0], id: match[4] });
    else parts.push({ kind: "ref", text: match[0], repo: match[1] ?? null, number: Number(match[2]) });
    at = start + match[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}
