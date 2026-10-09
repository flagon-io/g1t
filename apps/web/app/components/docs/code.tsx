/**
 * Docs and code: citing code in a page (the Cite code dialog), the
 * header's "Describes" list, the banner on a page possibly out of date,
 * and showing a project's docs folder in Docs. Plan: docs/WORKSPACE.md,
 * "Agents and docs" and "Docs and repository docs".
 */
import { DOC_CITATION_KIND_LABELS, type DocCitationKind, type DocDescribes, type DocRepoSpace, type DocStaleness } from "@g1t/contracts";
import { AlertTriangle, Check, FileCode2, FolderGit2, GitCommitHorizontal, GitPullRequest, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { citationHref } from "../../lib/docs";
import { Button, ErrorText, Field, Input, TimeAgo } from "../ui";
import { Combobox } from "../ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Hint } from "../ui/hint";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { SelectField } from "../ui/select";
import { docsQuery, docsRequest } from "./actions";

export type RepoChoice = { repo: string; default_branch: string; private: boolean };

/** The workspace's repositories the viewer can read, asked for once the dialog that needs them opens. */
export function useRepoChoices(slug: string, wanted: boolean): { repos: RepoChoice[] | null; error: string | null } {
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted || repos) return;
    let cancelled = false;
    void docsQuery<RepoChoice[]>(slug, { repos: "1" }).then((r) => {
      if (cancelled) return;
      if (r.ok) setRepos(r.value);
      else setError(r.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, wanted, repos]);
  return { repos, error };
}

function RepoPicker({ repos, value, onChange, id }: { repos: RepoChoice[] | null; value: string; onChange: (repo: string) => void; id?: string }) {
  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onChange}
      placeholder={repos ? "Choose a repository" : "Loading repositories…"}
      searchPlaceholder="Find a repository"
      emptyText="No repository you can read matches."
      disabled={!repos}
      options={(repos ?? []).map((r) => ({ value: r.repo, label: r.repo, description: r.private ? "Private" : undefined, icon: <FolderGit2 size={14} /> }))}
      className="w-full"
    />
  );
}

/** What the Cite code dialog inserts: a citation chip's attributes. */
export type CitationInput = { repo: string; path: string; kind: DocCitationKind; label: string; ref: string };

const LABEL_HINTS: Record<DocCitationKind, string> = {
  path: "",
  symbol: "The function, type or class, e.g. exportCsv",
  endpoint: "The method and route, e.g. POST /v1/exports",
  env: "The variable's name, e.g. EXPORT_BUCKET",
};

/**
 * Cite code: a repository, a path in it (a file, a folder, or a pattern
 * like `src/export/**`), and what there the page describes. The citation
 * is pinned to the default branch's head, and the page is marked possibly
 * out of date when a merge changes it.
 */
export function CiteDialog({ slug, open, onOpenChange, onCite, projects = [] }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void; onCite: (c: CitationInput) => void; projects?: string[] }) {
  const { repos, error: loadError } = useRepoChoices(slug, open);
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  const [kind, setKind] = useState<DocCitationKind>("path");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPath("");
    setLabel("");
    setKind("path");
  }, [open]);
  // The page's own project first, when it has one.
  useEffect(() => {
    if (!repo && repos?.length) setRepo(repos.find((r) => projects.includes(r.repo))?.repo ?? repos[0]!.repo);
  }, [repos, repo, projects]);
  const submit = async () => {
    if (!repo || !path.trim()) return setError("Choose a repository and name a path in it.");
    if (kind !== "path" && !label.trim()) return setError(`Name the ${kind === "env" ? "variable" : kind}.`);
    setBusy(true);
    setError(null);
    const found = await docsQuery<{ repo: string; path: string; ref: string | null }>(slug, { cite: repo, path: path.trim() });
    setBusy(false);
    if (!found.ok) return setError(found.error.message);
    onCite({ repo: found.value.repo, path: found.value.path, kind, label: kind === "path" ? "" : label.trim(), ref: found.value.ref ?? "" });
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileCode2 size={16} /> Cite code
          </DialogTitle>
          <DialogDescription>Link this page to the code it describes. When a merged pull request changes it, the page&apos;s owners hear that it may be out of date.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Repository">
            <RepoPicker repos={repos} value={repo} onChange={setRepo} />
          </Field>
          <Field label="Path" hint="A file, a folder (everything in it), or a pattern such as src/export/** or *.sql.">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/export.ts" autoComplete="off" spellCheck={false} className="font-mono" />
          </Field>
          <Field label="What it describes">
            <SelectField value={kind} onValueChange={(v) => setKind(v as DocCitationKind)} options={(Object.keys(DOC_CITATION_KIND_LABELS) as DocCitationKind[]).map((k) => ({ value: k, label: DOC_CITATION_KIND_LABELS[k] }))} className="w-full" aria-label="What it describes" />
          </Field>
          {kind !== "path" && (
            <Field label={kind === "symbol" ? "Symbol" : kind === "endpoint" ? "Endpoint" : "Variable"} hint={LABEL_HINTS[kind]}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
            </Field>
          )}
          {(error || loadError) && <ErrorText>{error ?? loadError}</ErrorText>}
          <DialogFooter>
            <Button type="submit" variant="accent" disabled={busy || !repos}>
              {busy ? "Checking…" : "Cite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The header's "Describes": which code the page is about, editable by anyone who can edit it. */
export function Describes({ slug, describes, editable, onSave }: { slug: string; describes: DocDescribes[]; editable: boolean; onSave: (next: DocDescribes[]) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const { repos } = useRepoChoices(slug, open);
  const [repo, setRepo] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    if (!repo && repos?.length) setRepo(describes[0]?.repo ?? repos[0]!.repo);
  }, [repos, repo, describes]);
  if (!describes.length && !editable) return null;
  const add = async () => {
    const clean = path.trim().replace(/^\/+|\/+$/g, "");
    if (!repo || !clean) return;
    await onSave([...describes, { repo, path: clean }]);
    setPath("");
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span>Describes</span>
      {describes.map((d) => (
        <Link key={`${d.repo}:${d.path}`} to={citationHref({ repo: d.repo, path: d.path, ref: null })} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[0.6875rem] text-muted hover:border-line-strong hover:text-fg">
          <FileCode2 size={11} aria-hidden="true" />
          {d.repo}:{d.path}
        </Link>
      ))}
      {editable && (
        <Popover open={open} onOpenChange={setOpen}>
          <Hint label={describes.length ? "Change what this page describes" : "Say which code this page describes"}>
            <PopoverTrigger asChild>
              <button type="button" aria-label="Edit what this page describes" className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-line text-faint hover:border-line-strong hover:text-fg">
                <Plus size={11} />
              </button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent align="start" className="w-96 p-4 text-sm">
            <p className="font-medium">Code this page describes</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">When a merged pull request changes any of it, the page is marked possibly out of date and its owners are told.</p>
            {describes.length > 0 && (
              <ul className="mt-3 space-y-1">
                {describes.map((d, i) => (
                  <li key={`${d.repo}:${d.path}`} className="flex items-center gap-2 rounded-md bg-raised px-2 py-1 font-mono text-xs">
                    <span className="min-w-0 grow truncate">
                      {d.repo}:{d.path}
                    </span>
                    <button type="button" aria-label={`Remove ${d.repo}:${d.path}`} onClick={() => void onSave(describes.filter((_, j) => j !== i))} className="text-faint hover:text-danger">
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-3 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <RepoPicker repos={repos} value={repo} onChange={setRepo} />
              <div className="flex gap-2">
                <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="src/export or src/**/*.sql" aria-label="Path" autoComplete="off" spellCheck={false} className="font-mono" />
                <Button type="submit" variant="quiet" disabled={!repo || !path.trim()}>
                  Add
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

function changeLink(c: DocStaleness["changes"][number]): { href: string; label: string } | null {
  if (!c.visible || !c.repo) return null;
  if (c.pull) return { href: `/${c.repo}/pull/${c.pull.number}`, label: `${c.repo}#${c.pull.number}` };
  if (c.commit) return { href: `/${c.repo}/commit/${c.commit}`, label: `${c.repo}@${c.commit.slice(0, 7)}` };
  return null;
}

/**
 * "Possibly out of date since acme/web#431 changed src/export.ts":
 * the newest change the reader can see, the rest counted; Review changes
 * opens it; Mark as current clears it for everyone.
 */
export function StaleBanner({ staleness, canMark, onMark }: { staleness: DocStaleness; canMark: boolean; onMark: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const latest = staleness.changes[0];
  if (!latest) return null;
  const link = changeLink(latest);
  const more = staleness.changes.length - 1;
  return (
    <div role="status" className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warn/30 bg-warn/8 px-3 py-2 text-sm">
      <AlertTriangle size={15} className="shrink-0 text-warn" aria-hidden="true" />
      <span className="min-w-0 grow text-fg-soft">
        Possibly out of date since{" "}
        {link ? (
          <>
            <Link to={link.href} className="font-medium text-fg hover:underline">
              {link.label}
            </Link>
            {latest.paths.length > 0 && (
              <>
                {" "}
                changed <span className="font-mono text-[0.8125rem] text-fg">{latest.paths[0]}</span>
                {latest.paths.length > 1 && ` and ${latest.paths.length - 1} more`}
              </>
            )}
          </>
        ) : (
          "a change you can't see touched code it cites"
        )}
        {more > 0 && <span className="text-muted"> · {more === 1 ? "1 more change" : `${more} more changes`}</span>}
        <span className="text-faint">
          {" "}
          · <TimeAgo at={latest.at} />
        </span>
      </span>
      {link && (
        <Link to={latest.pull ? `${link.href}?tab=changes` : link.href} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg hover:bg-raised">
          {latest.pull ? <GitPullRequest size={13} /> : <GitCommitHorizontal size={13} />} Review changes
        </Link>
      )}
      {canMark && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onMark();
            setBusy(false);
          }}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-warn/15 px-2.5 text-xs font-medium text-warn hover:bg-warn/25 disabled:opacity-60"
        >
          <Check size={13} /> {busy ? "Marking…" : "Mark as current"}
        </button>
      )}
    </div>
  );
}

/** Show a project's docs: choose a repository the viewer can read; its `docs/` folder and README appear in the sidebar and search. */
export function RepoDocsDialog({ slug, open, onOpenChange, shown, onAdded }: { slug: string; open: boolean; onOpenChange: (open: boolean) => void; shown: string[]; onAdded: (space: DocRepoSpace) => void }) {
  const { repos, error: loadError } = useRepoChoices(slug, open);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = repos?.filter((r) => !shown.includes(r.repo)) ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 size={16} /> Show a project&apos;s docs
          </DialogTitle>
          <DialogDescription>The repository&apos;s docs folder and README, read from its default branch, appear beside your spaces and in search, and follow every push. Only people who can read the repository see them. Changes go through the repository.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!repo) return;
            setBusy(true);
            setError(null);
            const added = await docsRequest<DocRepoSpace>(slug, "add_repo_space", { repo });
            setBusy(false);
            if (!added.ok) return setError(added.error.message);
            onAdded(added.value);
            onOpenChange(false);
          }}
        >
          <Field label="Repository">
            <RepoPicker repos={choices} value={repo} onChange={setRepo} />
          </Field>
          {choices && choices.length === 0 && <p className="text-xs text-faint">Every repository you can read is already shown.</p>}
          {(error || loadError) && <ErrorText>{error ?? loadError}</ErrorText>}
          <DialogFooter>
            <Button type="submit" variant="accent" disabled={busy || !repo}>
              {busy ? "Reading its docs…" : "Show its docs"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
