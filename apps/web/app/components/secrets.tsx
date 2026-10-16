/**
 * A project's or a workspace's secrets and variables, separated by scope:
 * each row is a key, its type
 * (Secret or Config), the environments it applies to and who reads it.
 * Adding and editing happen in a side panel, opened by `?add` or
 * `?edit=<id>` so the page works without scripts.
 */
import { Lock, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Form, Link, useLocation } from "react-router";

import type { Setting } from "@g1t/contracts";

import { settingOverride } from "../lib/setting-overrides";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

import type { SecretsAction, SecretsData } from "../lib/secrets.server";
import { ButtonLink, EmptyState, ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { RadioCard, RadioGroup, RadioOption } from "./ui/radio-group";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "./ui/select";

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
  workspacePath,
}: {
  data: SecretsData;
  action: SecretsAction | undefined;
  scope: "project" | "workspace";
  manage: boolean;
  workspacePath?: string;
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
    <div className="min-w-0 max-w-5xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{scope === "project" ? "Environment variables" : "Secrets and variables"}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Secrets and configuration for workflows and deployments, scoped by environment.
            {scope === "workspace"
              ? " Share values with every project or only the projects you choose."
              : " Project keys override workspace keys of the same type for each shared reader."}{" "}
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

      <Card asChild radius="lg" className="mt-4 px-4 py-2.5 text-xs text-muted">
        <p>
          Built in: workflows get <code className="text-fg">secrets.G1T_TOKEN</code>, the workspace's own token for
          the run, with <code className="text-fg">secrets.GITHUB_TOKEN</code> as its alias. The merge
          queue never reads secrets or variables, and runs for people outside the workspace get no secrets.
        </p>
      </Card>

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
        <Select value={type} onValueChange={setType}>
          <SelectTrigger aria-label="Type" className="h-auto w-auto py-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="all">All types</SelectItem>
            <SelectSeparator />
            <SelectItem value="secret" icon={<Lock />}>Secret</SelectItem>
            <SelectItem value="variable" icon={<SlidersHorizontal />}>Config</SelectItem>
          </SelectContent>
        </Select>
        <Select value={environment} onValueChange={setEnvironment}>
          <SelectTrigger aria-label="Environment" className="h-auto w-auto py-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="all">All environments</SelectItem>
            {environments.length > 0 && <SelectSeparator />}
            {environments.map((env) => (
              <SelectItem key={env} value={env}>
                {environmentsLabel([env])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <ErrorText>{data.error}</ErrorText>
      {!editing && !adding && <div className="mt-2"><ErrorText>{action?.error}</ErrorText></div>}

      <div className="mt-6 space-y-8">
        {(scope === "project" ? ["project", "workspace"] as const : ["workspace"] as const).map((section) => {
          const rows = shown.filter((r) => r.scope === section);
          const total = data.rows.filter((r) => r.scope === section).length;
          return (
            <section key={section} aria-label={`${section === "project" ? "Project" : "Workspace"} secrets and variables`}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold">{section === "project" ? "Project secrets and variables" : "Workspace secrets and variables"}</h2>
                  {scope === "project" && section === "workspace" && <p className="mt-1 text-xs text-muted">Inherited values shared with this project. A project key replaces the workspace value for its readers, even outside its selected environments.</p>}
                </div>
                {scope === "project" && section === "workspace" && workspacePath && <ButtonLink to={workspacePath} variant="outline">View workspace variables</ButtonLink>}
              </div>
              {rows.length === 0 ? (
                <EmptyState title={total > 0 ? "Nothing matches these filters" : section === "project" ? "No project secrets or variables" : "No workspace secrets or variables"} />
              ) : (
                <Card className="min-w-0 overflow-hidden">
                  <Table className="min-w-[850px] table-fixed" frameProps={{ tabIndex: 0, role: "region", "aria-label": `${section} secrets and variables` }}>
                    <colgroup><col style={{ width: "32%" }} /><col style={{ width: "19%" }} /><col style={{ width: "18%" }} /><col style={{ width: "10%" }} /><col style={{ width: "11%" }} /><col style={{ width: "10%" }} /></colgroup>
                    <TableHeader><TableRow>
                      <TableHead>Name / value</TableHead><TableHead>Environments</TableHead><TableHead>Used by</TableHead><TableHead>Type</TableHead><TableHead>Updated</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
                    </TableRow></TableHeader>
                    <TableBody>{rows.map((r) => <Row key={r.id} row={r} inherited={r.scope !== scope} manage={manage} override={scope === "project" ? settingOverride(r, data.rows) : null} />)}</TableBody>
                  </Table>
                </Card>
              )}
            </section>
          );
        })}
      </div>

      {manage && (adding || row) && (
        // Keyed to the row, so going from one row's edit to another's starts from that row.
        <Drawer key={row?.id ?? "add"} row={row} scope={scope} projects={data.projects} error={action?.error} />
      )}
    </div>
  );
}

function Row({ row, inherited, manage, override }: { row: Setting; inherited: boolean; manage: boolean; override: string | null }) {
  const secret = row.kind === "secret";
  const hosts = row.brokeredHosts ?? [];
  return (
    <TableRow>
      <TableCell className="align-middle">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 break-all font-mono text-[0.8125rem]">{row.name}</p>
          {secret && hosts.length > 0 && (
            <Hint label={`Filled in for ${hosts.join(", ")}`}>
              <Badge tone="accent">
                Brokered
                <span className="sr-only">: filled in for {hosts.join(", ")}</span>
              </Badge>
            </Hint>
          )}
        </div>
        {row.note && <p className="truncate text-xs text-faint" title={row.note}>{row.note}</p>}
        {override && <p className="mt-1 text-xs text-accent">{override}</p>}
        {!secret && row.value != null && <p className="truncate font-mono text-xs text-muted">{row.value}</p>}
      </div>
      </TableCell>
      <TableCell className="align-middle break-words text-muted">{environmentsLabel(row.environments)}</TableCell>
      <TableCell className="align-middle text-xs text-muted">{row.availableTo.map((r) => READERS[r] ?? r).join(", ")}</TableCell>
      <TableCell className="align-middle text-xs text-muted"><span className="flex items-center gap-1.5">
        {secret ? <Lock size={13} className="shrink-0" /> : <SlidersHorizontal size={13} className="shrink-0" />}{secret ? "Secret" : "Config"}
      </span></TableCell>
      <TableCell className="align-middle text-xs text-faint"><TimeAgo at={row.updatedAt} /></TableCell>
      <TableCell className="align-middle"><div className="flex flex-wrap items-center justify-end gap-1">
        {!inherited && (
          <>
            {row.projects.length > 0 && (
              <Hint label={row.projects.join(", ")}>
                <span className="mr-1 text-xs text-faint">
                  {row.projects.length} {row.projects.length === 1 ? "project" : "projects"}
                  <span className="sr-only">: {row.projects.join(", ")}</span>
                </span>
              </Hint>
            )}
            {manage && (
              <>
                <Link
                  to={`?edit=${row.id}`}
                  aria-label={`Edit ${row.name}`}
                  className="rounded-md p-1.5 text-faint max-sm:p-2.5 transition-colors hover:bg-raised hover:text-fg"
                >
                  <Pencil size={14} />
                </Link>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="name" value={row.name} />
                  <SubmitButton
                    icon
                    match={{ intent: "delete", id: row.id }}
                    aria-label={`Remove ${row.name}`}
                    variant="ghost"
                    size="inline"
                    className="p-1.5 text-faint max-sm:p-2.5 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </SubmitButton>
                </Form>
              </>
            )}
          </>
        )}
      </div></TableCell>
    </TableRow>
  );
}

function Drawer({
  row,
  scope,
  projects,
  error,
}: {
  row: Setting | undefined;
  scope: "project" | "workspace";
  projects: string[];
  error: string | undefined;
}) {
  const editing = !!row;
  const [type, setType] = useState<"secret" | "config">(row?.kind === "variable" ? "config" : "secret");
  const [some, setSome] = useState(!!row && row.environments.length > 0);
  const [reach, setReach] = useState(row && row.projects.length > 0 ? "some" : "all");
  const [brokered, setBrokered] = useState((row?.brokeredHosts?.length ?? 0) > 0);
  // Only a secret is brokered, and only workflows read one.
  const brokering = type === "secret" && brokered;
  const custom = row?.environments.filter((env) => !KNOWN_ENVIRONMENTS.includes(env)) ?? [];
  const field =
    "w-full rounded-md border border-line bg-bg px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label={editing ? "Edit" : "Add"}>
      <Link to="?" aria-label="Close" className="grow" />
      <Form method="post" className="flex h-full w-full max-w-xl flex-col border-l border-line bg-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <h3 className="font-semibold">{editing ? `Edit ${row.name}` : "Add a secret or variable"}</h3>
          <Link to="?" aria-label="Close" className="flex items-center justify-center rounded-md p-1.5 text-faint hover:bg-raised hover:text-fg max-sm:size-10">
            <X size={16} />
          </Link>
        </div>
        <div className="grow space-y-6 overflow-y-auto px-6 py-5">
          <input type="hidden" name="intent" value="save" />
          {row && <input type="hidden" name="id" value={row.id} />}

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Type</legend>
            <RadioGroup
              name="type"
              value={type}
              onValueChange={(value) => setType(value as typeof type)}
              aria-label="Type"
              className="gap-3 sm:grid-cols-2"
            >
              {(
                [
                  ["secret", "Secret", "You can't read it again after saving. For passwords, API keys and tokens.", <Lock key="i" />],
                  ["config", "Config", "Readable by members after saving. For values that are not sensitive.", <SlidersHorizontal key="i" />],
                ] as const
              ).map(([value, title, text, icon]) => (
                // A secret's value is sealed: it can never become config.
                <RadioCard
                  key={value}
                  value={value}
                  title={title}
                  description={text}
                  icon={icon}
                  disabled={value === "config" && row?.kind === "secret"}
                />
              ))}
            </RadioGroup>
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

          {type === "secret" && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-muted">Brokered</legend>
              <div className="space-y-2 text-sm">
                <CheckboxOption
                  name="brokered"
                  checked={brokered}
                  onCheckedChange={(checked) => setBrokered(checked === true)}
                  label="Only for these hosts"
                  description="The job gets a stand-in; g1t puts the real value on requests to these hosts, so it never enters the sandbox."
                />
                {brokered && (
                  <div className="ml-6 space-y-2">
                    <textarea
                      name="brokeredHosts"
                      rows={2}
                      required
                      defaultValue={row?.brokeredHosts?.join("\n") ?? ""}
                      placeholder={"api.example.com\n*.example.com"}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="Hosts"
                      className={`${field} font-mono`}
                    />
                    <p className="text-xs text-faint">
                      One per line. Filled in in headers and the query string, for workflow jobs on g1t's machines.{" "}
                      <a href="https://docs.g1t.sh/guides/secrets-and-variables/#brokered-secrets" className="text-fg hover:underline">
                        What it covers
                      </a>
                    </p>
                  </div>
                )}
              </div>
            </fieldset>
          )}

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-muted">Note (optional)</span>
            <input name="note" defaultValue={row?.note ?? ""} placeholder="Where to rotate it, or who to ask" className={field} />
          </label>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-muted">Environments</legend>
            <div className="space-y-2 text-sm">
              <RadioGroup name="scope" value={some ? "some" : "all"} onValueChange={(value) => setSome(value === "some")} aria-label="Environments">
                <RadioOption value="all" label="All environments" />
                <RadioOption value="some" label="Only some" />
              </RadioGroup>
              {some && (
                <div className="ml-6 space-y-2">
                  {KNOWN_ENVIRONMENTS.map((env) => (
                    <CheckboxOption
                      key={env}
                      name="env"
                      value={env}
                      defaultChecked={row?.environments.includes(env)}
                      label={environmentsLabel([env])}
                    />
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
              ).map(([value, title, text]) => {
                // A deployment's app needs the value itself, so a brokered
                // secret is never one of its.
                const closed = brokering && value === "deployments";
                return (
                  <CheckboxOption
                    key={`${value}${closed ? "-closed" : ""}`}
                    name="availableTo"
                    value={value}
                    defaultChecked={closed ? false : row ? row.availableTo.includes(value) : true}
                    disabled={closed}
                    label={title}
                    description={closed ? "Not for a brokered secret: a deployment's app needs the value itself." : text}
                  />
                );
              })}
            </div>
          </fieldset>

          {scope === "workspace" && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-muted">Projects</legend>
              <div className="space-y-2 text-sm">
                <RadioGroup name="reach" value={reach} onValueChange={(value) => setReach(value as typeof reach)} aria-label="Projects">
                  <RadioOption value="all" label="Every project" />
                  <RadioOption value="some" label="Only these" />
                </RadioGroup>
                {reach === "some" && (
                  <div className="ml-6 grid max-h-48 gap-1.5 overflow-y-auto p-0.5 sm:grid-cols-2">
                    {projects.map((name) => (
                      <CheckboxOption
                        key={name}
                        name="project"
                        value={name}
                        defaultChecked={row?.projects.includes(name)}
                        label={name}
                        className="items-center"
                        labelClassName="font-mono text-xs"
                      />
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
          <SubmitButton match={{ intent: "save" }} pending="Saving…">
            Save
          </SubmitButton>
        </div>
      </Form>
    </div>
  );
}
