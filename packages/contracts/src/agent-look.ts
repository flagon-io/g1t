/**
 * An agent's face (docs.g1t.sh/guides/agents/, "Its face"): the little bot
 * every agent wears when it has no uploaded picture. A face is a `look`,
 * seven choices the agent's owner can make; an agent with no look of its
 * own wears the one drawn from its `avatar_seed`, so every agent has a
 * stable face from the moment it is made, and keeps it through a rename.
 *
 * The site draws the face (apps/web/app/components/agent-face.tsx) and the
 * agents service keeps it (the `look` column, JSON). No value imports, so
 * services test it under Node as it is. Wire shapes are snake_case.
 */

export const FACE_SHAPES = ["round", "square", "squircle", "blob", "hex"] as const;
/** Ten named colours, each with a light and a dark rendering that read on both themes. */
export const FACE_COLORS = ["lavender", "mint", "peach", "sky", "pink", "lemon", "teal", "coral", "moss", "slate"] as const;
export const FACE_EYES = ["dots", "round", "wide", "happy", "visor", "sleepy"] as const;
export const FACE_MOUTHS = ["smile", "grin", "flat", "open", "none"] as const;
export const FACE_ANTENNAS = ["none", "single", "double", "bulb"] as const;
export const FACE_ACCESSORIES = ["none", "headphones", "bow", "glasses", "hat", "spark"] as const;
export const FACE_PATTERNS = ["none", "stripe", "dots", "gradient"] as const;

export type FaceShape = (typeof FACE_SHAPES)[number];
export type FaceColor = (typeof FACE_COLORS)[number];
export type FaceEyes = (typeof FACE_EYES)[number];
export type FaceMouth = (typeof FACE_MOUTHS)[number];
export type FaceAntenna = (typeof FACE_ANTENNAS)[number];
export type FaceAccessory = (typeof FACE_ACCESSORIES)[number];
export type FacePattern = (typeof FACE_PATTERNS)[number];

/** What an agent's face is made of. Every field is one of its listed choices. */
export type AgentLook = {
  shape: FaceShape;
  color: FaceColor;
  eyes: FaceEyes;
  mouth: FaceMouth;
  antenna: FaceAntenna;
  accessory: FaceAccessory;
  pattern: FacePattern;
};

/** Each part of a look and its choices, in the order the Face editor shows them. */
export const LOOK_OPTIONS: { [K in keyof AgentLook]: readonly AgentLook[K][] } = {
  shape: FACE_SHAPES,
  color: FACE_COLORS,
  eyes: FACE_EYES,
  mouth: FACE_MOUTHS,
  antenna: FACE_ANTENNAS,
  accessory: FACE_ACCESSORIES,
  pattern: FACE_PATTERNS,
};

export const LOOK_KEYS = Object.keys(LOOK_OPTIONS) as (keyof AgentLook)[];

/** FNV-1a, 32 bits: a seed as a number. */
function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** One choice for a part, from the seed and the part's name: parts vary independently. */
function pick<T>(seed: string, part: string, options: readonly T[], weights?: readonly number[]): T {
  const roll = fnv(`${part}:${seed}`) >>> 8;
  if (!weights) return options[roll % options.length]!;
  const total = weights.reduce((sum, w) => sum + w, 0);
  let at = roll % total;
  for (let i = 0; i < options.length; i++) {
    at -= weights[i]!;
    if (at < 0) return options[i]!;
  }
  return options[options.length - 1]!;
}

/**
 * The face an agent wears when it has chosen none: the same for the same
 * seed everywhere, and different from its neighbours' as far as seven
 * parts allow. Plainer choices (no antenna, no accessory, no pattern) are
 * weighted so faces read as a set rather than a costume party, and `none`
 * never lands on both the eyes' expression and the mouth.
 */
export function lookFromSeed(seed: string): AgentLook {
  const s = seed || "agent";
  const look: AgentLook = {
    shape: pick(s, "shape", FACE_SHAPES, [3, 2, 4, 2, 2]),
    color: pick(s, "color", FACE_COLORS),
    eyes: pick(s, "eyes", FACE_EYES, [3, 3, 2, 2, 2, 1]),
    mouth: pick(s, "mouth", FACE_MOUTHS, [4, 2, 2, 2, 1]),
    antenna: pick(s, "antenna", FACE_ANTENNAS, [4, 3, 2, 2]),
    accessory: pick(s, "accessory", FACE_ACCESSORIES, [7, 1, 1, 1, 1, 1]),
    pattern: pick(s, "pattern", FACE_PATTERNS, [6, 1, 1, 2]),
  };
  if (look.mouth === "none" && look.eyes === "visor") look.mouth = "flat";
  return look;
}

/**
 * A look as it was sent or stored, checked: every part present and one of
 * its choices. Null when it is not one (a service refuses it, a page draws
 * the seed's face instead).
 */
export function readLook(raw: unknown): AgentLook | null {
  const value = typeof raw === "string" ? parse(raw) : raw;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const given = value as Record<string, unknown>;
  const look: Partial<AgentLook> = {};
  for (const key of LOOK_KEYS) {
    const options = LOOK_OPTIONS[key] as readonly string[];
    const choice = given[key];
    if (typeof choice !== "string" || !options.includes(choice)) return null;
    (look as Record<string, string>)[key] = choice;
  }
  return look as AgentLook;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether two looks are the same face. */
export function sameLook(a: AgentLook | null | undefined, b: AgentLook | null | undefined): boolean {
  if (!a || !b) return a == b;
  return LOOK_KEYS.every((key) => a[key] === b[key]);
}

/** The face an agent shows: its own look, else the one its seed draws. */
export function lookOf(agent: { look?: AgentLook | null; avatar_seed?: string | null; id?: string | null; handle?: string | null; name?: string | null }): AgentLook {
  return agent.look ?? lookFromSeed(agent.avatar_seed || agent.id || agent.handle || agent.name || "agent");
}

/**
 * A random look, for the Shuffle button: `random` is `Math.random` unless
 * a test hands in its own. Every part is drawn evenly, so shuffling shows
 * the whole range.
 */
export function randomLook(random: () => number = Math.random): AgentLook {
  const draw = <T>(options: readonly T[]): T => options[Math.min(options.length - 1, Math.floor(random() * options.length))]!;
  return {
    shape: draw(FACE_SHAPES),
    color: draw(FACE_COLORS),
    eyes: draw(FACE_EYES),
    mouth: draw(FACE_MOUTHS),
    antenna: draw(FACE_ANTENNAS),
    accessory: draw(FACE_ACCESSORIES),
    pattern: draw(FACE_PATTERNS),
  };
}

/**
 * What a personality preset suggests for a face that has not been chosen:
 * a precise voice looks precise. Only a suggestion, applied by the Face
 * editor when the person has made no choice; it never changes a look an
 * agent already has.
 */
export const PRESET_EXPRESSIONS: Record<string, Partial<AgentLook>> = {
  crisp: { eyes: "dots", mouth: "flat" },
  friendly: { eyes: "happy", mouth: "smile" },
  socratic: { eyes: "round", mouth: "open" },
  terse: { eyes: "visor", mouth: "flat" },
};

/** The seed's face with the preset's expression laid over it, for an agent that has chosen no look. */
export function suggestedLook(seed: string, preset: string | null | undefined): AgentLook {
  return { ...lookFromSeed(seed), ...(preset ? (PRESET_EXPRESSIONS[preset] ?? {}) : {}) };
}
