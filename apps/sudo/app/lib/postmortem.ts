/**
 * The postmortem editor's sections, and its preview's reading of plain
 * text, the same way the status page reads it (apps/status render.ts
 * `prose`). No Workers or React imports, so it is tested under Node.
 */
import type { PostmortemFields } from "@g1t/contracts/status";

export const POSTMORTEM_SECTIONS: { key: keyof PostmortemFields; title: string; hint: string; rows: number }[] = [
  { key: "summary", title: "Summary", hint: "Two or three sentences: what happened, to whom, for how long. Required to publish.", rows: 4 },
  { key: "impact", title: "Impact", hint: "Who noticed, and what they could not do.", rows: 3 },
  { key: "timeline", title: "Timeline", hint: "Filled in from the incident's timeline. Times are UTC.", rows: 8 },
  { key: "root_cause", title: "Root cause", hint: "Why it happened, not who. Required to publish.", rows: 4 },
  { key: "went_well", title: "What went well", hint: "", rows: 3 },
  { key: "went_badly", title: "What went badly", hint: "", rows: 3 },
  { key: "action_items", title: "Action items", hint: "Filled in from the follow-ups. One per line, starting “- ”.", rows: 4 },
];

export type Block = { kind: "paragraph"; text: string } | { kind: "list"; items: string[] };

/** Blank lines between paragraphs; a block whose lines all start with "- " is a list. */
export function proseBlocks(text: string): Block[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .map((block): Block => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.every((l) => /^\s*[-*] /.test(l))) return { kind: "list", items: lines.map((l) => l.replace(/^\s*[-*] /, "")) };
      return { kind: "paragraph", text: block };
    });
}
