#!/usr/bin/env node
// Makes g1t's emoji data from Emojibase (https://emojibase.dev, MIT):
//
//   npm pack emojibase-data@17.0.0 && tar xzf emojibase-data-17.0.0.tgz
//   node scripts/emoji/generate.mjs ./package
//
// It writes two files, both checked in so nothing downloads at build time:
//
// - apps/web/app/components/emoji/data.json: every emoji the picker shows,
//   with its name, shortcodes, keywords, group and skin tones. The picker
//   loads it on first open, so it never adds to the site's main bundle.
// - services/chat/src/standard-emoji.ts: the standard shortcodes, which a
//   workspace's own emoji may not take.
//
// Shortcodes are the familiar chat set (iamcal's), then GitHub's for any
// that set lacks.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/emoji/generate.mjs <emojibase-data package folder>");
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => JSON.parse(readFileSync(join(source, path), "utf8"));

const version = read("package.json").version;
const compact = read("en/compact.json");
const iamcal = read("en/shortcodes/iamcal.json");
const github = read("en/shortcodes/github.json");

/** The groups the picker shows, in order; Emojibase's 2 (skin tone components) is left out. */
const GROUPS = [
  [0, "Smileys & emotion"],
  [1, "People & body"],
  [3, "Animals & nature"],
  [4, "Food & drink"],
  [5, "Travel & places"],
  [6, "Activities"],
  [7, "Objects"],
  [8, "Symbols"],
  [9, "Flags"],
];
const groupIndex = new Map(GROUPS.map(([id], index) => [id, index]));
const TONES = ["light skin tone", "medium-light skin tone", "medium skin tone", "medium-dark skin tone", "dark skin tone"];

// An emoji shown as one by default needs no variation selector after it
// ("👍", not "👍" + U+FE0F): one spelling, so reactions compare equal.
const VS16 = String.fromCodePoint(0xfe0f);
const plain = (unicode) =>
  unicode.endsWith(VS16) && /^\p{Emoji_Presentation}$/u.test(unicode.slice(0, -1)) ? unicode.slice(0, -1) : unicode;

const codesOf = (hexcode) => {
  const list = [];
  for (const set of [iamcal[hexcode], github[hexcode]]) {
    for (const code of [set ?? []].flat()) if (!list.includes(code)) list.push(code);
  }
  return list;
};

const entries = compact
  .filter((emoji) => groupIndex.has(emoji.group))
  .sort((a, b) => a.order - b.order)
  .map((emoji) => {
    const entry = [plain(emoji.unicode), emoji.label, codesOf(emoji.hexcode).join(" "), (emoji.tags ?? []).join(" "), groupIndex.get(emoji.group)];
    // Only the five single-tone variants: two-person emoji have mixed ones too.
    const skins = TONES.map((tone) => (emoji.skins ?? []).find((skin) => skin.label.endsWith(`: ${tone}`))?.unicode).map((skin) => skin && plain(skin));
    if (skins.every(Boolean)) entry.push(skins);
    return entry;
  });

const data = { source: `emojibase-data ${version} (MIT)`, groups: GROUPS.map(([, label]) => label), emoji: entries };
writeFileSync(join(root, "apps/web/app/components/emoji/data.json"), JSON.stringify(data));

const standard = new Set();
for (const set of [iamcal, github]) for (const codes of Object.values(set)) for (const code of [codes].flat()) standard.add(code);
writeFileSync(
  join(root, "services/chat/src/standard-emoji.ts"),
  `/**
 * The standard emoji shortcodes, which a workspace's own emoji may not
 * take. Made by scripts/emoji/generate.mjs from emojibase-data ${version}
 * (MIT); do not edit by hand.
 */
export const STANDARD_SHORTCODES: ReadonlySet<string> = new Set(
  ${JSON.stringify([...standard].sort().join(" "))}.split(" "),
);
`,
);
console.log(`${entries.length} emoji, ${standard.size} shortcodes, from emojibase-data ${version}`);
