/**
 * The landing page's product tour: one story told as a timeline. Every
 * frame is a pure function of the time into the loop, so the tour can be
 * paused, resumed, jumped to a step, or shown still, and the server and
 * the first client render agree (t = 0).
 *
 * The story is Priya's morning. She opens Home: the notifications that
 * settled overnight leave Where you're needed, Start here picks what is
 * left, and What changed tells her in plain English what landed, that it
 * is live, and that her pull request #431 is in review. She opens #431: it
 * runs its checks, is approved by Dana and is merged by the queue, and
 * production deploys. Then how it was made: the session Priya's coding
 * agent recorded onto the pull request through g1t's MCP server. Last, the
 * people: #web, where Dana reported the bug and hears it shipped.
 */

export type Scene = "home" | "code" | "session" | "chat";

/** Where the soft cursor points: an element marked `data-tour="<target>"`. */
export type CursorTarget = "home-summarize" | "home-pr" | "pr-session" | "rail-code" | "rail-chat" | "idle";

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
  /** Notifications on Home that have settled themselves, 0 to SETTLED.length. */
  settled: number;
  /** Settled rows that have left Where you're needed, 0 to SETTLED.length. */
  cleared: number;
  /** Home has scrolled to What changed, as Summarize brings it into view. */
  summarizing: boolean;
  /** Words of What changed's summary shown, 0 to SUMMARY_WORDS.length. */
  words: number;
  /** The summary is finished: Ask a follow-up and Summarize again show. */
  summarized: boolean;
  /** Priya posted in #web that it shipped. */
  shipped: boolean;
  /** Dana says support has been told, in #web. */
  told: boolean;
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

/**
 * The notifications waiting on Priya that settle themselves while she
 * looks, each with the reason the events service writes when it settles
 * (services/events/src/inbox.rs).
 */
export const SETTLED: { title: string; detail: string; why: string }[] = [
  { title: "Deploy failed on main", detail: "acme/web main · Production on an older build", why: "Production of web deployed at 3f9c2a1" },
  { title: "Preview failed on webhook-retries", detail: "acme/web #433 · Run 410", why: "Alex merged #433 after run 411 passed" },
];

/** What Changed's answer, as g1t streams it onto Home. */
export const SUMMARY =
  "Two changes landed in acme/web since you were last here, and both are live. Jordan pinned the build image's cache key, which fixed last night's failed deploy, and Alex merged webhook retries (#433). Your CSV export fix (#431) is up: rows now stream in batches of 1,000, so the largest accounts no longer time out. Dana is reviewing it.";

export const SUMMARY_WORDS = SUMMARY.split(" ");

/** The beats of the story, in ms from the start of the loop. */
export const BEAT = {
  home: 0,
  settle0: 900,
  settleGap: 650,
  /** How long a settled row stays, saying why, before it leaves the list. */
  clearAfter: 1100,
  summarizeClick: 3600,
  summarizing: 3750,
  word0: 4400,
  wordGap: 48,
  /** #431 in What changed's answer, pressed once the answer is in. */
  prClick: 8500,
  code: 8650,
  check0: 9550,
  checkGap: 650,
  diff: 9950,
  approved: 12550,
  merged: 13650,
  sessionClick: 14950,
  session: 15100,
  entry0: 15350,
  entryGap: 450,
  railChatClick: 18000,
  chat: 18150,
  shipped: 19000,
  told: 20200,
  end: 23300,
} as const;

/** When the summary has finished streaming. */
export const SUMMARIZED = BEAT.word0 + SUMMARY_WORDS.length * BEAT.wordGap + 200;

/** The whole loop, in ms. */
export const LOOP_MS = BEAT.end;

/** The step pills under the frame: where each starts, for jumping to it. */
export const PILLS: { scene: Scene; label: string; start: number }[] = [
  { scene: "home", label: "Home", start: BEAT.home },
  { scene: "code", label: "Pull request", start: BEAT.code },
  { scene: "session", label: "Session", start: BEAT.session },
  { scene: "chat", label: "Chat", start: BEAT.chat },
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
    [BEAT.summarizeClick - 900, "home-summarize"],
    [BEAT.summarizing + 300, "idle"],
    [SUMMARIZED + 300, "home-pr"],
    [BEAT.code + 400, "idle"],
    [BEAT.merged + 300, "pr-session"],
    [BEAT.railChatClick - 900, "rail-chat"],
    [BEAT.chat + 500, "idle"],
  ];
  let cursor: CursorTarget = "idle";
  for (const [at, target] of moves) if (t >= at) cursor = target;
  const click = press(BEAT.summarizeClick) || press(BEAT.prClick) || press(BEAT.sessionClick) || press(BEAT.railChatClick);
  return { cursor, click };
}

/** The frame at time t (ms into the loop). */
export function frameAt(time: number): Frame {
  const t = ((time % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const scene: Scene = t >= BEAT.chat ? "chat" : t >= BEAT.session ? "session" : t >= BEAT.code ? "code" : "home";
  const { cursor, click } = cursorAt(t);
  return {
    scene,
    checks: count(t, BEAT.check0, BEAT.checkGap, CHECKS.length),
    diff: t >= BEAT.diff,
    approved: t >= BEAT.approved,
    merged: t >= BEAT.merged,
    // The session was recorded before the story opens; the tour plays it back once its tab is opened.
    entries: t < BEAT.session ? 0 : count(t, BEAT.entry0, BEAT.entryGap, SESSION.length),
    settled: count(t, BEAT.settle0, BEAT.settleGap, SETTLED.length),
    cleared: count(t, BEAT.settle0 + BEAT.clearAfter, BEAT.settleGap, SETTLED.length),
    summarizing: t >= BEAT.summarizing,
    words: count(t, BEAT.word0, BEAT.wordGap, SUMMARY_WORDS.length),
    summarized: t >= SUMMARIZED,
    shipped: t >= BEAT.shipped,
    told: t >= BEAT.told,
    cursor,
    click,
    // Out of the way while the pull request's checks run and it merges.
    cursorShown: (t >= BEAT.summarizeClick - 1500 && t < BEAT.code + 600) || (t >= BEAT.merged && t < BEAT.end - 600),
  };
}

/** A still frame for each pill, for reduced motion: the moment the step makes its point. */
export const STILLS: Record<Scene, number> = {
  home: SUMMARIZED + 400,
  code: BEAT.approved + 200,
  session: BEAT.railChatClick - 400,
  chat: BEAT.told + 400,
};

/** Whether two frames would draw the same. */
export function sameFrame(a: Frame, b: Frame): boolean {
  for (const key of Object.keys(a) as (keyof Frame)[]) if (a[key] !== b[key]) return false;
  return true;
}
