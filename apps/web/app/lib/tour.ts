/**
 * The landing page's product tour: one story told as a timeline. Every
 * frame is a pure function of the time into the loop, so the tour can be
 * paused, resumed, jumped to a step, or shown still, and the server and
 * the first client render agree (t = 0).
 *
 * The story opens on the code: Otto's pull request #431 runs its checks,
 * is approved and is merged by the queue. Then where it came from: the
 * ask in #web, handed to @otto by g1t, now merged, and Izzy telling
 * #support. Then Otto's desk, the record of what he did and spent, and
 * last Inky's docs page picking up the change.
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

/** The beats of the story, in ms from the start of the loop. */
export const BEAT = {
  code: 0,
  check0: 900,
  checkGap: 650,
  diff: 1300,
  approved: 3900,
  merged: 5000,
  railChatClick: 6300,
  chat: 6450,
  cardMerged: 7100,
  shipped: 8400,
  izzy: 9600,
  railAgentsClick: 11000,
  agents: 11150,
  railDocsClick: 15000,
  docs: 15150,
  docUpdated: 16300,
  end: 21000,
} as const;

/** The whole loop, in ms. */
export const LOOP_MS = BEAT.end;

/** The step pills under the frame: where each starts, for jumping to it. */
export const PILLS: { scene: Scene; label: string; start: number; soon: boolean }[] = [
  { scene: "code", label: "Code", start: 0, soon: false },
  { scene: "chat", label: "Chat", start: BEAT.chat, soon: false },
  { scene: "agents", label: "Agents", start: BEAT.agents, soon: true },
  { scene: "docs", label: "Docs", start: BEAT.docs, soon: true },
];

/** Which pill a time falls under. */
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
    [BEAT.merged + 300, "rail-chat"],
    [BEAT.izzy + 500, "rail-agents"],
    [BEAT.agents + 2600, "rail-docs"],
    [BEAT.docs + 500, "idle"],
  ];
  let cursor: CursorTarget = "idle";
  for (const [at, target] of moves) if (t >= at) cursor = target;
  const click = press(BEAT.railChatClick) || press(BEAT.railAgentsClick) || press(BEAT.railDocsClick);
  return { cursor, click };
}

/**
 * The frame at time t (ms into the loop). The ask, g1t's handoff and
 * Otto's work all happened before the pull request the story opens on, so
 * they are shown done throughout.
 */
export function frameAt(time: number): Frame {
  const t = ((time % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const scene: Scene = t >= BEAT.docs ? "docs" : t >= BEAT.agents ? "agents" : t >= BEAT.chat ? "chat" : "code";
  const { cursor, click } = cursorAt(t);
  return {
    scene,
    typed: 0,
    sent: true,
    g1tTyping: false,
    handoff: true,
    steps: STEPS.length,
    checks: count(t, BEAT.check0, BEAT.checkGap, CHECKS.length),
    diff: t >= BEAT.diff,
    approved: t >= BEAT.approved,
    merged: t >= BEAT.merged,
    cardMerged: t >= BEAT.cardMerged,
    shipped: t >= BEAT.shipped,
    izzy: t >= BEAT.izzy,
    consult: true,
    docUpdated: t >= BEAT.docUpdated,
    cursor,
    click,
    cursorShown: t >= BEAT.merged && t < BEAT.end - 600,
  };
}

/** A still frame for each pill, for reduced motion: the moment the step makes its point. */
export const STILLS: Record<Scene, number> = {
  code: BEAT.approved + 200,
  chat: BEAT.izzy + 400,
  agents: BEAT.agents + 400,
  docs: BEAT.docUpdated + 400,
};

/** Whether two frames would draw the same. */
export function sameFrame(a: Frame, b: Frame): boolean {
  for (const key of Object.keys(a) as (keyof Frame)[]) if (a[key] !== b[key]) return false;
  return true;
}
