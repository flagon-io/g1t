/**
 * A repository's or a workspace's secrets and variables, as one list in the
 * way Vercel lists environment variables: each row is a key, its type
 * (Secret or Config), the environments it applies to and who reads it.
 * Adding and editing happen in a side panel, opened by `?add` or
 * `?edit=<id>` so the page works without scripts.
 */
import { Lock, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";

import type { Setting } from "@g1t/contracts";

import type { SecretsAction, SecretsData } from "../lib/secrets.server";
import { Button, ButtonLink, EmptyState, ErrorText, TimeAgo } from "./ui";

/** The environments every deployment knows; workflow jobs may name others. */
const KNOWN_ENVIRONMENTS = ["production", "preview"];

const READERS: Record<string, string> = { workflows: "Workflows", deployments: "Deployments" };

function environmentsLabel(environments: string[]): string {
  if (environments.length === 0) return "All environments";
  return environments.map((env) => env.charAt(0).toUpperCase() + env.slice(1)).join(", ");
}

const SELECT =
  "rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors hover:border-line-strong focus:border-accent-dim";

export function SecretsPanel({
  data,
  action,
  scope,
  manage,
}: {
  data: SecretsData;
  action: SecretsAction | undefined;
  scope: "repository" | "workspace";
  manage: boolean;
}) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const editing = params.get("edit");
  const adding = params.has("add");
  const row = editing ? data.rows.find((r) => r.id === editing && r.scope === scope) : undefined;
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [environment, setEnvironment] = useState("all");
  const environments = useMemo(
    () => [...new Set([...KNOWN_ENVIRONMENTS, ...data.rows.flatMap((r) => r.environments)])],
    [data.rows],
  );
  const shown = data.rows.filter(
    (r) =>
      (!query || r.name.toLowerCase().includes(query.toLowerCase()) || r.note?.toLowerCase().includes(query.toLowerCase())) &&
      (type === "all" || r.kind === type) &&
      (environment === "all" || r.environments.length === 0 || r.environments.includes(environment)),
  );

  return (
    <div className="max-w-5xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Secrets and variables</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            One list for everything that reads them. Each row says which environments it applies to and whether{" "}
            <strong className="font-medium text-fg">workflows</strong> (as <code className="text-fg">secrets.KEY</code>{" "}
            and <code className="text-fg">vars.KEY</code>), <strong className="font-medium text-fg">deployments</strong>{" "}
            (the build's environment and the running app's <code className="text-fg">env.KEY</code>), or both read it.
            {scope === "workspace"
              ? " Every repository, or the ones you link, reads the workspace's; a repository's own row of the same key wins."
              : " Rows from the workspace are shown too; adding the same key here replaces them for this repository."}{" "}
            <a href="https://docs.g1t.sh/guides/secrets-and-variables/" className="text-fg hover:underline">
              How they are read
            </a>
          </p>
        </div>
        {manage && (
          <ButtonLink to="?add" variant="accent">
            <Plus size={14} />
            Add
          </ButtonLink>
        )}
      </header>

      <p className="mt-4 rounded-lg border border-line bg-surface px-4 py-2.5 text-xs text-muted">
        Built in: workflows get <code className="text-fg">secrets.G1T_TOKEN</code>, the workspace's own token for
        the run, with <code className="text-fg">secrets.GITHUB_TOKEN</code> as its alias. Agents, acceptance checks
        and the merge queue never read secrets or variables, and runs for people outside the workspace get no secrets.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <label className="relative min-w-56 grow">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keys and notes"
            aria-label="Search"
            className={`${SELECT} w-full pl-9`}
          />
        </label>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" className={SELECT}>
          <option value="all">All types</option>
          <option value="secret">Secret</option>
          <option value="variable">Config</option>
        </select>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value)} aria-label="Environment" className={SELECT}>
          <option value="all">All environments</option>
          {environments.map((env) => (
            <option key={env} value={env}>
              {environmentsLabel([env])}
            </option>
          ))}
        </select>
      </div>

      <ErrorText>{data.error}</ErrorText>
      {!editing && !adding && <div className="mt-2"><ErrorText>{action?.error}</ErrorText></div>}

      <div className="mt-4">
        {data.rows.length === 0 ? (
          <EmptyState title="No secrets or variables yet">
            Add one, or paste a <code>.env</code> file into Add to bring many at once.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState title="Nothing matches" />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface">
            {shown.map((r) => (
              <Row key={r.id} row={r} inherited={r.scope !== scope} manage={manage} />
            ))}
          </ul>
        )}
      </div>

      {manage && (adding || row) && (
        <Drawer row={row} scope={scope} repositories={data.repositories} error={action?.error} />
      )}
    </div>
  );
}

function Row({ row, inherited, manage }: { row: Setting; inherited: boolean; manage: boolean }) {
  const busy = useNavigation().state === "submitting";
  const secret = row.kind === "secret";
  return (
    <li className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-line px-4 py-3 text-sm first:border-t-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_6rem_auto]">
      <div className="min-w-0">
        <p className="truncate font-mono text-[0.8125rem]">{row.name}</p>
        {row.note && <p className="truncate text-xs text-faint">{row.note}</p>}
        {!secret && row.value != null && <p className="truncate font-mono text-xs text-muted">{row.value}</p>}
      </div>
      <span className="truncate text-muted">{environmentsLabel(row.environments)}</span>
      <span className="hidden truncate text-xs text-muted md:block">
        {row.availableTo.map((r) => READERS[r] ?? r).join(" · ")}
      </span>
      <span className="hidden items-center gap-1.5 text-xs text-muted md:flex">
        {secret ? <Lock size={13} /> : <SlidersHorizontal size={13} />}
        {secret ? "Secret" : "Config"}
      </span>
      <span className="hidden text-xs text-faint md:block">
        <TimeAgo at={row.updatedAt} />
      </span>
      <span className="flex items-center justify-end gap-1">
        {inherited ? (
          <span className="rounded-full px-2 py-px text-xs text-muted ring-1 ring-line">Workspace</span>
        ) : (
          <>
            {row.repositories.length > 0 && (
              <span className="mr-1 text-xs text-faint" title={row.repositories.join(", ")}>
                {row.repositories.length} {row.repositories.length === 1 ? "repository" : "repositories"}
              </span>
            )}
            {manage && (
              <>
                <Link
                  to={`?edit=${row.id}`}
                  aria-label={`Edit ${row.name}`}
                  className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
                >
                  <Pencil size={14} />
                </Link>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="name" value={row.name} />
                  <button
                    type="submit"
                    disabled={busy}
                    aria-label={`Remove ${row.name}`}
                    className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </Form>
              </>
            )}
          </>
        )}
      </span>
    </li>
  );
}

function Drawer({
  row,
  scope,
  repositories,
  error,
}: {
  row: Setting | undefined;
  scope: "repository" | "workspace";
  repositories: string[];
  error: string | undefined;
}) {
  const busy = useNavigation().state === "submitting";
  const editing = !!row;
  const [type, setType] = useState<"secret" | "config">(row?.kind === "variable" ? "config" : "secret");
  const [some, setSome] = useState(!!row && row.environments.length > 0);
  const [reach, setReach] = useState(row && row.repositories.length > 0 ? "some" : "all");
  const custom = row?.environments.filter((env) => !KNOWN_ENVIRONMENTS.includes(env)) ?? [];
  const field =
    "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label={editing ? "Edit" : "Add"}>
      <Link to="?" aria-label="Close" className="grow" />
      <Form method="post" className="flex h-full w-full max-w-xl flex-col border-l border-line bg-bg shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h3 className="font-semibold">{editing ? `Edit ${row.name}` : "Add a secret or variable"}</h3>
          <Link to="?" aria-label="Close" className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg">
            <X size={16} />
          </Link>
        </div>
        <div className="grow space-y-6 overflow-y-auto px-6 py-5">
          <input type="hidden" name="intent" value="save" />
          {row && <input type="hidden" name="id" value={row.id} />}

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Type</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ["secret", "Secret", "You can't read it again after saving. For passwords, API keys and tokens."],
                  ["config", "Config", "Readable by members after saving. For values that are not sensitive."],
                ] as const
              ).map(([value, title, text]) => {
                // A secret's value is sealed: it can never become config.
                const locked = value === "config" && row?.kind === "secret";
                return (
                  <label
                    key={value}
                    className={`rounded-xl border p-3.5 transition-colors ${
                      type === value ? "border-accent bg-accent/5" : "border-line hover:border-line-strong"
                    } ${locked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                  >
                    <span className="flex items-center justify-between">
                      <span className="text-sm font-medium">{title}</span>
                      <input
                        type="radio"
                        name="type"
                        value={value}
                        checked={type === value}
                        disabled={locked}
                        onChange={() => setType(value)}
                        className="accent-accent"
                      />
                    </span>
                    <span className="mt-1 block text-xs text-muted">{text}</span>
                  </label>
                );
              })}
            </div>
            {row?.kind === "variable" && (
              <p className="mt-2 text-xs text-faint">Config can become a secret; a secret cannot become config.</p>
            )}
          </fieldset>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Key</span>
            {editing ? (
              <input name="key" value={row.name} readOnly className={`${field} font-mono text-muted`} />
            ) : (
              <textarea
                name="key"
                required
                rows={1}
                placeholder="CLIENT_KEY, or paste a .env file"
                autoComplete="off"
                spellCheck={false}
                className={`${field} min-h-10 font-mono`}
              />
            )}
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Value</span>
            <textarea
              name="value"
              rows={type === "secret" ? 3 : 2}
              defaultValue={row?.kind === "variable" ? (row.value ?? "") : ""}
              placeholder={
                editing && row.kind === "secret" ? "Leave empty to keep the current value" : "Enter a value"
              }
              autoComplete="off"
              spellCheck={false}
              className={`${field} font-mono`}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Note (optional)</span>
            <input name="note" defaultValue={row?.note ?? ""} placeholder="Where to rotate it, or who to ask" className={field} />
          </label>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Environments</legend>
            <div className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="all" checked={!some} onChange={() => setSome(false)} className="accent-accent" />
                All environments
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="scope" value="some" checked={some} onChange={() => setSome(true)} className="accent-accent" />
                Only some
              </label>
              {some && (
                <div className="ml-6 space-y-2">
                  {KNOWN_ENVIRONMENTS.map((env) => (
                    <label key={env} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name="env"
                        value={env}
                        defaultChecked={row?.environments.includes(env)}
                        className="accent-accent"
                      />
                      {environmentsLabel([env])}
                    </label>
                  ))}
                  <input
                    name="envCustom"
                    defaultValue={custom.join(", ")}
                    placeholder="Others, comma-separated: staging, qa"
                    className={field}
                  />
                  <p className="text-xs text-faint">
                    Deployments are production and preview; a workflow job reads the row for its{" "}
                    <code>environment:</code>, and rows for all environments otherwise.
                  </p>
                </div>
              )}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Available to</legend>
            <div className="space-y-2 text-sm">
              {(
                [
                  ["workflows", "Workflows", "secrets.KEY or vars.KEY in GitHub Actions workflows"],
                  ["deployments", "Deployments", "The build's environment, and env.KEY in the running app"],
                ] as const
              ).map(([value, title, text]) => (
                <label key={value} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    name="availableTo"
                    value={value}
                    defaultChecked={row ? row.availableTo.includes(value) : true}
                    className="mt-1 accent-accent"
                  />
                  <span>
                    {title}
                    <span className="block text-xs text-faint">{text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {scope === "workspace" && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-muted">Repositories</legend>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="reach" value="all" checked={reach === "all"} onChange={() => setReach("all")} className="accent-accent" />
                  Every repository
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="reach" value="some" checked={reach === "some"} onChange={() => setReach("some")} className="accent-accent" />
                  Only these
                </label>
                {reach === "some" && (
                  <div className="ml-6 grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
                    {repositories.map((name) => (
                      <label key={name} className="flex items-center gap-2 font-mono text-xs">
                        <input
                          type="checkbox"
                          name="repo"
                          value={name}
                          defaultChecked={row?.repositories.includes(name)}
                          className="accent-accent"
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </fieldset>
          )}
          <ErrorText>{error}</ErrorText>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-line px-6 py-4">
          <p className="text-xs text-faint">{editing ? "" : "Paste .env contents into Key to add many."}</p>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </Form>
    </div>
  );
}
