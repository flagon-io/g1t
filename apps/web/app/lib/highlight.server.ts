import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

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

const MAX_HIGHLIGHT_CHARS = 200_000;

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/vitesse-dark.mjs")],
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

/**
 * Highlighted HTML for a file, or null when its language is unknown or it
 * is too large, in which case the caller shows plain text.
 */
export async function highlight(
  path: string,
  text: string,
): Promise<string | null> {
  const name = path.split("/").pop()!.toLowerCase();
  const lang = LANGUAGES[name.includes(".") ? name.split(".").pop()! : name];
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    return (await getHighlighter()).codeToHtml(text.replace(/\n$/, ""), {
      lang,
      theme: "vitesse-dark",
    });
  } catch {
    return null;
  }
}
