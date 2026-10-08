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
