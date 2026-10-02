import { Link } from "react-router";

import type { BlobView as Blob, TreeView as Tree } from "@g1t/contracts";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function Breadcrumbs({
  base,
  repo,
  gitRef,
  path,
}: {
  base: string;
  repo: string;
  gitRef: string;
  path: string;
}) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  return (
    <p className="mb-4 font-mono text-sm text-muted">
      <Link to={`${base}/tree/${gitRef}`} className="hover:text-fg">
        {repo}
      </Link>
      {segments.map((segment, i) => {
        const to = encodePath(segments.slice(0, i + 1).join("/"));
        const last = i === segments.length - 1;
        return (
          <span key={to}>
            {" / "}
            {last ? (
              <span className="text-fg">{segment}</span>
            ) : (
              <Link to={`${base}/tree/${gitRef}/${to}`} className="hover:text-fg">
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </p>
  );
}

export function TreeView({ tree }: { tree: Tree }) {
  const { repo, ref, path, head, entries, readme } = tree;
  const base = `/${repo.namespace}/${repo.name}`;
  const prefix = path ? `${encodePath(path)}/` : "";
  const cloneUrl = `https://g1t.sh${base}.git`;

  if (!head) {
    return (
      <div className="mt-6 rounded-md border border-line bg-surface p-6">
        <p className="text-muted">This repository is empty. Push to it:</p>
        <pre className="mt-3 overflow-x-auto font-mono text-sm">
          git remote add origin {cloneUrl}
          {"\n"}git push -u origin {ref}
        </pre>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <Breadcrumbs base={base} repo={repo.name} gitRef={ref} path={path} />
      <div className="overflow-hidden rounded-md border border-line">
        <div className="flex items-baseline gap-3 border-b border-line bg-surface px-4 py-2 text-sm">
          <span className="font-mono text-accent">{ref}</span>
          <span className="truncate">{head.message.split("\n")[0]}</span>
          <span className="ml-auto shrink-0 font-mono text-muted">
            {head.author.name} · {head.hash.slice(0, 7)}
          </span>
        </div>
        <ul className="divide-y divide-line font-mono text-sm">
          {entries.map((entry) => {
            const isTree = entry.kind === "tree";
            const kind = isTree ? "tree" : "blob";
            return (
              <li key={entry.name}>
                <Link
                  to={`${base}/${kind}/${ref}/${prefix}${encodeURIComponent(entry.name)}`}
                  className="block px-4 py-1.5 hover:bg-surface"
                >
                  {entry.name}
                  {isTree && <span className="text-muted">/</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      {!path && (
        <pre className="mt-4 overflow-x-auto rounded-md border border-line bg-surface px-4 py-2 font-mono text-sm">
          git clone {cloneUrl}
        </pre>
      )}

      {readme?.text != null && (
        <section className="mt-6 rounded-md border border-line">
          <h2 className="border-b border-line bg-surface px-4 py-2 font-mono text-sm text-muted">
            {readme.name}
          </h2>
          <pre className="whitespace-pre-wrap p-4 text-sm">{readme.text}</pre>
        </section>
      )}
    </div>
  );
}

export function BlobView({ blob }: { blob: Blob }) {
  const { repo, ref, path, size, text } = blob;
  const lines = text?.replace(/\n$/, "").split("\n");
  return (
    <div className="mt-6">
      <Breadcrumbs
        base={`/${repo.namespace}/${repo.name}`}
        repo={repo.name}
        gitRef={ref}
        path={path}
      />
      <div className="overflow-hidden rounded-md border border-line">
        <div className="border-b border-line bg-surface px-4 py-2 font-mono text-sm text-muted">
          {size.toLocaleString("en-US")} bytes
        </div>
        {lines ? (
          <div className="flex overflow-x-auto font-mono text-sm leading-6">
            <pre
              aria-hidden="true"
              className="select-none px-4 py-3 text-right text-muted"
            >
              {lines.map((_, i) => i + 1).join("\n")}
            </pre>
            <pre className="py-3 pr-4">{lines.join("\n")}</pre>
          </div>
        ) : (
          <p className="p-4 text-sm text-muted">
            Binary or large file not shown.
          </p>
        )}
      </div>
    </div>
  );
}
