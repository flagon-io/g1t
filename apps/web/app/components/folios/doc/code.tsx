/**
 * Docs and code: citing code in a doc (the Cite code dialog), and showing
 * a project's docs folder in Artifacts.
 */
import { DOC_CITATION_KIND_LABELS, type DocCitationKind, type DocRepoSpace } from "@g1t/contracts";
import { FileCode2, FolderGit2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, ErrorText, Field, Input } from "../../ui";
import { Combobox } from "../../ui/combobox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { SelectField } from "../../ui/select";
import { foliosQuery as docsQuery, foliosRequest as docsRequest } from "../actions";

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
 * like `src/export/**`), and what there the doc describes. The citation
 * is pinned to the default branch's head, and the doc is marked possibly
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
  // The doc's own project first, when it has one.
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
          <DialogDescription>Link this doc to the code it describes. When a merged pull request changes it, the doc&apos;s owner hears that it may be out of date.</DialogDescription>
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
