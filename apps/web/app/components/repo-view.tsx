import { BookOpen, Check, ChevronDown, Code2, File, FileArchive, Folder, FolderGit2, GitBranch, History, Search, SquareTerminal, Tag as TagIcon } from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Await, Form, Link } from "react-router";

import type { BlobView as Blob, Branch, TreeView as RawTree } from "@g1t/contracts";

import type { FileCommits, ShownBlame, ShownCommit } from "../lib/commit-people";
import { CommitAvatars, CommitNames } from "./commit-person";

import type { DeploymentEnvironments } from "@g1t/contracts";

import { BlameView } from "./blame-view";
import { DeploymentsPanel } from "./deployments-panel";
import { CodeLines } from "./code-lines";

import { AgentSetup } from "./agent-setup";
import { useAddresses } from "../lib/addresses";
import { isImagePath } from "../lib/usercontent";
import { CloneBox } from "./clone-box";
import { type ChecksSource, CommitChecksBadge } from "./commit-checks";
import { type AboutData, RepoAboutPanel } from "./repo-about";
import { Markdown } from "./markdown";
import { CopyLine, TimeAgo, notACredential } from "./ui";
import { Card } from "./ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Hint } from "./ui/hint";
import { SkeletonLine } from "./ui/skeleton";

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
  // On a phone, one line: the folders between the repository and the last
  // two fold into an ellipsis that opens the deepest of them.
  const folded = segments.length - 2;
  const slash = <span className="mx-1.5 shrink-0 text-faint">/</span>;
  return (
    <nav aria-label="Path" className="flex min-w-0 basis-full items-center font-mono text-sm whitespace-nowrap text-muted sm:basis-auto sm:flex-wrap sm:whitespace-normal">
      <Link to={`${base}/tree/${gitRef}`} className="shrink-0 py-2 text-accent hover:underline sm:py-0">
        {repo}
      </Link>
      {folded > 0 && (
        <span className="flex shrink-0 items-center sm:hidden">
          {slash}
          <Link
            to={`${base}/tree/${gitRef}/${encodePath(segments.slice(0, folded).join("/"))}`}
            aria-label={`Up to ${segments.slice(0, folded).join("/")}`}
            className="rounded px-1 py-2 text-accent hover:underline"
          >
            …
          </Link>
        </span>
      )}
      {segments.map((segment, i) => {
        const to = encodePath(segments.slice(0, i + 1).join("/"));
        const last = i === segments.length - 1;
        return (
          <span
            key={to}
            className={`${i < folded ? "hidden sm:flex" : "flex"} items-center ${last ? "min-w-0" : i === segments.length - 2 ? "min-w-0 shrink-[2]" : "shrink-0"}`}
          >
            {slash}
            {last ? (
              <span className="truncate font-medium text-fg">{segment}</span>
            ) : (
              <Link
                to={`${base}/tree/${gitRef}/${to}`}
                className="truncate py-2 text-accent hover:underline sm:py-0"
              >
                {segment}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/** The bar above a file listing: the latest commit, its checks, and the way to the history. */
/** A tree as the page gets it: its latest commit with its people. */
export type Tree = Omit<RawTree, "head"> & { head: ShownCommit | null };

function CommitBar({ commit, base, checks }: { commit: ShownCommit; base: string; checks?: ChecksSource }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line bg-surface px-3 py-2.5 text-sm sm:gap-3 sm:px-4">
      <CommitAvatars commit={commit} />
      <span className="shrink-0 font-medium">
        <CommitNames commit={commit} />
      </span>
      <Link to={`${base}/commit/${commit.hash}`} className="truncate text-muted hover:text-fg hover:underline">
        {commit.message.split("\n")[0]}
      </Link>
      <CommitChecksBadge checks={checks} sha={commit.hash} className="-ml-1.5" />
      <span className="ml-auto flex shrink-0 items-center gap-3 text-xs text-faint sm:gap-4">
        <Link to={`${base}/commit/${commit.hash}`} className="hidden font-mono hover:text-fg sm:inline">
          {commit.hash.slice(0, 7)}
        </Link>
        <span className="hidden sm:inline">
          <TimeAgo at={commit.authoredAt} />
        </span>
        <Link to={`${base}/commits`} aria-label="History" className="-my-2 inline-flex items-center gap-1.5 py-2 font-medium text-muted hover:text-fg">
          <History size={14} />
          <span className="hidden sm:inline">History</span>
        </Link>
      </span>
    </div>
  );
}

const BAR_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm transition-colors hover:border-line-strong hover:bg-raised data-[state=open]:border-line-strong";

/** Which branch is shown, and the others to switch to, at the same path. */
function BranchMenu({
  base,
  gitRef,
  path,
  branches,
  view = "tree",
}: {
  base: string;
  gitRef: string;
  path: string;
  branches: Branch[];
  /** Whether `path` is a folder or a file. */
  view?: "tree" | "blob";
}) {
  const rest = path ? `/${encodePath(path)}` : "";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={`${BAR_BUTTON} max-w-56 font-medium`}>
        <GitBranch size={14} className="text-faint" />
        <span className="truncate font-mono text-[0.8125rem]">{gitRef}</span>
        <ChevronDown size={13} className="text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
        <DropdownMenuLabel>Switch branches</DropdownMenuLabel>
        {branches.map((branch) => (
          <DropdownMenuItem key={branch.name} asChild>
            <Link to={`${base}/${view}/${encodePath(branch.name)}${rest}`}>
              <Check className={branch.name === gitRef ? "" : "invisible"} />
              <span className="truncate font-mono text-[0.8125rem]">{branch.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Searches this repository's code on the search page, where it can be widened to all of g1t. */
function SearchCode({ repo }: { repo: string }) {
  return (
    <Form action="/search" role="search" className="relative ml-auto min-w-0 flex-1 basis-40 sm:w-64 sm:flex-none sm:basis-auto">
      <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
      <input
        name="q"
        {...notACredential()}
        placeholder="Search code"
        aria-label={`Search ${repo}`}
        className="h-9 w-full rounded-md border border-line bg-surface pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim sm:h-8"
      />
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="type" value="code" />
    </Form>
  );
}

/** The one button for getting the code: clone over HTTPS or SSH, hand it to an agent, or download it. */
function CodeButton({ path, gitRef }: { path: string; gitRef: string }) {
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent/90">
        <Code2 size={15} />
        Code
        <ChevronDown size={13} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <SquareTerminal size={15} className="text-faint" />
            Clone
          </h2>
          <CloneBox path={path} />
        </div>
        <div className="border-t border-line p-1.5">
          {/* A plain link: the browser downloads it, not the router. */}
          <a
            href={`/${path}/archive/${encodePath(gitRef)}.zip`}
            download
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-fg/90 transition-colors hover:bg-line hover:text-fg"
          >
            <FileArchive size={15} className="text-faint" />
            Download ZIP
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Above the files: the branch and, at the root, how many there are, search and Code; below it, where you are. */
function CodeBar({
  base,
  repo,
  gitRef,
  path,
  branches,
}: {
  base: string;
  repo: { namespace: string; name: string };
  gitRef: string;
  path: string;
  branches: Branch[] | null;
}) {
  const full = `${repo.namespace}/${repo.name}`;
  const list = branches && branches.length > 0 ? branches : [{ name: gitRef, hash: "" }];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <BranchMenu base={base} gitRef={gitRef} path={path} branches={list} />
      {path ? (
        <Breadcrumbs base={base} repo={repo.name} gitRef={gitRef} path={path} />
      ) : (
        <>
          {branches && (
            <Link to={`${base}/branches`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent">
              <GitBranch size={14} className="text-faint" />
              <span className="font-medium text-fg">{branches.length}</span>
              {branches.length === 1 ? "branch" : "branches"}
            </Link>
          )}
          <Link to={`${base}/tags`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent">
            <TagIcon size={14} className="text-faint" />
            Tags
          </Link>
          <SearchCode repo={full} />
          <CodeButton path={full} gitRef={gitRef} />
        </>
      )}
    </div>
  );
}

/**
 * The files of a directory, each with the commit that last changed it.
 * `last` is undefined while those are still being read (the column holds
 * its place), and null when they could not be.
 */
function FileRows({
  base,
  gitRef,
  prefix,
  entries,
  last,
}: {
  base: string;
  gitRef: string;
  prefix: string;
  entries: Tree["entries"];
  last: FileCommits | null | undefined;
}) {
  const byName = new Map((last?.entries ?? []).map((entry) => [entry.name, entry.commit]));
  return (
    // Busy while each entry's last commit is on its way; its cells keep their size.
    <ul aria-busy={last === undefined || undefined} className="divide-y divide-line text-sm">
      {entries.map((entry) => {
        const isTree = entry.kind === "tree";
        const Icon = isTree ? Folder : entry.kind === "gitlink" ? FolderGit2 : File;
        const commit = byName.get(entry.name);
        return (
          <li key={entry.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 transition-colors hover:bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_auto]">
            {/* The whole row's height is the link's: a 44px target on a phone. */}
            <Link
              to={`${base}/${isTree ? "tree" : "blob"}/${gitRef}/${prefix}${encodeURIComponent(entry.name)}`}
              className="flex min-h-11 min-w-0 items-center gap-3 py-2 hover:text-accent hover:underline sm:min-h-0"
            >
              <Icon size={15} className={`shrink-0 ${isTree ? "text-accent-dim" : "text-faint"}`} />
              <span className="truncate font-mono text-[0.8125rem]">{entry.name}</span>
            </Link>
            <span className="hidden min-w-0 sm:block">
              {commit ? (
                <Hint label={commit.message.split("\n")[0]}>
                  <Link to={`${base}/commit/${commit.hash}`} className="block animate-fade-in truncate text-muted hover:text-fg hover:underline">
                    {commit.message.split("\n")[0]}
                  </Link>
                </Hint>
              ) : last === undefined ? (
                <SkeletonLine width="10rem" barClassName="max-w-full" />
              ) : null}
            </span>
            <span className="text-right text-xs whitespace-nowrap text-faint">
              {commit ? <span className="animate-fade-in"><TimeAgo at={commit.authoredAt} /></span> : last === undefined ? <SkeletonLine className="justify-end" barClassName="w-12" /> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TreeView({
  tree,
  branches = null,
  lastCommits = null,
  checks = null,
  about = null,
  canPush = false,
  homepage = null,
  deployments = null,
}: {
  tree: Tree;
  branches?: Branch[] | null;
  /** Each entry's last commit, streamed in after the list. */
  lastCommits?: Promise<FileCommits | null> | null;
  /** The latest commit's checks, streamed in. */
  checks?: ChecksSource;
  /** The About beside the files, at the root: streamed in after them. */
  about?: AboutData | null;
  /** Whether the viewer may push, for the About's "Create a new release". */
  canPush?: boolean;
  /** The project's homepage; the repository's website when null. */
  homepage?: string | null;
  /** The repository's environments, for the About's Deployments section. */
  deployments?: DeploymentEnvironments | null;
}) {
  const { repo, ref, path, head, entries, readme } = tree;
  const base = `/${repo.namespace}/${repo.name}`;
  const prefix = path ? `${encodePath(path)}/` : "";
  const cloneUrl = `${useAddresses().site}${base}.git`;

  if (!head) {
    return (
      <Card className="mx-auto max-w-2xl p-8">
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
      </Card>
    );
  }

  return (
    <div className={path ? "" : "grid gap-8 lg:grid-cols-[1fr_17rem]"}>
      <div className="min-w-0">
        <CodeBar base={base} repo={repo} gitRef={ref} path={path} branches={branches} />
        <Card tone="plain" className="overflow-hidden">
          <CommitBar commit={head} base={base} checks={checks} />
          {lastCommits ? (
            <Suspense fallback={<FileRows base={base} gitRef={ref} prefix={prefix} entries={entries} last={undefined} />}>
              <Await resolve={lastCommits} errorElement={<FileRows base={base} gitRef={ref} prefix={prefix} entries={entries} last={null} />}>
                {(last) => <FileRows base={base} gitRef={ref} prefix={prefix} entries={entries} last={last} />}
              </Await>
            </Suspense>
          ) : (
            <FileRows base={base} gitRef={ref} prefix={prefix} entries={entries} last={null} />
          )}
        </Card>

        {readme?.text != null && (
          <Card asChild tone="plain" className="mt-6 scroll-mt-20 overflow-hidden">
            <section id="readme">
              <h2 className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5 text-sm font-medium">
                <BookOpen size={15} className="text-faint" />
                {readme.name}
              </h2>
              <div className="p-4 sm:p-6">
                {/\.(md|markdown)$/i.test(readme.name) ? (
                  <Markdown
                    source={readme.text}
                    repo={{ namespace: repo.namespace, name: repo.name }}
                    // Relative links in a README point into the repository,
                    // and its pictures at the files of the commit shown.
                    base={`/${repo.namespace}/${repo.name}/blob/${ref}${path ? `/${path}` : ""}`}
                    rawBase={`/${repo.namespace}/${repo.name}/raw/${head.hash}${path ? `/${encodePath(path)}` : ""}`}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap text-sm"><code>{readme.text}</code></pre>
                )}
              </div>
            </section>
          </Card>
        )}
      </div>

      {!path && (
        <RepoAboutPanel
          repo={repo}
          gitRef={ref}
          readme={Boolean(readme)}
          data={about ?? { about: null, watchers: null, packages: null }}
          canPush={canPush}
          homepage={homepage}
          deployments={<DeploymentsPanel base={base} summary={deployments} className="border-t border-line pt-4" />}
        />
      )}
    </div>
  );
}

export function BlobView({
  blob,
  html,
  blame,
  branches = null,
  notice,
  marked,
}: {
  /** For the branch menu; it shows the current branch alone without them. */
  branches?: Branch[] | null;
  /** Said above the file, such as what is wrong with it. */
  notice?: ReactNode;
  /** Lines to mark as having a problem, 1-based. */
  marked?: readonly number[];
  blob: Blob;
  /** Syntax-highlighted HTML per line, when the language is known. */
  html: string[] | null;
  /** Shown instead of the plain file when asked for, with HTML per line. */
  blame?: { blame: ShownBlame; lines: string[] | null } | null;
}) {
  const { repo, ref, path, size, text } = blob;
  const lines = text?.replace(/\n$/, "").split("\n");
  const base = `/${repo.namespace}/${repo.name}`;
  // The file as it is, on the usercontent origin (routes/repo/raw.ts).
  const raw = `${base}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`;
  const toggle = (label: string, on: boolean, search: string) => (
    <Link
      to={{ search }}
      preventScrollReset
      className={`rounded px-2.5 py-1.5 transition-colors sm:px-2 sm:py-0.5 ${on ? "bg-raised text-fg" : "hover:text-fg"}`}
    >
      {label}
    </Link>
  );
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <BranchMenu
          base={base}
          gitRef={ref}
          path={path}
          branches={branches && branches.length > 0 ? branches : [{ name: ref, hash: "" }]}
          view="blob"
        />
        <Breadcrumbs base={base} repo={repo.name} gitRef={ref} path={path} />
      </div>
      {notice}
      <Card tone="plain" className="overflow-hidden">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-3 py-2 text-xs text-muted sm:px-4 sm:py-2.5">
          {lines && <span>{lines.length.toLocaleString("en-US")} lines</span>}
          <span className="hidden min-[400px]:inline">{size.toLocaleString("en-US")} bytes</span>
          <span className="ml-auto flex items-center gap-2">
            {lines && (
              <span className="flex rounded-md border border-line p-0.5">
                {toggle("Code", !blame, "")}
                {toggle("Blame", Boolean(blame), "?blame=1")}
              </span>
            )}
            <a href={raw} className="rounded-md border border-line px-2.5 py-2 transition-colors hover:text-fg sm:px-2 sm:py-1">
              Raw
            </a>
          </span>
        </div>
        {blame && lines ? (
          <BlameView base={base} path={path} lines={lines} html={blame.lines} blame={blame.blame} />
        ) : lines ? (
          <CodeLines lines={lines} html={html} marked={marked} />
        ) : isImagePath(path) ? (
          <div className="flex justify-center bg-[repeating-conic-gradient(var(--color-raised)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-6">
            <img src={raw} alt={path.split("/").pop() ?? path} className="max-h-[70vh] max-w-full" />
          </div>
        ) : (
          <p className="p-6 text-sm text-muted">
            This file is binary or too large to show.{" "}
            <a href={raw} className="text-accent hover:underline">
              View it raw
            </a>
            .
          </p>
        )}
      </Card>
    </div>
  );
}
