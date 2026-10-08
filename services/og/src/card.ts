/**
 * The cards' layouts, as the element trees satori lays out. One frame for
 * every kind: the lockup and the address along the top, the subject in the
 * middle, the facts along the bottom, on the site's very dark gray with a
 * dot grid and lavender kept for accents.
 */
import { COLOR, ICON, LOCKUP_BOX, backdropSvg, dataUri, iconSvg, lockupSvg } from "./brand.ts";
import type { Card, IssueState } from "./resolve.ts";
import type { PullStatus } from "@g1t/contracts";

export const WIDTH = 1200;
export const HEIGHT = 630;
const PAD = 80;

/** The launch line: what g1t is, on the brand card and under every page card. */
export const TAGLINE = "Where people and agents ship software together.";

/** An element as satori reads it. */
export type Node = { type: string; props: Record<string, unknown> & { style?: Style; children?: Child } };
type Child = Node | string | (Node | string | null | false)[] | null;
type Style = Record<string, string | number>;

function h(type: string, style: Style, ...children: (Node | string | null | false)[]): Node {
  const kids = children.filter((child): child is Node | string => child !== null && child !== false);
  if (kids.length === 0) return { type, props: { style } };
  return { type, props: { style, children: kids.length === 1 ? kids[0] : kids } };
}

function img(src: string, width: number, height: number, style: Style = {}): Node {
  return { type: "img", props: { src, width, height, style: { width, height, ...style } } };
}

function icon(shapes: string, color: string, size: number): Node {
  return img(dataUri(iconSvg(shapes, color)), size, size, { flexShrink: 0 });
}

const SANS = "Hanken Grotesk";
/** Headlines: a card's title and the brand line. */
const DISPLAY = "Bricolage Grotesque";
const MONO = "IBM Plex Mono";

/** Long text is cut before layout, so a huge title costs nothing to lay out. */
function bound(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1).trimEnd()}…` : single;
}

/** A block of text that stops after `lines`, with an ellipsis. */
function clamp(text: string, lines: number, style: Style): Node {
  return h("div", { display: "block", lineClamp: lines, overflow: "hidden", ...style }, text);
}

/** Bigger type for shorter titles, so a two-word title fills the card and a long one fits. */
function titleSize(text: string): number {
  if (text.length <= 28) return 76;
  if (text.length <= 56) return 64;
  if (text.length <= 96) return 54;
  return 46;
}

// --- Pieces --------------------------------------------------------------

/** The backdrop: dot grid, lavender light and, on most cards, the pixel 1. */
function background(withOne: boolean): Node {
  return img(dataUri(backdropSvg(WIDTH, HEIGHT, withOne)), WIDTH, HEIGHT, { position: "absolute", top: 0, left: 0 });
}

/** The lavender rule along the bottom edge. */
function rule(): Node {
  return h("div", {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: WIDTH,
    height: 6,
    backgroundImage: `linear-gradient(to right, ${COLOR.lavenderDeep}, ${COLOR.lavender} 45%, rgba(182, 168, 255, 0.15))`,
  });
}

function lockup(height: number, suffix?: string): Node {
  const width = Math.round((height * LOCKUP_BOX.width) / LOCKUP_BOX.height);
  return h(
    "div",
    { display: "flex", alignItems: "flex-end" },
    img(dataUri(lockupSvg()), width, height),
    suffix
      ? h(
          "div",
          {
            display: "flex",
            fontFamily: SANS,
            fontWeight: 500,
            fontSize: Math.round(height * 0.62),
            color: COLOR.muted,
            marginLeft: Math.round(height * 0.22),
            // Sits on the wordmark's baseline.
            marginBottom: Math.round(height * (1 - LOCKUP_BOX.baseline / LOCKUP_BOX.height) - height * 0.1),
            letterSpacing: -0.5,
          },
          suffix,
        )
      : null,
  );
}

function topBar(address: string, suffix?: string): Node {
  return h(
    "div",
    { display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" },
    lockup(46, suffix),
    h(
      "div",
      { display: "flex", fontFamily: MONO, fontSize: 22, color: COLOR.faint, whiteSpace: "nowrap" },
      bound(address, 46),
    ),
  );
}

type Tone = { color: string; bg: string; border: string };

const TONE = {
  open: { color: COLOR.mint, bg: "rgba(134, 239, 196, 0.10)", border: "rgba(134, 239, 196, 0.38)" },
  merged: { color: COLOR.merged, bg: "rgba(166, 120, 245, 0.12)", border: "rgba(166, 120, 245, 0.42)" },
  closed: { color: COLOR.danger, bg: "rgba(255, 131, 148, 0.10)", border: "rgba(255, 131, 148, 0.38)" },
  quiet: { color: COLOR.muted, bg: "rgba(160, 160, 168, 0.08)", border: "rgba(160, 160, 168, 0.30)" },
} satisfies Record<string, Tone>;

function badge(label: string, shapes: string, tone: Tone): Node {
  return h(
    "div",
    {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 22px 10px 18px",
      borderRadius: 999,
      backgroundColor: tone.bg,
      border: `2px solid ${tone.border}`,
      color: tone.color,
      fontFamily: SANS,
      fontWeight: 600,
      fontSize: 26,
    },
    icon(shapes, tone.color, 28),
    label,
  );
}

/** A fact along the bottom: an icon, a number or a word, and what it counts. */
function fact(shapes: string, strong: string, rest: string): Node {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 12, fontFamily: SANS, fontSize: 28, color: COLOR.muted },
    icon(shapes, COLOR.faint, 28),
    h("div", { display: "flex", color: COLOR.fg, fontWeight: 600 }, strong),
    rest ? h("div", { display: "flex" }, rest) : null,
  );
}

function plain(text: string, mono = false): Node {
  return h(
    "div",
    { display: "flex", fontFamily: mono ? MONO : SANS, fontSize: mono ? 25 : 28, color: COLOR.muted },
    text,
  );
}

const dot = () => h("div", { display: "flex", fontSize: 28, color: COLOR.faint }, "·");

/** The frame every card but the brand card shares. */
function frame(parts: {
  address: string;
  suffix?: string;
  eyebrow: Node;
  title: Node;
  description: string | null;
  facts: Node[];
  descriptionLines?: number;
}): Node {
  return h(
    "div",
    {
      display: "flex",
      position: "relative",
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: COLOR.bg,
      overflow: "hidden",
    },
    background(true),
    h(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        position: "relative",
        width: WIDTH,
        height: HEIGHT,
        padding: `64px ${PAD}px 72px`,
      },
      topBar(parts.address, parts.suffix),
      h(
        "div",
        { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", width: 940 },
        parts.eyebrow,
        h("div", { display: "flex", marginTop: 18 }, parts.title),
        parts.description
          ? clamp(bound(parts.description, 260), parts.descriptionLines ?? 2, {
              marginTop: 22,
              fontFamily: SANS,
              fontSize: 30,
              lineHeight: 1.4,
              color: COLOR.muted,
            })
          : null,
      ),
      h("div", { display: "flex", alignItems: "center", gap: 24, height: 56 }, ...parts.facts),
    ),
    rule(),
  );
}

function eyebrow(text: string, mono: boolean, color: string = COLOR.lavender): Node {
  return h(
    "div",
    {
      display: "flex",
      fontFamily: mono ? MONO : SANS,
      fontWeight: 500,
      fontSize: mono ? 28 : 26,
      color,
      letterSpacing: mono ? 0 : 2,
      textTransform: mono ? "none" : "uppercase",
    },
    bound(text, 60),
  );
}

function title(text: string, lines = 3): Node {
  const bounded = bound(text, 180);
  const size = titleSize(bounded);
  return clamp(bounded, lines, {
    fontFamily: DISPLAY,
    fontWeight: 600,
    fontSize: size,
    lineHeight: 1.12,
    letterSpacing: size >= 64 ? -1.3 : -0.8,
    color: COLOR.fg,
    width: 940,
  });
}

// --- Cards ---------------------------------------------------------------

function brandCard(): Node {
  const height = 190;
  const width = Math.round((height * LOCKUP_BOX.width) / LOCKUP_BOX.height);
  return h(
    "div",
    {
      display: "flex",
      position: "relative",
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: COLOR.bg,
      overflow: "hidden",
    },
    background(false),
    h(
      "div",
      {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        width: WIDTH,
        height: HEIGHT,
      },
      img(dataUri(lockupSvg()), width, height),
      h(
        "div",
        {
          display: "flex",
          marginTop: 56,
          fontFamily: DISPLAY,
          fontWeight: 500,
          fontSize: 44,
          letterSpacing: -0.5,
          color: COLOR.fgSoft,
        },
        TAGLINE,
      ),
      h(
        "div",
        { display: "flex", marginTop: 40, fontFamily: MONO, fontSize: 26, color: COLOR.lavender },
        "g1t.sh",
      ),
    ),
    rule(),
  );
}

const PULL_BADGE: Record<PullStatus, [string, string, Tone]> = {
  open: ["Open", ICON.pull, TONE.open],
  draft: ["Draft", ICON.pullDraft, TONE.quiet],
  merged: ["Merged", ICON.merged, TONE.merged],
  closed: ["Closed", ICON.pullClosed, TONE.closed],
};

const ISSUE_BADGE: Record<IssueState, [string, string, Tone]> = {
  open: ["Open", ICON.issue, TONE.open],
  completed: ["Closed", ICON.issueDone, TONE.merged],
  not_planned: ["Not planned", ICON.issueNotPlanned, TONE.quiet],
};

function count(n: number, one: string, many: string): [string, string] {
  return [n.toLocaleString("en-US"), n === 1 ? one : many];
}

export function cardTree(card: Card): Node {
  switch (card.kind) {
    case "brand":
      return brandCard();

    case "page":
      return frame({
        address: card.address,
        eyebrow: eyebrow(card.eyebrow, false),
        title: title(card.title),
        description: card.description,
        facts: [plain(TAGLINE)],
      });

    case "workspace": {
      const [n, noun] = count(card.projects, "public project", "public projects");
      return frame({
        address: `g1t.sh/${card.slug}`,
        // The slug above the name, unless they are the same.
        eyebrow: withIcon(
          card.icon,
          card.name.toLowerCase() === card.slug ? eyebrow("Workspace", false) : eyebrow(card.slug, true),
        ),
        title: title(card.name, 2),
        description: card.description,
        facts: [fact(ICON.box, n, noun)],
      });
    }

    case "person": {
      const [merged, mergedNoun] = count(card.pullsMerged, "pull request merged", "pull requests merged");
      const [pulls, pullNoun] = count(card.pullsOpen, "open pull request", "open pull requests");
      const [issues, issueNoun] = count(card.issues, "issue opened", "issues opened");
      return frame({
        address: `g1t.sh/u/${card.username}`,
        // The username above the name they go by; "Profile" when there is none.
        eyebrow: withIcon(card.icon, card.name ? eyebrow(`@${card.username}`, true) : eyebrow("Profile", false), true),
        title: card.name ? title(card.name, 2) : repoTitle(card.username),
        description: card.bio,
        facts: [
          fact(ICON.merged, merged, mergedNoun),
          fact(ICON.pull, pulls, pullNoun),
          fact(ICON.issue, issues, issueNoun),
        ],
      });
    }

    case "project": {
      const [issues, issueNoun] = count(card.issues, "open issue", "open issues");
      const [pulls, pullNoun] = count(card.pulls, "open pull request", "open pull requests");
      const named = card.name.toLowerCase() !== card.repo.toLowerCase();
      return frame({
        address: `g1t.sh/${card.owner}/${card.repo}`,
        eyebrow: eyebrow(named ? `${card.owner}/${card.repo}` : `${card.owner} /`, true),
        title: named ? title(card.name, 2) : repoTitle(card.repo),
        description: card.description,
        facts: [fact(ICON.issue, issues, issueNoun), fact(ICON.pull, pulls, pullNoun)],
      });
    }

    case "issue": {
      const [label, shapes, tone] = ISSUE_BADGE[card.state];
      return frame({
        address: `g1t.sh/${card.owner}/${card.repo}/issues/${card.number}`,
        eyebrow: eyebrowWithNumber(`${card.owner}/${card.repo}`, card.number),
        title: title(card.title),
        description: null,
        facts: [badge(label, shapes, tone), plain("Issue"), dot(), byline(card.author, card.requestedBy)],
      });
    }

    case "pull": {
      const [label, shapes, tone] = PULL_BADGE[card.state];
      return frame({
        address: `g1t.sh/${card.owner}/${card.repo}/pull/${card.number}`,
        eyebrow: eyebrowWithNumber(`${card.owner}/${card.repo}`, card.number),
        title: title(card.title),
        description: null,
        facts: [badge(label, shapes, tone), plain("Pull request"), dot(), byline(card.author, card.requestedBy)],
      });
    }

    case "soon":
      return frame({
        address: `g1t.sh/${card.owner}/${card.repo}`,
        eyebrow: eyebrow(`${card.owner}/${card.repo}`, true),
        title: title(card.title, 2),
        description: card.summary,
        facts: [badge("Soon", ICON.sparkles, TONE.open), plain(card.section)],
      });

    case "docs":
      return frame({
        address: "docs.g1t.sh",
        suffix: "docs",
        eyebrow: eyebrow(card.section ?? "Documentation", false),
        title: title(card.title, 2),
        description: card.description,
        facts: [fact(ICON.book, "g1t docs", "Guides and API reference")],
      });
  }
}

/** The uploaded icon beside an eyebrow, when there is one: round for a person. */
function withIcon(icon: string | undefined, beside: Node, round = false): Node {
  if (!icon) return beside;
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 22 },
    img(icon, 64, 64, { borderRadius: round ? 32 : 14, objectFit: "cover", flexShrink: 0 }),
    beside,
  );
}

/** A repository's name in mono, large: the project's own address. */
function repoTitle(name: string): Node {
  const bounded = bound(name, 60);
  const size = bounded.length <= 16 ? 84 : bounded.length <= 26 ? 68 : 52;
  return clamp(bounded, 2, {
    fontFamily: MONO,
    fontWeight: 500,
    fontSize: size,
    lineHeight: 1.12,
    letterSpacing: -1,
    color: COLOR.fg,
    width: 940,
  });
}

function eyebrowWithNumber(repo: string, number: number): Node {
  return h(
    "div",
    { display: "flex", alignItems: "baseline", fontFamily: MONO, fontWeight: 500, fontSize: 28 },
    h("div", { display: "flex", color: COLOR.lavender }, bound(repo, 48)),
    h("div", { display: "flex", color: COLOR.faint, marginLeft: 14 }, `#${number}`),
  );
}

/** "by ana", or "by g1t for ana" for what g1t opened for someone. */
function byline(author: string, requestedBy: string | null): Node {
  const name = (text: string) => h("div", { display: "flex", fontFamily: MONO, fontSize: 26, color: COLOR.fgSoft }, bound(text, 32));
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 10, fontFamily: SANS, fontSize: 28, color: COLOR.muted },
    "by",
    name(author),
    ...(requestedBy ? ["for", name(requestedBy)] : []),
  );
}
