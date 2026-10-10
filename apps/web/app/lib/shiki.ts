import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type { FileDiff } from "@g1t/contracts";

import type { HighlightedFile, HighlightedLine } from "./diff";

/**
 * Syntax highlighting, shared by the server and the browser. Grammars are
 * imported on first use, so a page that highlights nothing loads none.
 */

/** File extension (or whole file name) to Shiki language. */
const LANGUAGES: Record<string, string> = {
  rs: "rust",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  py: "python",
  go: "go",
  dockerfile: "docker",
};

/**
 * Code is coloured for both themes at once: each token's colour is
 * `light-dark(light, dark)`, so the page's Appearance (lib/theme.ts)
 * picks one with no second pass, and highlighted HTML kept in a cache is
 * right in either.
 */
export const THEMES = { light: "vitesse-light", dark: "vitesse-dark" } as const;

/** The language of a file, from its name, if it is one g1t highlights. */
export function languageOf(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  return LANGUAGES[name.includes(".") ? name.split(".").pop()! : name] ?? null;
}

/** The language a fenced block names (`rust`, `ts`, `sh`…), if g1t highlights it. */
export function languageNamed(name: string): string | null {
  const wanted = name.toLowerCase();
  if (Object.values(LANGUAGES).includes(wanted)) return wanted;
  return LANGUAGES[wanted] ?? (wanted === "shell" || wanted === "console" ? "shellscript" : null);
}

let highlighter: Promise<HighlighterCore> | undefined;

export function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/vitesse-light.mjs"), import("shiki/themes/vitesse-dark.mjs")],
    langs: [
      import("shiki/langs/rust.mjs"),
      import("shiki/langs/typescript.mjs"),
      import("shiki/langs/tsx.mjs"),
      import("shiki/langs/javascript.mjs"),
      import("shiki/langs/jsx.mjs"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/jsonc.mjs"),
      import("shiki/langs/toml.mjs"),
      import("shiki/langs/yaml.mjs"),
      import("shiki/langs/markdown.mjs"),
      import("shiki/langs/css.mjs"),
      import("shiki/langs/html.mjs"),
      import("shiki/langs/sql.mjs"),
      import("shiki/langs/shellscript.mjs"),
      import("shiki/langs/python.mjs"),
      import("shiki/langs/go.mjs"),
      import("shiki/langs/docker.mjs"),
    ],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A piece of a line and its colour, a `light-dark()` pair, if it has one. */
export type CodeToken = { content: string; color?: string };

/** Each line of `text` as coloured tokens, for both themes. */
export function tokenRows(core: HighlighterCore, text: string, lang: string): CodeToken[][] {
  return core.codeToTokensWithThemes(text, { lang, themes: THEMES }).map((row) =>
    row.map((token) => {
      const light = token.variants.light?.color;
      const dark = token.variants.dark?.color;
      const color = light && dark ? `light-dark(${light},${dark})` : (light ?? dark);
      return color ? { content: token.content, color } : { content: token.content };
    }),
  );
}

/** Each line of `text` as HTML, coloured. */
export function linesToHtml(core: HighlighterCore, text: string, lang: string): string[] {
  return tokenRows(core, text, lang).map((row) =>
    row
      .map((token) =>
        token.color ? `<span style="color:${token.color}">${escape(token.content)}</span>` : escape(token.content),
      )
      .join(""),
  );
}

/** Larger files in a diff are left plain. */
const MAX_FILE_DIFF_CHARS = 60_000;

/**
 * A file's diff with each line's text highlighted, or null when its
 * language is unknown or it is too large. Each hunk is highlighted twice,
 * as it was and as it is, so a line's colours come from the side it is on.
 */
export async function highlightFile(file: FileDiff): Promise<HighlightedFile | null> {
  const lang = languageOf(file.path);
  if (!lang || file.binary) return null;
  const size = file.hunks.reduce((sum, hunk) => sum + hunk.lines.reduce((n, line) => n + line.text.length, 0), 0);
  if (size > MAX_FILE_DIFF_CHARS) return null;
  const core = await getHighlighter();
  try {
    const hunks = file.hunks.map((hunk) => {
      const lines: HighlightedLine[] = hunk.lines.map((line) => ({ ...line }));
      for (const side of ["old", "new"] as const) {
        const indexes = lines
          .map((line, index) => (line.kind === (side === "old" ? "add" : "delete") ? -1 : index))
          .filter((index) => index >= 0);
        const html = linesToHtml(core, indexes.map((index) => lines[index]!.text).join("\n"), lang);
        html.forEach((row, n) => {
          const line = lines[indexes[n]!];
          // Context lines are the same on both sides; the new side wins.
          if (!line || (side === "old" && line.kind === "context")) return;
          line.html = row;
        });
      }
      return { lines };
    });
    return { ...file, hunks };
  } catch {
    return null;
  }
}
