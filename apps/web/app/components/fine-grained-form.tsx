import { Info, Search, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import {
  PERMISSION_GROUPS,
  permissionLevels,
  permissionScopes,
  type FineGrainedPermission,
  type PermissionAccess,
  type RepositorySelection,
} from "@g1t/contracts";
import type { AccessToken, TokenPolicy } from "@g1t/contracts";

import { cn } from "../lib/cn";
import {
  DEFAULT_FINE_GRAINED_DAYS,
  accessLabel,
  describeDays,
  expiryChoices,
  permissionsFor,
  policyNote,
} from "../lib/fine-grained";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";
import { CONTROL } from "./ui/input";
import { Field, Input, Textarea } from "./ui";

// The form for a fine-grained personal access token: its resource owner,
// when it expires, which repositories it reaches, and a level for each
// permission. Every control is a plain form field (lib/fine-grained.ts reads
// them back), so it posts the same without JavaScript; the script hides
// what does not apply to the chosen resource owner.

/** A workspace you can aim a token at, with its rules. */
export type OwnerChoice = {
  slug: string;
  owner: boolean;
  policy: TokenPolicy | null;
  /** Its repositories you can see, as `owner/name`. */
  repos: string[];
};

function PermissionRow({
  permission,
  value,
  onChange,
}: {
  permission: FineGrainedPermission;
  value: PermissionAccess;
  onChange: (value: PermissionAccess) => void;
}) {
  const fixed = permission.name === "metadata";
  const levels: PermissionAccess[] = fixed ? ["read"] : ["none", ...permissionLevels(permission)];
  const scopes = permissionScopes(permission, value);
  const id = `perm-${permission.name}`;
  return (
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium text-fg">
          {permission.label}
          {fixed && <Badge>Mandatory</Badge>}
        </label>
        <p className="mt-0.5 text-xs leading-snug text-faint">{permission.about}</p>
        {scopes.length > 0 && (
          <p className="mt-1 font-mono text-[0.6875rem] text-muted">{scopes.join(" ")}</p>
        )}
      </div>
      <select
        id={id}
        name={`perm.${permission.name}`}
        value={value}
        disabled={fixed}
        onChange={(event) => onChange(event.target.value as PermissionAccess)}
        className={cn(CONTROL, "w-full shrink-0 sm:w-44", value !== "none" && "border-accent/50 text-fg")}
      >
        {levels.map((level) => (
          <option key={level} value={level}>
            {accessLabel(level, permission)}
          </option>
        ))}
      </select>
      {fixed && <input type="hidden" name={`perm.${permission.name}`} value="read" />}
    </div>
  );
}

export function FineGrainedForm({
  owners,
  editing,
}: {
  owners: OwnerChoice[];
  /** The token being changed: its resource owner and expiry stay. */
  editing?: AccessToken;
}) {
  const details = editing?.fineGrained ?? null;
  const [owner, setOwner] = useState<string>(editing ? (details?.workspace ?? "") : (owners[0]?.slug ?? ""));
  const chosen = owners.find((choice) => choice.slug === owner) ?? null;
  const workspace = owner !== "";
  const [selection, setSelection] = useState<RepositorySelection>(details?.repositorySelection ?? "all");
  const [picked, setPicked] = useState<string[]>(details?.repositories ?? []);
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<Record<string, PermissionAccess>>(() => {
    const start: Record<string, PermissionAccess> = { metadata: "read" };
    for (const [name, access] of Object.entries(details?.permissions ?? {})) if (access) start[name] = access;
    return start;
  });
  const choices = expiryChoices(chosen?.policy);
  const [days, setDays] = useState<number>(choices.includes(DEFAULT_FINE_GRAINED_DAYS) ? DEFAULT_FINE_GRAINED_DAYS : choices[choices.length - 1]);
  const note = workspace ? policyNote(owner, chosen?.policy, chosen?.owner ?? false) : null;
  const blocked = workspace && chosen?.policy?.allowFineGrained === false;
  const shownRepos = useMemo(() => {
    const all = chosen?.repos ?? [];
    const query = filter.trim().toLowerCase();
    return query ? all.filter((repo) => repo.toLowerCase().includes(query)) : all;
  }, [chosen, filter]);
  const permissions = permissionsFor(workspace);
  const given = Object.entries(levels).filter(([name, access]) => access !== "none" && name !== "metadata" && permissions.some((p) => p.name === name)).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Token name" hint="Name it after what will use it.">
          <Input name="name" maxLength={100} placeholder="release bot" defaultValue={editing?.name} required={!editing} />
        </Field>
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-muted">Resource owner</span>
            <p className="py-1.5 font-mono text-sm">{details?.workspace ?? "Your account"}</p>
            <input type="hidden" name="owner" value={owner} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-owner" className="text-sm font-medium text-muted">
              Resource owner
            </label>
            <select id="token-owner" name="owner" value={owner} onChange={(event) => setOwner(event.target.value)} className={CONTROL}>
              {owners.map((choice) => (
                <option key={choice.slug} value={choice.slug} disabled={choice.policy?.allowFineGrained === false}>
                  {choice.slug}
                  {choice.policy?.allowFineGrained === false ? " (does not allow fine-grained tokens)" : ""}
                </option>
              ))}
              <option value="">Your account</option>
            </select>
          </div>
        )}
      </div>
      <Field label="Description" hint="Optional. What it is for, for whoever reviews it.">
        <Textarea name="description" rows={2} maxLength={500} defaultValue={editing?.description ?? ""} />
      </Field>

      {!editing && (
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor="token-expires" className="text-sm font-medium text-muted">
            Expiration
          </label>
          <select id="token-expires" name="expires" value={days} onChange={(event) => setDays(Number(event.target.value))} className={CONTROL}>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {describeDays(choice)}
              </option>
            ))}
          </select>
          <p className="text-xs text-faint">
            {chosen?.policy?.maxLifetimeDays
              ? `${owner} allows at most ${describeDays(chosen.policy.maxLifetimeDays)}.`
              : "Fine-grained tokens always expire, within a year."}
          </p>
        </div>
      )}

      {note && (
        <p className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-xs", blocked ? "border-danger/40 bg-danger/5 text-danger" : "border-warn/40 bg-warn/5 text-warn")}>
          {blocked ? <TriangleAlert size={14} className="mt-px shrink-0" /> : <Info size={14} className="mt-px shrink-0" />}
          {note}
        </p>
      )}

      {workspace ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-fg">Repository access</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["public", "Public repositories", "Read-only, across g1t."],
                ["all", "All repositories", `Every repository of ${owner}, ones made later too.`],
                ["selected", "Only select repositories", "Up to 50, chosen below."],
              ] as const
            ).map(([value, label, about]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors",
                  selection === value ? "border-accent/50 bg-accent/5" : "border-line hover:border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name="repository_selection"
                  value={value}
                  checked={selection === value}
                  onChange={() => setSelection(value)}
                  className="mt-0.5 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-fg">{label}</span>
                  <span className="block text-xs text-faint">{about}</span>
                </span>
              </label>
            ))}
          </div>
          {selection === "selected" && (
            <div className="rounded-md border border-line">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <Search size={14} className="shrink-0 text-faint" />
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={`Find a repository of ${owner}`}
                  aria-label="Find a repository"
                  className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint"
                />
                <span className="shrink-0 text-xs text-faint">{picked.length} chosen</span>
              </div>
              <div className="max-h-56 overflow-y-auto px-3 py-1.5">
                {shownRepos.length === 0 && <p className="py-2 text-xs text-faint">No repositories match.</p>}
                {shownRepos.map((repo) => (
                  <label key={repo} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
                    <input
                      type="checkbox"
                      name="repo"
                      value={repo}
                      checked={picked.includes(repo)}
                      onChange={(event) =>
                        setPicked((now) => (event.target.checked ? [...now, repo] : now.filter((name) => name !== repo)))
                      }
                      className="size-4 accent-accent"
                    />
                    <span className="truncate font-mono text-[0.8125rem]">{repo}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </fieldset>
      ) : (
        <p className="rounded-md border border-line px-3 py-2 text-xs text-muted">
          With your account as its resource owner, a token reads public repositories and does what its account
          permissions allow. To reach a workspace's repositories, choose the workspace.
        </p>
      )}

      <div className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="text-sm font-medium text-fg">Permissions</h3>
          <span className="text-xs text-faint">{given === 1 ? "1 permission" : `${given} permissions`}</span>
        </div>
        {PERMISSION_GROUPS.map((group) => {
          const rows = permissions.filter((permission) => permission.group === group.group);
          if (rows.length === 0) return null;
          return (
            <section key={group.group} aria-labelledby={`group-${group.group}`} className="rounded-md border border-line">
              <header className="border-b border-line px-3 py-2 sm:px-4">
                <h4 id={`group-${group.group}`} className="text-xs font-medium text-muted">
                  {group.label}
                </h4>
                <p className="text-xs text-faint">{group.about}</p>
              </header>
              <div className="divide-y divide-line px-3 sm:px-4">
                {rows.map((permission) => (
                  <PermissionRow
                    key={permission.name}
                    permission={permission}
                    value={levels[permission.name] ?? "none"}
                    onChange={(value) => setLevels((now) => ({ ...now, [permission.name]: value }))}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {levels.workflows === "write" && (
          <Hint label="Workflows run with the repository's secrets: a token that can change them can reach those secrets.">
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <TriangleAlert size={13} className="mt-px shrink-0" />
              Workflows: write lets this token add and change workflow files.
            </p>
          </Hint>
        )}
      </div>
    </div>
  );
}
