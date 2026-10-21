/**
 * Task lists: the `- [ ]` and `- [x]` boxes in a work item's or pull
 * request's body, numbered from 1 the way the work service numbers them
 * (crates/contracts/src/work/tasks.rs, which this mirrors;
 * tasks.fixtures.json keeps the two the same). The site draws each box
 * markdown renders and finds it here by its line, so a click ticks the box
 * the work service will tick.
 *
 * A box is a list item (`-`, `*`, `+`, `1.` or `1)`, in a block quote or
 * not, at any depth) that starts with `[ ]`, `[x]` or `[X]`, a space and
 * some text. Boxes in fenced code blocks are examples, not boxes.
 */

/** A box of a task list. */
export type Task = {
  /** Its place in the body, from 1. */
  number: number;
  /** The line it is on, from 1. */
  line: number;
  /** What it says after the box. */
  text: string;
  checked: boolean;
};

/** What ticking a box did (`check_work_item_task`, `check_pull_task`). */
export type CheckedTask = {
  task: Task;
  /** False when it already was as asked. */
  changed: boolean;
  /** The body with it. */
  body: string;
  /** How many boxes are ticked, of how many. */
  done: number;
  total: number;
};

/**
 * Which box to tick or untick: `task` (its number) or `text` (words of
 * it), with `expected`, its text as last read, so that a box that moved is
 * found or refused rather than the wrong one ticked.
 */
export type TaskCheck = {
  task?: number;
  text?: string;
  checked: boolean;
  expected?: string;
};

/** The boxes of `body`, in order. */
export function taskList(body: string): Task[] {
  const tasks: Task[] = [];
  // The fence a code block was opened with: its character and length.
  let fence: { mark: string; length: number } | null = null;
  body.split("\n").forEach((raw, index) => {
    const rest = unquoted(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    const opened = /^(`{3,}|~{3,})/.exec(rest)?.[1];
    if (opened) {
      if (!fence) fence = { mark: opened[0]!, length: opened.length };
      else if (fence.mark === opened[0] && opened.length >= fence.length && !rest.slice(opened.length).trim()) fence = null;
      return;
    }
    if (fence) return;
    const box = /^(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t](.*)$/.exec(rest);
    const text = box?.[2]?.trim();
    if (box && text) tasks.push({ number: tasks.length + 1, line: index + 1, text, checked: box[1] !== " " });
  });
  return tasks;
}

/** A line without its block quote markers and leading space. */
function unquoted(line: string): string {
  let rest = line;
  for (;;) {
    const trimmed = rest.replace(/^[ \t]+/, "");
    if (!trimmed.startsWith(">")) return trimmed;
    rest = trimmed.slice(1);
  }
}

/** `body` with the box on `line` ticked or not, as the work service would leave it; unchanged when there is none. */
export function setTask(body: string, line: number, checked: boolean): string {
  if (!taskList(body).some((task) => task.line === line)) return body;
  const lines = body.split("\n");
  lines[line - 1] = lines[line - 1]!.replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]");
  return lines.join("\n");
}
