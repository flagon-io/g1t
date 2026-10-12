/**
 * Errors grouped: the same exception thrown a thousand times is one group
 * with a count, not a thousand lines. What makes two the same is their
 * name, their message with the parts that change taken out (numbers, ids,
 * quoted values), and where they were thrown (the top frame of the stack,
 * its file and function, not its line, which moves with every change).
 */

/** The message with what varies between occurrences taken out. */
export function messageShape(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "$1…$1")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/**
 * The top frame that is the app's own: its function and file, without
 * line, column or a build's hash. Frames of the runtime and of
 * node_modules are skipped while there is another.
 */
export function topFrame(stack: string | null | undefined): string {
  if (!stack) return "";
  const frames = stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") || /@.+:\d+/.test(line));
  const own = frames.find((f) => !/node_modules|node:|internal\/|<anonymous>|native/.test(f)) ?? frames[0] ?? "";
  return own
    .replace(/:\d+(:\d+)?\)?$/, "")
    .replace(/[.-][0-9a-f]{6,}(?=\.\w+$)/i, "")
    .replace(/\(|\)/g, "")
    .replace(/^at /, "")
    .slice(0, 300);
}

export async function fingerprint(name: string, message: string, stack: string | null | undefined, service: string): Promise<string> {
  const key = [service, name, messageShape(message), topFrame(stack)].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
