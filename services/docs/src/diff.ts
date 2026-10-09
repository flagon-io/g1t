/**
 * What changed between two versions of a page: a line diff of their
 * Markdown (longest common subsequence), for history. Pure.
 */
import type { DocDiffLine } from "@g1t/contracts";

/** Past this many lines on both sides, the middle is compared as a whole block. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DocDiffLine[] {
  const a = before ? before.replace(/\n$/, "").split("\n") : [];
  const b = after ? after.replace(/\n$/, "").split("\n") : [];
  // Common head and tail first: most edits touch a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DocDiffLine[] = a.slice(0, head).map((text) => ({ op: "same" as const, text }));
  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) out.push({ op: "del", text });
    for (const text of midB) out.push({ op: "add", text });
  } else {
    const n = midA.length;
    const m = midB.length;
    // lcs[i][j]: the longest common subsequence of midA[i..] and midB[j..].
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: "same", text: midA[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", text: midA[i++]! });
      else out.push({ op: "add", text: midB[j++]! });
    }
    while (i < n) out.push({ op: "del", text: midA[i++]! });
    while (j < m) out.push({ op: "add", text: midB[j++]! });
  }
  for (const text of a.slice(a.length - tail)) out.push({ op: "same", text });
  return out;
}

/** How many lines were added and removed. */
export function diffStats(lines: DocDiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    if (l.op === "del") removed++;
  }
  return { added, removed };
}
