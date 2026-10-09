import type { Root } from "hast";
import { type Components as JsxComponents, toJsxRuntime } from "hast-util-to-jsx-runtime";
import { urlAttributes } from "html-url-attributes";
import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { type Components, defaultUrlTransform } from "react-markdown";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

/**
 * Markdown in two steps, the same two `react-markdown`'s `<Markdown>` takes
 * on every render, split so the first can be kept:
 *
 * 1. `markdownTree`: parse, run the plugins, make URLs safe. Most of the
 *    work (nine tenths of a large README's), and it depends only on the
 *    text and the plugins, so components/markdown.tsx keeps its trees.
 * 2. `renderMarkdownTree`: the tree as React elements, with the page's
 *    components.
 *
 * Together they make exactly what `<Markdown>` makes for the same options
 * (lib/markdown-tree.test.ts renders both and compares). Options this file
 * does not take (`allowedElements`, `skipHtml`, `urlTransform`, …) are not
 * used by g1t.
 */
export type MarkdownTreeOptions = {
  remarkPlugins?: PluggableList;
  rehypePlugins?: PluggableList;
};

/** The hast tree `<Markdown>` would render for `source`. Not changed by rendering, so it can be kept and rendered again. */
export function markdownTree(source: string, options: MarkdownTreeOptions = {}): Root {
  const processor = unified()
    .use(remarkParse)
    .use(options.remarkPlugins ?? [])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(options.rehypePlugins ?? []);
  const file = new VFile();
  file.value = source;
  const tree = processor.runSync(processor.parse(file), file) as Root;
  // What react-markdown does before rendering: raw HTML left over becomes
  // text, and every URL attribute goes through the default transform.
  visit(tree, (node, index, parent) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value };
      return index;
    }
    if (node.type === "element") {
      for (const key in urlAttributes) {
        if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(node.properties, key)) {
          const value = node.properties[key];
          const test = urlAttributes[key];
          if (test === null || test.includes(node.tagName)) {
            node.properties[key] = defaultUrlTransform(String(value || ""));
          }
        }
      }
    }
    return undefined;
  });
  return tree;
}

/** `tree` as React elements, as `<Markdown>` renders it with `components`. */
export function renderMarkdownTree(tree: Root, components?: Components): ReactElement {
  return toJsxRuntime(tree, {
    Fragment,
    // react-markdown's components, which it hands to this same function.
    components: components as JsxComponents | undefined,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
}

/** How much a kept tree weighs: its text's length, a stand-in for the tree's size. */
export function markdownWeight(source: string): number {
  return source.length + 64;
}
