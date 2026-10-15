/**
 * How a session's entries read on its page: tool calls run together
 * between its messages, each with what it was called on.
 */
import type { SessionEntry } from "@g1t/contracts";

/** A tool call as it reads: which tool, on what, and of what sort. */
export type ToolCall = {
  /** The tool's own name, as `issue` of g1t's `issue` over MCP. */
  name: string;
  /** The MCP server it came from, if any: `g1t`. */
  server: string | null;
  /** What it was called with, without the tool's name in front. */
  detail: string;
  /** A command line, a file, or anything else. */
  sort: "shell" | "file" | "other";
};

const SHELLS = new Set(["bash", "sh", "zsh", "shell", "powershell", "pwsh", "cmd"]);
const FILES = new Set(["read", "write", "edit", "multiedit", "notebookedit", "notebook_edit"]);

/** A server's name from Claude Code's `mcp__<server>__<tool>`: `plugin_g1t_g1t` is g1t, `claude_ai_Google_Drive` Google Drive. */
function serverName(raw: string): string {
  const plugin = /^plugin_[^_]+_(.+)$/.exec(raw);
  const name = plugin ? plugin[1] : raw.replace(/^claude_ai_/, "");
  return name.replaceAll("_", " ");
}

/**
 * A tool call's entry, read: its tool (the entry's own, else the name its
 * text starts with), what it was called with, with that name taken off the
 * front where the text repeats it, and its MCP server (`g1t:issue` from a
 * session g1t ran, `mcp__plugin_g1t_g1t__issue` from Claude Code).
 */
export function readToolCall(entry: Pick<SessionEntry, "text" | "tool">): ToolCall {
  const text = entry.text.trim();
  let tool = entry.tool?.trim() || null;
  let detail = text;
  if (tool) {
    const prefix = `${tool}:`;
    if (text.toLowerCase() === tool.toLowerCase()) detail = "";
    else if (text.toLowerCase().startsWith(prefix.toLowerCase())) detail = text.slice(prefix.length).trim();
  } else {
    // A name, then ": " and what it was called with (the plugin's summary).
    const match = /^([A-Za-z][\w.:-]*?):\s+([\s\S]*)$/.exec(text) ?? (/^[A-Za-z][\w.:-]*$/.test(text) ? [text, text, ""] : null);
    if (match) {
      tool = match[1];
      detail = match[2].trim();
    }
  }
  let name = tool ?? "tool";
  let server: string | null = null;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    server = serverName(mcp[1]);
    name = mcp[2];
  } else if (name.includes(":")) {
    const at = name.indexOf(":");
    server = name.slice(0, at);
    name = name.slice(at + 1);
  }
  const key = name.toLowerCase();
  // An MCP tool's name reads as words: g1t's `pull_request` is "pull request".
  if (server) name = name.replaceAll("_", " ");
  const sort = server ? "other" : SHELLS.has(key) ? "shell" : FILES.has(key) && detail ? "file" : "other";
  return { name, server, detail, sort };
}

/** One tool call and what came back from it. */
export type ToolStep = { call: SessionEntry | null; results: SessionEntry[] };

/** A part of the transcript: one entry, or tool calls that ran one after another. */
export type TranscriptItem = { kind: "entry"; entry: SessionEntry } | { kind: "tools"; steps: ToolStep[]; first: SessionEntry };

/**
 * Entries as the transcript shows them: prompts, messages, skills and notes
 * one by one, and each run of tool calls between them as one group, every
 * result under the call before it.
 */
export function transcript(entries: SessionEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let group: Extract<TranscriptItem, { kind: "tools" }> | null = null;
  for (const entry of entries) {
    if (entry.kind !== "tool_call" && entry.kind !== "tool_result") {
      group = null;
      items.push({ kind: "entry", entry });
      continue;
    }
    if (!group) {
      group = { kind: "tools", steps: [], first: entry };
      items.push(group);
    }
    const last = group.steps.at(-1);
    if (entry.kind === "tool_call") group.steps.push({ call: entry, results: [] });
    else if (last) last.results.push(entry);
    else group.steps.push({ call: null, results: [entry] });
  }
  return items;
}

/**
 * A prompt with g1t's `<issue>` and `<comment>` blocks (what it quotes of
 * an issue or a comment) as quotes under a label, so they read as markdown
 * rather than as tags that vanish.
 */
export function quotedBlocks(text: string): string {
  return text.replace(/^<(issue|comment)\b[^>\n]*>\n([\s\S]*?)\n<\/\1>[ \t]*$/gm, (_, tag: string, body: string) => {
    const label = tag === "issue" ? "**The issue**" : "**The comment**";
    // A blank line after it, so the text that follows is not part of the quote.
    return [label, "", ...body.split("\n").map((line) => (line ? `> ${line}` : ">")), ""].join("\n");
  });
}
