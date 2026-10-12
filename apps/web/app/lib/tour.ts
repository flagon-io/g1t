/**
 * The landing page's product tour: one story told as a timeline. Every
 * frame is a pure function of the time into the loop, so the tour can be
 * paused, resumed, jumped to a step, or shown still, and the server and
 * the first client render agree (t = 0).
 *
 * The story is about the code. Priya's pull request #431 runs its checks,
 * is approved by Dana and is merged by the queue, and production deploys.
 * Then how it was made: the session Priya's coding agent recorded onto the
 * pull request through g1t's MCP server. Then the people: #web, where Dana
 * reported the bug and hears it shipped. Last, the docs page Dana updates.
 */

export type Scene = "code" | "session" | "chat" | "docs";

/** Where the soft cursor points: an element marked `data-tour="<target>"`. */
export type CursorTarget = "pr-session" | "rail-code" | "rail-chat" | "rail-docs" | "idle";

export type Frame = {
  scene: Scene;
  /** Checks passed on the pull request, 0 to CHECKS.length. */
  checks: number;
  /** The diff is shown on the pull request. */
  diff: boolean;
  /** Dana approved. */
  approved: boolean;
  /** The merge queue merged it. */
  merged: boolean;
  /** Entries of the recorded session shown, 0 to SESSION.length. */
  entries: number;
  /** Priya posted in #web that it shipped. */
  shipped: boolean;
  /** Dana says support has been told, in #web. */
  told: boolean;
  /** The docs page shows the changed line. */
  docUpdated: boolean;
  cursor: CursorTarget;
  /** The cursor is pressing. */
  click: boolean;
  /** The cursor is shown at all. */
  cursorShown: boolean;
};

/** One entry of the session the coding agent recorded onto the pull request. */
export type SessionEntry = { kind: "prompt" | "message" | "tool"; text: string; tool?: string; commit?: string };

/** The session Priya's coding agent recorded onto #431 as it worked. */
export const SESSION: SessionEntry[] = [
  { kind: "prompt", text: "Big accounts time out on CSV export (Dana's report in #web). Find out why and fix it." },
  { kind: "tool", tool: "read", text: "services/export/csv.py" },
  { kind: "message", text: "Every row loads before the first byte is sent, so accounts over 100k rows hit the 60 s limit." },
  { kind: "tool", tool: "bash", text: "pytest tests/test_export.py -k big_account → 3.1 s, was 61 s" },
  { kind: "message", text: "Rows now stream in batches of 1,000. Opened #431.", commit: "3f9c2a1" },
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
  sessionClick: 6300,
  session: 6450,
  entry0: 6700,
  entryGap: 500,
  railChatClick: 10000,
  chat: 10150,
  shipped: 11000,
  told: 12200,
  railDocsClick: 14000,
  docs: 14150,
  docUpdated: 15300,
  end: 20000,
} as const;

/** The whole loop, in ms. */
export const LOOP_MS = BEAT.end;

/** The step pills under the frame: where each starts, for jumping to it. */
export const PILLS: { scene: Scene; label: string; start: number }[] = [
  { scene: "code", label: "Pull request", start: 0 },
  { scene: "session", label: "Session", start: BEAT.session },
  { scene: "chat", label: "Chat", start: BEAT.chat },
  { scene: "docs", label: "Artifacts", start: BEAT.docs },
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
    [BEAT.merged + 300, "pr-session"],
    [BEAT.session + 2600, "rail-chat"],
    [BEAT.told + 500, "rail-docs"],
    [BEAT.docs + 500, "idle"],
  ];
  let cursor: CursorTarget = "idle";
  for (const [at, target] of moves) if (t >= at) cursor = target;
  const click = press(BEAT.sessionClick) || press(BEAT.railChatClick) || press(BEAT.railDocsClick);
  return { cursor, click };
}

/** The frame at time t (ms into the loop). */
export function frameAt(time: number): Frame {
  const t = ((time % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const scene: Scene = t >= BEAT.docs ? "docs" : t >= BEAT.chat ? "chat" : t >= BEAT.session ? "session" : "code";
  const { cursor, click } = cursorAt(t);
  return {
    scene,
    checks: count(t, BEAT.check0, BEAT.checkGap, CHECKS.length),
    diff: t >= BEAT.diff,
    approved: t >= BEAT.approved,
    merged: t >= BEAT.merged,
    // The session was recorded before the story opens; the tour plays it back once its tab is opened.
    entries: t < BEAT.session ? 0 : count(t, BEAT.entry0, BEAT.entryGap, SESSION.length),
    shipped: t >= BEAT.shipped,
    told: t >= BEAT.told,
    docUpdated: t >= BEAT.docUpdated,
    cursor,
    click,
    cursorShown: t >= BEAT.merged && t < BEAT.end - 600,
  };
}

/** A still frame for each pill, for reduced motion: the moment the step makes its point. */
export const STILLS: Record<Scene, number> = {
  code: BEAT.approved + 200,
  session: BEAT.railChatClick - 400,
  chat: BEAT.told + 400,
  docs: BEAT.docUpdated + 400,
};

/** Whether two frames would draw the same. */
export function sameFrame(a: Frame, b: Frame): boolean {
  for (const key of Object.keys(a) as (keyof Frame)[]) if (a[key] !== b[key]) return false;
  return true;
}
