/**
 * An agent's face: a little creature drawn from its `avatar_seed`, in the
 * 5×7 pixel style of the g1t logo. The same seed always gives the same
 * creature: symmetric, in one colour from a palette that reads on the dark
 * base, and sometimes with eyes. Pure, so it is tested on its own.
 */

/** Colours that sit well on --g1t-bg, each with a darker shade for its ground. */
export const CREATURE_COLOURS: { fg: string; ground: string }[] = [
  { fg: "#b6a8ff", ground: "#221e38" }, // lavender
  { fg: "#86efc4", ground: "#10302a" }, // mint
  { fg: "#ffbd8c", ground: "#35241a" }, // peach
  { fg: "#8ab4ff", ground: "#18233a" }, // sky
  { fg: "#ff9ecf", ground: "#36192a" }, // pink
  { fg: "#f2dc72", ground: "#302a12" }, // lemon
  { fg: "#7fe3e0", ground: "#112f30" }, // teal
  { fg: "#ff8f85", ground: "#381a19" }, // coral
];

export const COLUMNS = 5;
export const ROWS = 7;

/** A cell: empty, body, or an eye. */
export type Cell = 0 | 1 | 2;

export type Creature = { cells: Cell[][]; colour: { fg: string; ground: string } };

/** FNV-1a, 32 bits: the seed as a number. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, good-enough generator from one number. */
function generator(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The creature for a seed: the left three columns chosen, mirrored to five. */
export function creature(seed: string): Creature {
  const random = generator(hash(seed || "agent"));
  // The first draws of a generator from near seeds sit close together:
  // spent, and the colour taken from a hash of its own.
  for (let i = 0; i < 4; i++) random();
  const colour = CREATURE_COLOURS[(hash(`colour:${seed}`) >>> 11) % CREATURE_COLOURS.length]!;
  const cells: Cell[][] = Array.from({ length: ROWS }, () => Array<Cell>(COLUMNS).fill(0));
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < 3; column++) {
      // Fuller towards the middle, so it reads as a body, not noise.
      const density = column === 2 ? 0.78 : column === 1 ? 0.6 : 0.42;
      const filled: Cell = random() < density ? 1 : 0;
      cells[row]![column] = filled;
      cells[row]![COLUMNS - 1 - column] = filled;
    }
  }
  // A spine down the middle from the second row to the second last, so it holds together.
  for (let row = 1; row < ROWS - 1; row++) cells[row]![2] = 1;
  // Eyes, more often than not: a pair on the second or third row, in a filled face.
  if (random() < 0.7) {
    const row = random() < 0.5 ? 2 : 3;
    for (const column of [1, 3]) cells[row]![column] = 2;
    for (const column of [0, 1, 2, 3, 4]) if (cells[row]![column] === 0 && column !== 0 && column !== 4) cells[row]![column] = 1;
    // A brow above the eyes keeps them from floating off the top.
    if (row === 2) for (const column of [1, 2, 3]) cells[1]![column] = 1;
  }
  return { cells, colour };
}
