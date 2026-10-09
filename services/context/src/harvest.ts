/**
 * Which docs, and which of their lines, are worth suggesting as memory.
 *
 * Memory is for how to work in a project: how to build, test and run it,
 * its conventions and its traps. A project's docs also hold plans,
 * roadmaps, feedback to vendors and release notes, which say what someone
 * wants, not how things are; none of that is suggested. A line is taken
 * whole (a bullet with its continuation lines), cut only between sentences
 * to fit, and left out when even its first sentence does not fit. Pure.
 */

/** README, AGENTS.md (or CLAUDE.md), CONTRIBUTING, or another doc. */
export type DocRole = "readme" | "agents" | "contributing" | "doc";

/** What a project's `.g1t/project.yml` says about memory from its docs. */
export type MemoryDocsConfig = {
  /** Docs to read for memory besides the ones g1t picks, by path or `dir/*`. */
  docs: string[];
  /** Docs never read for memory, by path or `dir/*`. Wins over `docs`. */
  skip: string[];
};

/** The longest memory suggested from a doc, in characters. */
export const MAX_DOC_HINT_CHARS = 300;

/** Doc names that say how to work on a project. */
const WORKING_NAME =
  /(build|test|setup|set-up|develop|contribut|hacking|architecture|convention|style|guideline|standard|deploy|install|getting[-_ ]?started|local|onboard|troubleshoot|debug|runbook|self[-_ ]?host|coding|structure|layout|workflow|agents|claude)/i;
/** Doc names that hold plans, feedback, history or news. */
const PLAN_NAME =
  /(plan|roadmap|feedback|changelog|changes|history|news|release[-_ ]?notes|rfc|proposal|idea|todo|backlog|vision|strategy|research|demo|incident|postmortem|post-mortem|retro|meeting|minutes|notes|draft|wish|faq|announce|blog|pitch)/i;

/** Headings of sections that hold plans, asks or history. */
const PLAN_HEADING =
  /\b(roadmap|plans?|planned|planning|milestones?|phase \d+|future|later|next steps|what'?s next|what we'?d love|wish ?list|asks?|feedback|changelog|release notes|what'?s new|open questions|non-goals|goals|ideas|proposals?|backlog|todo|executive summary|what we (hit|tried|built|want))\b/i;
/** Headings of sections that say how things are done here. */
const CONVENTION_HEADING =
  /\b(conventions?|guidelines?|code style|coding style|style guide|standards|gotchas?|pitfalls?|caveats?|known issues|troubleshooting|before you (push|commit|open)|house rules|how we work|working (here|on|in)|dos and don'?ts|rules for (contributors|agents|code))\b/i;
/** Headings of sections that say how to set up, build or test. */
export const SETUP_HEADING =
  /\b(develop|development|getting started|setup|set up|install|installing|build|building|test|testing|contribut|running|run locally|local|before you push|deploying)\b/i;

/** A bullet's bold label that marks it as a plan, an ask or a report. */
const PLAN_LABEL =
  /^(ask|asks|what we (tried|hit|built|want|need|'d love)|what it means|proposal|idea|plan|next|later|future|todo|status|why it matters)\b/i;
/** Words that make a line a plan or a wish rather than how things are. */
const ASPIRATION =
  /\b(will|won'?t|would|should|could|might|shall|plans? to|planned|we'?d|we'?ll|eventually|someday|one day|in the future|not yet|coming soon|todo|tbd|wip|roadmap)\b|^ask\b/i;
/** The modal words an AGENTS.md uses to state a rule; aspirational elsewhere. */
const RULE_MODAL = /\b(will|won'?t|would|should|could|might|shall)\b/gi;

/** Words that mark a line as a trap. */
const GOTCHA =
  /^(never|don'?t|do not|avoid|beware|careful|warning|watch out)\b|\b(must not|must never|gotcha|beware|careful|fails? (unless|if|when|until|without)|breaks? (if|when|unless)|otherwise)\b/i;
/** Words that mark a line as a rule of how things are done. */
const CONVENTION =
  /^(use|run|prefer|keep|put|name|write|import|add|look|always|never|don'?t|do not|avoid|make sure|remember|check|update|commit|open|follow|place|call|read|test|document)\b|\b(we use|must|prefer|instead of|rather than|always|never|convention|is required|are required)\b/i;

/** Whether `path` matches one of `patterns`: an exact path, or `dir/*`. */
function matches(path: string, patterns: string[]): boolean {
  const lower = path.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.trim().replace(/^\.?\//, "").toLowerCase();
    if (!pattern) return false;
    if (pattern.endsWith("/*")) return lower.startsWith(pattern.slice(0, -1)) && !lower.slice(pattern.length - 1).includes("/");
    if (pattern.endsWith("/")) return lower.startsWith(pattern);
    return lower === pattern;
  });
}

/**
 * Whether memory is suggested from the doc at `path`: a README, AGENTS.md,
 * CLAUDE.md or CONTRIBUTING always, a runbook, and another doc when its
 * name says how to work on the project (`docs/DEPLOYING.md`, not
 * `docs/PLAN.md` or `docs/CHANGELOG.md`). `.g1t/project.yml` can add docs
 * or leave them out.
 */
export function harvestable(path: string, role: DocRole, config?: MemoryDocsConfig | null): boolean {
  if (config && matches(path, config.skip)) return false;
  if (config && matches(path, config.docs)) return true;
  if (role !== "doc") return true;
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown|txt)$/i, "");
  if (PLAN_NAME.test(name)) return false;
  if (/(^|\/)runbooks\//i.test(path)) return true;
  return WORKING_NAME.test(name);
}

/**
 * Whether a doc reads as a plan, a report or feedback rather than how to
 * work: many of its headings are plans or asks, or many of its bullets are
 * labelled as asks and findings.
 */
export function planLike(text: string): boolean {
  let headings = 0;
  let planHeadings = 0;
  let labels = 0;
  let aspirations = 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1];
    if (heading) {
      headings++;
      if (PLAN_HEADING.test(heading)) planHeadings++;
      continue;
    }
    const label = /^\s*[-*+]\s+\*\*([^*]+)\*\*/.exec(line)?.[1];
    if (label && PLAN_LABEL.test(label.trim())) labels++;
    if (line.trim()) {
      lines++;
      if (/\b(we will|we'?ll|we plan|we'?d love|will be|is planned|are planned|not yet built|coming soon)\b/i.test(line)) aspirations++;
    }
  }
  return labels >= 3 || (headings >= 3 && planHeadings * 3 >= headings) || (lines >= 20 && aspirations * 8 >= lines);
}

/** Markdown inline marks taken out: bold, italics, links to their text, images. */
export function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|[.,;:!?)]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const ABBREVIATION = /(\b(e\.g|i\.e|etc|vs|cf|approx|no|fig)\.|\b[A-Z]\.)$/i;

/** A line's sentences, never split inside `code` or after an abbreviation. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    current += c;
    if (c === "`") code = !code;
    if (code || !/[.!?]/.test(c)) continue;
    const next = text[i + 1];
    // A full stop inside a word (README.md, v1.2) or before more punctuation.
    if (next !== undefined && !/\s/.test(next)) continue;
    if (ABBREVIATION.test(current.trimEnd())) continue;
    out.push(current.trim());
    current = "";
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * `text` whole if it fits in `max` characters; otherwise as many of its
 * first sentences as fit; null when not even the first one does. Never cut
 * inside a sentence.
 */
export function wholeSentences(text: string, max = MAX_DOC_HINT_CHARS): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let out = "";
  for (const sentence of sentencesOf(line)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  return out && /[.!?]$/.test(out) ? out : null;
}

/** Whether a line says what someone wants or plans rather than how things are. */
export function aspirational(text: string, role: DocRole): boolean {
  const label = /^\*\*([^*]+)\*\*/.exec(text.trim())?.[1]?.trim();
  if (label && PLAN_LABEL.test(label)) return true;
  const words = plain(text);
  if (/^(ask|what we (tried|hit|built))\b/i.test(words)) return true;
  // AGENTS.md states its rules with "should" and "will": those are rules.
  const checked = role === "agents" ? words.replace(RULE_MODAL, "") : words;
  return ASPIRATION.test(checked);
}

/** The kind of memory a line from a doc is, and how sure g1t is of it. */
export function classify(text: string, heading: string, role: DocRole): { kind: "fact" | "convention" | "gotcha"; confidence: number } {
  const agents = role === "agents";
  if (GOTCHA.test(text)) return { kind: "gotcha", confidence: agents ? 0.9 : 0.6 };
  if (CONVENTION.test(text) || (agents && CONVENTION_HEADING.test(heading))) return { kind: "convention", confidence: agents ? 0.9 : 0.6 };
  return { kind: "fact", confidence: agents ? 0.85 : 0.5 };
}

/** Headings of sections that report or explain rather than say how. */
const REPORT_HEADING = /\b(speed|performance|benchmarks?|timings?|costs?|numbers|results|findings|lessons|why|background|motivation|history|incidents?|features|status)\b/i;

/** Whether a section's bullets are worth reading for memory. */
export function bulletSection(heading: string, role: DocRole): boolean {
  if (PLAN_HEADING.test(heading) || (role !== "agents" && REPORT_HEADING.test(heading))) return false;
  return role === "agents" || CONVENTION_HEADING.test(heading) || SETUP_HEADING.test(heading);
}

/** Whether a section is a plan, an ask or history, with everything under it. */
export function planSection(heading: string): boolean {
  return PLAN_HEADING.test(heading);
}

export type Bullet = { text: string; heading: string };

/**
 * A doc's bullets, each whole with its continuation lines, with the heading
 * it is under. Bullets in code blocks and in plan sections (and their
 * subsections) are left out.
 */
export function bulletsOf(markdown: string): Bullet[] {
  const out: Bullet[] = [];
  let heading = "";
  // The level of the plan section being skipped, if any.
  let skipping = 0;
  let fenced = false;
  let current: { text: string; indent: number } | null = null;
  const flush = () => {
    if (current && !skipping) out.push({ text: current.text.replace(/\s+/g, " ").trim(), heading });
    current = null;
  };
  for (const raw of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      flush();
      const level = h[1].length;
      if (skipping && level <= skipping) skipping = 0;
      heading = h[2].trim();
      if (!skipping && planSection(heading)) skipping = level;
      continue;
    }
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    if (bullet) {
      flush();
      current = { text: bullet[2], indent: bullet[1].length };
      continue;
    }
    if (current && raw.trim() && /^\s+/.test(raw) && raw.search(/\S/) > current.indent) {
      current.text += ` ${raw.trim()}`;
      continue;
    }
    // A blank line or a paragraph ends the bullet. A bullet's lazy
    // continuation (not indented) is still part of it.
    if (current && raw.trim() && !/^\s*[|<>]/.test(raw)) {
      current.text += ` ${raw.trim()}`;
      continue;
    }
    flush();
  }
  flush();
  return out;
}
