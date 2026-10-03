/**
 * g1t's additions to GitHub flavoured markdown. They run on the HTML tree
 * after it has been sanitized, so what they add is trusted and what the
 * author wrote never is.
 */

type Text = { type: "text"; value: string };
type Element = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: Node[];
};
/** A node of the HTML tree, loosely: only what these plugins read. */
type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[] };

/** The repository a document belongs to, so `#12` can name its issues. */
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

/** `owner/repo#12`, `#12`, `@name` and commit hashes, in one pass. */
const REFERENCE =
  /(?<![\w/@#])(?:([a-z0-9][a-z0-9-]*\/[a-z0-9._-]+)#(\d+)|#(\d+)|@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})|([0-9a-f]{7,40}))(?![\w-])/gi;

function link(href: string, text: string, kind: string): Element {
  return {
    type: "element",
    tagName: "a",
    properties: { href, dataRef: kind },
    children: [{ type: "text", value: text }],
  };
}

/**
 * Links what a forge's text refers to: `#12` to an issue or pull request
 * in this repository (the issue page sends a pull request's number on to
 * it), `owner/repo#12` to one elsewhere, `@name` to a person or workspace,
 * and a commit hash to its commit. Nothing inside code or a link changes.
 */
export function rehypeReferences(options: { repo?: MarkdownRepo }) {
  const { repo } = options;
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
          const [whole, other, otherNumber, number, name, hash] = match;
          let replacement: Element | null = null;
          if (other && otherNumber) {
            replacement = link(`/${other}/issues/${otherNumber}`, whole, "issue");
          } else if (number && repo) {
            replacement = link(`/${repo.namespace}/${repo.name}/issues/${number}`, whole, "issue");
          } else if (name) {
            replacement = link(`/${name.toLowerCase()}`, whole, "mention");
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
