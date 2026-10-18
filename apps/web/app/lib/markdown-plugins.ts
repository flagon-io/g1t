/**
 * g1t's additions to GitHub flavoured markdown. They run on the HTML tree
 * after it has been sanitized, so what they add is trusted and what the
 * author wrote never is.
 */

import { type RefContext, parseRef, refHref } from "./refs.ts";

type Text = { type: "text"; value: string };
type Element = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
};
/** A node of the HTML tree, loosely: only what these plugins read. */
type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

/** The repository a document belongs to, so `#12` is read in it. */
export type MarkdownRepo = { namespace: string; name: string };

/** The repository a site path like `/acme/web` names. */
export function repoAt(base?: string): MarkdownRepo | undefined {
  const [namespace, name] = (base ?? "").split("/").filter(Boolean);
  return namespace && name ? { namespace, name } : undefined;
}

export const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertKind = (typeof ALERTS)[number];

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i;

function isElement(node: Node, tag?: string): node is Element {
  return node.type === "element" && (tag == null || (node as Element).tagName === tag);
}

/**
 * GitHub's alerts: a quote that starts with `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` becomes a callout.
 */
export function rehypeAlerts() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      for (const child of node.children ?? []) {
        if (isElement(child, "blockquote")) {
          const first = child.children.find((c): c is Element => isElement(c, "p"));
          const text = first?.children[0];
          const match = text?.type === "text" ? ALERT_MARKER.exec((text as Text).value) : null;
          if (first && text && match) {
            (text as Text).value = (text as Text).value.slice(match[0].length);
            // A marker on a line of its own leaves an empty paragraph behind.
            if (first.children.length === 1 && !(text as Text).value.trim()) {
              child.children = child.children.filter((c) => c !== first);
            }
            child.properties = { ...child.properties, dataAlert: match[1]!.toLowerCase() };
          }
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

/**
 * Where `@g1t` leads: g1t's own agent, which has no profile. Never `/g1t`,
 * which staff made an alias of Flagon, Inc.'s workspace: mentioning g1t
 * always means the agent.
 */
export const G1T_MENTION_HREF = "https://docs.g1t.sh/";

/** `owner/repo#12`, `workspace#12`, `#12`, `@workspace/team`, `@name` and commit hashes, in one pass. */
const REFERENCE =
  /(?<![\w/@#])(?:(?:([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9._-]+))?)?#(\d+)|@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})\/([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,59})|@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})|([0-9a-f]{7,40}))(?![\w-])/gi;

function link(href: string, text: string, kind: string): Element {
  return {
    type: "element",
    tagName: "a",
    properties: { href, dataRef: kind },
    children: [{ type: "text", value: text }],
  };
}

/**
 * Links what a forge's text refers to: `#12`, `owner/repo#12` and
 * `workspace#12` to the work item or pull request they name, read as
 * lib/refs.ts says (in the document's repository, else its workspace),
 * `@name` to a person or workspace (`@g1t` to how g1t's agent works), and
 * a commit hash to its commit. Nothing inside code or a link changes.
 */
export function rehypeReferences(options: { repo?: MarkdownRepo; workspace?: string }) {
  const { repo, workspace: here } = options;
  const context: RefContext | null = repo ? { repo } : here ? { workspace: here } : null;
  return (tree: Node) => {
    const walk = (node: Node) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        if (isElement(child)) {
          if (child.tagName === "a" || child.tagName === "code" || child.tagName === "pre") continue;
          walk(child);
          continue;
        }
        if (child.type !== "text") continue;
        const value = (child as Text).value;
        const parts: Node[] = [];
        let last = 0;
        for (const match of value.matchAll(REFERENCE)) {
          const [whole, owner, otherName, number, workspace, team, name, hash] = match;
          let replacement: Element | null = null;
          if (number) {
            const ref = parseRef(owner, otherName, number);
            const href = ref ? refHref(ref, context) : null;
            if (href) replacement = link(href, whole, "ref");
          } else if (workspace && team) {
            replacement = link(`/${workspace.toLowerCase()}/-/teams/${team.toLowerCase()}`, whole, "team");
          } else if (name) {
            const href = name.toLowerCase() === "g1t" ? G1T_MENTION_HREF : `/${name.toLowerCase()}`;
            replacement = link(href, whole, "mention");
          } else if (hash && repo && /\d/.test(hash) && /[a-f]/i.test(hash)) {
            replacement = link(`/${repo.namespace}/${repo.name}/commit/${hash}`, hash.slice(0, 7), "commit");
          }
          if (!replacement) continue;
          if (match.index! > last) parts.push({ type: "text", value: value.slice(last, match.index) });
          parts.push(replacement);
          last = match.index! + whole.length;
        }
        if (parts.length === 0) continue;
        if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
        children.splice(index, 1, ...parts);
        index += parts.length - 1;
      }
    };
    walk(tree);
  };
}
