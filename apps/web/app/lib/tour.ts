/**
 * The landing page's product tour: one story told as a timeline. Every
 * frame is a pure function of the time into the loop, so the tour can be
 * paused, resumed, jumped to a step, or shown still, and the server and
 * the first client render agree (t = 0).
 *
 * The story: a person asks g1t in #web to fix the CSV export; g1t hands it
 * to @otto and the review to @margo (agents the workspace hired from role
 * templates; only g1t is built in); Otto works it in a session, bringing
 * Margo in on the way; the pull request goes green and merges; g1t says
 * it shipped and Izzy tells #support; Inky updates the docs page.
 */

export type Scene = "chat" | "agents" | "code" | "docs";

/** Where the soft cursor points: an element marked `data-tour="<target>"`. */
export type CursorTarget =
  | "composer"
  | "send"
  | "rail-agents"
  | "rail-code"
  | "rail-chat"
  | "rail-docs"
  | "task-pull"
  | "idle";

export type Frame = {
  scene: Scene;
  /** Characters of the person's message typed into the composer. */
  typed: number;
  /** The person's message has been sent. */
  sent: boolean;
  /** g1t shows as typing. */
  g1tTyping: boolean;
  /** g1t's handoff reply, with the task card. */
  handoff: boolean;
  /** Builder's steps done, 0 to STEPS.length. */
  steps: number;
  /** Checks passed on the pull request, 0 to CHECKS.length. */
  checks: number;
  /** The diff is shown on the pull request. */
  diff: boolean;
  /** @reviewer approved. */
  approved: boolean;
  /** The merge queue merged it. */
  merged: boolean;
  /** The task card in #web says merged and deploying. */
  cardMerged: boolean;
  /** g1t posted that it shipped. */
  shipped: boolean;
  /** Izzy says she told #support. */
  izzy: boolean;
  /** Otto consulted Margo, shown as a collapsed line on the task. */
  consult: boolean;
  /** The docs page shows the changed line. */
  docUpdated: boolean;
  cursor: CursorTarget;
  /** The cursor is pressing. */
  click: boolean;
  /** The cursor is shown at all. */
  cursorShown: boolean;
};

/** What the person types into #web. */
export const ASK = "@g1t the CSV export times out for big accounts. Can we get it fixed before Thursday?";

export const STEPS: { text: string; cost: number }[] = [
  { text: "Read the export job and the two reports in #web", cost: 0.04 },
  { text: "Found it: every row loads before the first byte is sent", cost: 0.11 },
  { text: "Streamed rows in batches of 1,000", cost: 0.19 },
  { text: "Tested a 200,000-row account: 3.1 s, was 61 s", cost: 0.27 },
  { text: "Opened pull request #431", cost: 0.31 },
];

export const CHECKS = ["build", "test", "lint", "preview"];

/** When the person starts typing, and how long each character takes, in ms. */
const TYPE_START = 1500;

/**
 * A human typing pace: about 45 ms a character, a little longer after a
 * space, and a short hesitation after punctuation. Seeded, so every loop
 * and every render types the same way.
 */
function typingTimes(text: string): number[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const times: number[] = [];
  let at = TYPE_START;
  for (const char of text) {
    at += 32 + random() * 34;
    if (char === " ") at += random() * 30;
    times.push(Math.round(at));
    if (char === "." || char === "?" || char === ",") at += 220 + random() * 160;
  }
  return times;
}

const TYPED_AT = typingTimes(ASK);
const TYPED_END = TYPED_AT[TYPED_AT.length - 1];

/** The beats of the story, in ms from the start of the loop. */
export const BEAT = {
  composerClick: 1100,
  typed: TYPED_END,
  sendClick: TYPED_END + 700,
  sent: TYPED_END + 800,
  g1tTyping: TYPED_END + 1300,
  handoff: TYPED_END + 2500,
  railAgentsClick: TYPED_END + 4300,
  agents: TYPED_END + 4450,
  step0: TYPED_END + 5400,
  stepGap: 1150,
  pullClick: TYPED_END + 11900,
  code: TYPED_END + 12050,
  check0: TYPED_END + 12900,
  checkGap: 650,
  diff: TYPED_END + 13300,
  approved: TYPED_END + 15900,
  merged: TYPED_END + 17000,
  railChatClick: TYPED_END + 18300,
  chatAgain: TYPED_END + 18450,
  cardMerged: TYPED_END + 19100,
  shipped: TYPED_END + 20400,
  izzy: TYPED_END + 21600,
  railDocsClick: TYPED_END + 23000,
  docs: TYPED_END + 23150,
  docUpdated: TYPED_END + 24300,
  end: TYPED_END + 29000,
} as const;

/** The whole loop, in ms. */
export const LOOP_MS = BEAT.end;

/** The step pills under the frame: where each starts, for jumping to it. */
export const PILLS: { scene: Scene; label: string; start: number; soon: boolean }[] = [
  { scene: "chat", label: "Chat", start: 0, soon: false },
  // Sessions, colleagues brought in, spend against a cap: built.
  { scene: "agents", label: "Agents", start: BEAT.agents, soon: false },
  { scene: "code", label: "Code", start: BEAT.code, soon: false },
  // Docs is built; an agent keeping a page current after a merge on its
  // own is not yet, and the line under the frame says so.
  { scene: "docs", label: "Docs", start: BEAT.docs, soon: false },
];

/** Which pill a time falls under. Back in chat after the merge is still Code's story. */
export function pillAt(t: number): number {
  let index = 0;
  PILLS.forEach((pill, i) => {
    if (t >= pill.start) index = i;
  });
  return index;
}

/** How far through its pill a time is, 0 to 1. */
export function pillProgress(t: number): number {
  const index = pillAt(t);
  const start = PILLS[index].start;
  const end = PILLS[index + 1]?.start ?? LOOP_MS;
  return Math.min(1, Math.max(0, (t - start) / (end - start)));
}

function count(t: number, first: number, gap: number, max: number): number {
  if (t < first) return 0;
  return Math.min(max, Math.floor((t - first) / gap) + 1);
}

/** Where the cursor is headed, and whether it is pressing, at time t. */
function cursorAt(t: number): { cursor: CursorTarget; click: boolean } {
  const press = (at: number) => t >= at && t < at + 180;
  const moves: [number, CursorTarget][] = [
    [300, "composer"],
    [TYPED_END + 150, "send"],
    [BEAT.handoff + 700, "rail-agents"],
    [BEAT.step0 + 4 * BEAT.stepGap + 500, "task-pull"],
    [BEAT.merged + 300, "rail-chat"],
    [BEAT.izzy + 500, "rail-docs"],
    [BEAT.docs + 500, "idle"],
  ];
  let cursor: CursorTarget = "idle";
  for (const [at, target] of moves) if (t >= at) cursor = target;
  const click =
    press(BEAT.composerClick) ||
    press(BEAT.sendClick) ||
    press(BEAT.railAgentsClick) ||
    press(BEAT.pullClick) ||
    press(BEAT.railChatClick) ||
    press(BEAT.railDocsClick);
  return { cursor, click };
}

/** The frame at time t (ms into the loop). */
export function frameAt(time: number): Frame {
  const t = ((time % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const scene: Scene =
    t >= BEAT.docs ? "docs" : t >= BEAT.chatAgain ? "chat" : t >= BEAT.code ? "code" : t >= BEAT.agents ? "agents" : "chat";
  let typed = 0;
  while (typed < TYPED_AT.length && TYPED_AT[typed] <= t) typed++;
  const sent = t >= BEAT.sent;
  const { cursor, click } = cursorAt(t);
  return {
    scene,
    typed: sent ? 0 : typed,
    sent,
    g1tTyping: t >= BEAT.g1tTyping && t < BEAT.handoff,
    handoff: t >= BEAT.handoff,
    steps: count(t, BEAT.step0, BEAT.stepGap, STEPS.length),
    checks: count(t, BEAT.check0, BEAT.checkGap, CHECKS.length),
    diff: t >= BEAT.diff,
    approved: t >= BEAT.approved,
    merged: t >= BEAT.merged,
    cardMerged: t >= BEAT.cardMerged,
    shipped: t >= BEAT.shipped,
    izzy: t >= BEAT.izzy,
    consult: t >= BEAT.step0 + 2 * BEAT.stepGap + 500,
    docUpdated: t >= BEAT.docUpdated,
    cursor,
    click,
    cursorShown: t >= 200 && t < BEAT.end - 600,
  };
}

/** A still frame for each pill, for reduced motion: the moment the step makes its point. */
export const STILLS: Record<Scene, number> = {
  chat: BEAT.handoff + 400,
  agents: BEAT.step0 + 4 * BEAT.stepGap + 200,
  code: BEAT.approved + 200,
  docs: BEAT.docUpdated + 400,
};

/** Whether two frames would draw the same. */
export function sameFrame(a: Frame, b: Frame): boolean {
  for (const key of Object.keys(a) as (keyof Frame)[]) if (a[key] !== b[key]) return false;
  return true;
}
