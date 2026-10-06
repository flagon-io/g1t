import { BookOpen, File, Folder, FolderGit2 } from "lucide-react";
import { Link } from "react-router";

import type { Blame, BlobView as Blob, Commit, TreeView as Tree } from "@g1t/contracts";

import { BlameView } from "./blame-view";

import { AgentSetup } from "./agent-setup";
import { CloneBox } from "./clone-box";
import { Markdown } from "./markdown";
import { Avatar, CopyLine, TimeAgo } from "./ui";

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
      <Link to={`${base}/tree/${gitRef}`} className="text-accent hover:underline">
        {repo}
      </Link>
      {segments.map((segment, i) => {
        const to = encodePath(segments.slice(0, i + 1).join("/"));
        const last = i === segments.length - 1;
        return (
          <span key={to}>
            <span className="mx-1.5 text-faint">/</span>
            {last ? (
              <span className="font-medium text-fg">{segment}</span>
            ) : (
              <Link
                to={`${base}/tree/${gitRef}/${to}`}
                className="text-accent hover:underline"
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </p>
  );
}

/** The bar above a file listing describing the latest commit. */
function CommitBar({ commit, gitRef }: { commit: Commit; gitRef: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 text-sm">
      <Avatar name={commit.author.name} />
      <span className="shrink-0 font-medium">{commit.author.name}</span>
      <span className="truncate text-muted">{commit.message.split("\n")[0]}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-faint">
        <span className="rounded-full border border-line px-2 py-0.5 font-mono text-accent">
          {gitRef}
        </span>
        <span className="font-mono">{commit.hash.slice(0, 7)}</span>
        <TimeAgo at={commit.authoredAt} />
      </span>
    </div>
  );
}

export function TreeView({ tree }: { tree: Tree }) {
  const { repo, ref, path, head, entries, readme } = tree;
  const base = `/${repo.namespace}/${repo.name}`;
  const prefix = path ? `${encodePath(path)}/` : "";
  const cloneUrl = `https://g1t.sh${base}.git`;

  if (!head) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-line bg-surface p-8">
        <h2 className="text-lg font-semibold tracking-tight">
          This repository is empty
        </h2>
        <p className="mt-1 text-sm text-muted">
          Push an existing project to it. Use an access token as the password.
        </p>
        <div className="mt-5 space-y-2">
          <CopyLine prompt text={`git remote add g1t ${cloneUrl}`} />
          <CopyLine prompt text={`git push -u g1t ${ref}`} />
        </div>
        <h3 className="mt-7 text-sm font-medium">Or have your coding agent start it</h3>
        <p className="mt-1 text-sm text-muted">
          Connect it to g1t, then ask it to build the first version of{" "}
          <span className="font-mono text-fg">{repo.name}</span> and push it here.
        </p>
        <AgentSetup className="mt-3" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0">
        <Breadcrumbs base={base} repo={repo.name} gitRef={ref} path={path} />
        <div className="overflow-hidden rounded-xl border border-line">
          <CommitBar commit={head} gitRef={ref} />
          <ul className="divide-y divide-line text-sm">
            {entries.map((entry) => {
              const isTree = entry.kind === "tree";
              const Icon = isTree ? Folder : entry.kind === "gitlink" ? FolderGit2 : File;
              return (
                <li key={entry.name}>
                  <Link
                    to={`${base}/${isTree ? "tree" : "blob"}/${ref}/${prefix}${encodeURIComponent(entry.name)}`}
                    className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-surface"
                  >
                    <Icon
                      size={15}
                      className={isTree ? "text-accent-dim" : "text-faint"}
                    />
                    <span className="font-mono text-[0.8125rem]">{entry.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {readme?.text != null && (
          <section className="mt-6 overflow-hidden rounded-xl border border-line">
            <h2 className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5 text-sm font-medium">
              <BookOpen size={15} className="text-faint" />
              {readme.name}
            </h2>
            <div className="p-6">
              {/\.(md|markdown)$/i.test(readme.name) ? (
                <Markdown
                  source={readme.text}
                  repo={{ namespace: repo.namespace, name: repo.name }}
                  // Relative links in a README point into the repository.
                  base={`/${repo.namespace}/${repo.name}/blob/${ref}${path ? `/${path}` : ""}`}
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm"><code>{readme.text}</code></pre>
              )}
            </div>
          </section>
        )}
      </div>

      {!path && (
        <aside className="space-y-6">
          <section>
            <h2 className="text-sm font-medium">Clone</h2>
            <div className="mt-2">
              <CloneBox path={`${repo.namespace}/${repo.name}`} />
            </div>
          </section>
          <section>
            <h2 className="text-sm font-medium">About</h2>
            <p className="mt-2 text-sm text-muted">
              {repo.description ?? "No description."}
            </p>
            <p className="mt-3 text-xs text-faint">
              Created <TimeAgo at={repo.createdAt} />
            </p>
          </section>
        </aside>
      )}
    </div>
  );
}

export function BlobView({
  blob,
  html,
  blame,
}: {
  blob: Blob;
  /** Syntax-highlighted HTML, when the language is known. */
  html: string | null;
  /** Shown instead of the plain file when asked for, with HTML per line. */
  blame?: { blame: Blame; lines: string[] | null } | null;
}) {
  const { repo, ref, path, size, text } = blob;
  const lines = text?.replace(/\n$/, "").split("\n");
  const base = `/${repo.namespace}/${repo.name}`;
  const toggle = (label: string, on: boolean, search: string) => (
    <Link
      to={{ search }}
      preventScrollReset
      className={`rounded px-2 py-0.5 transition-colors ${on ? "bg-raised text-fg" : "hover:text-fg"}`}
    >
      {label}
    </Link>
  );
  return (
    <div>
      <Breadcrumbs
        base={`/${repo.namespace}/${repo.name}`}
        repo={repo.name}
        gitRef={ref}
        path={path}
      />
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 text-xs text-muted">
          {lines && <span>{lines.length.toLocaleString("en-US")} lines</span>}
          <span>{size.toLocaleString("en-US")} bytes</span>
          {lines && (
            <span className="ml-auto flex rounded-md border border-line p-0.5">
              {toggle("Code", !blame, "")}
              {toggle("Blame", Boolean(blame), "?blame=1")}
            </span>
          )}
        </div>
        {blame && lines ? (
          <BlameView base={base} path={path} lines={lines} html={blame.lines} blame={blame.blame} />
        ) : html ? (
          <div
            className="overflow-x-auto py-3 pr-4"
            // Shiki escapes the source; this is its generated markup.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : lines ? (
          <div className="flex overflow-x-auto py-3 font-mono text-sm leading-6">
            <pre
              aria-hidden="true"
              className="w-10 shrink-0 text-right text-faint select-none"
            >
              {lines.map((_, i) => i + 1).join("\n")}
            </pre>
            <pre className="pr-4 pl-5"><code>{lines.join("\n")}</code></pre>
          </div>
        ) : (
          <p className="p-6 text-sm text-muted">
            This file is binary or too large to show.
          </p>
        )}
      </div>
    </div>
  );
}
