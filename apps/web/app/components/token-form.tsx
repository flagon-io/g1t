import { Info, Search, ShieldAlert, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  PRESETS,
  levelsOf,
  permissionsOf,
  presetScopes,
  type Permissions,
  type PresetId,
  type ScopeLevel,
  type ScopeResource,
} from "@g1t/contracts/scopes";
import type { AccessToken, RepositorySelection, TokenPolicy } from "@g1t/contracts";

import { cn } from "../lib/cn";
import {
  ALL_WORKSPACES,
  DEFAULT_EXPIRY_DAYS,
  NO_WORKSPACE,
  describeDays,
  expiryChoices,
  isDangerousLevel,
  keptOutOfAll,
  levelAbout,
  levelLabel,
  permissionGroups,
  policyNote,
  tokenPermissions,
} from "../lib/access-tokens";
import { Checkbox, CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { RadioGroup, RadioOption } from "./ui/radio-group";
import { SelectField } from "./ui/select";
import { Field, Input, Textarea } from "./ui";
import { Button } from "./ui/button";

// The one form for an access token, a person's or a workspace's: its name,
// when it expires, where it reaches (the workspaces and repositories it is
// made for) and its permissions, a level for each resource. Every control
// is a form field (lib/access-tokens.ts reads them back), so it posts the
// same without JavaScript; the script hides what does not apply.

/** A workspace a personal token can be made for, with its rules and repositories. */
export type WorkspaceChoice = {
  slug: string;
  /** Whether you are an owner there: your tokens never wait for approval. */
  owner: boolean;
  policy: TokenPolicy | null;
  /** Its repositories you can see, as `owner/name`. */
  repos: string[];
};

function PermissionRow({
  resource,
  label,
  value,
  onChange,
}: {
  resource: ScopeResource;
  label: string;
  value: ScopeLevel | "none";
  onChange: (value: ScopeLevel | "none") => void;
}) {
  const id = `perm-${resource}`;
  const about = levelAbout(resource, value);
  const levels: (ScopeLevel | "none")[] = ["none", ...levelsOf(resource)];
  return (
    <div className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        <p className={cn("mt-0.5 text-xs leading-snug", isDangerousLevel(value) ? "text-danger" : "text-faint")}>
          {about ?? "No access."}
        </p>
      </div>
      <SelectField
        id={id}
        name={`perm.${resource}`}
        value={value}
        onValueChange={(next) => onChange(next as ScopeLevel | "none")}
        className={cn(
          "w-full shrink-0 sm:w-48",
          value !== "none" && (isDangerousLevel(value) ? "border-danger/50" : "border-accent/50"),
        )}
        options={levels.map((level) => ({ value: level, label: levelLabel(resource, level) }))}
      />
    </div>
  );
}

/** The repositories a token reaches in one workspace: all, the ones picked, or none of the private ones. */
function RepositoryChoice({
  slug,
  repos,
  selection,
  onSelection,
  picked,
  onPicked,
  allowPublic,
}: {
  slug: string;
  repos: string[];
  selection: RepositorySelection;
  onSelection: (value: RepositorySelection) => void;
  picked: string[];
  onPicked: (value: string[]) => void;
  allowPublic: boolean;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? repos.filter((repo) => repo.toLowerCase().includes(query)) : repos;
  }, [repos, filter]);
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-fg">Repository access</legend>
      <RadioGroup
        name="repository_selection"
        value={selection}
        onValueChange={(value) => onSelection(value as RepositorySelection)}
        className="gap-2.5"
      >
        <RadioOption value="all" label="All repositories" description={`Every repository of ${slug}, ones made later too.`} />
        <RadioOption value="selected" label="Only select repositories" description="Up to 50, chosen below." />
        {allowPublic && (
          <RadioOption
            value="public"
            label="No private repositories"
            description={`Public repositories, read-only, and ${slug}'s own settings its permissions allow.`}
          />
        )}
      </RadioGroup>
      {selection === "selected" && (
        <div className="rounded-md border border-line">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={14} className="shrink-0 text-faint" />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={`Find a repository of ${slug}`}
              aria-label="Find a repository"
              className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint"
            />
            <span className="shrink-0 text-xs text-faint">{picked.length} chosen</span>
          </div>
          <div className="max-h-56 overflow-y-auto px-3 py-1.5">
            {shown.length === 0 && <p className="py-2 text-xs text-faint">No repositories match.</p>}
            {shown.map((repo) => (
              <label key={repo} className="flex cursor-pointer items-center gap-2.5 py-1 text-sm">
                <Checkbox
                  name="repo"
                  value={repo}
                  checked={picked.includes(repo)}
                  onCheckedChange={(on) => onPicked(on === true ? [...picked, repo] : picked.filter((name) => name !== repo))}
                />
                <span className="truncate font-mono text-[0.8125rem]">{repo}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </fieldset>
  );
}

function Note({ tone, children }: { tone: "warn" | "danger" | "info"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        tone === "danger" && "border-danger/40 bg-danger/5 text-danger",
        tone === "warn" && "border-warn/40 bg-warn/5 text-warn",
        tone === "info" && "border-line text-muted",
      )}
    >
      {tone === "info" ? <Info size={14} className="mt-px shrink-0" /> : <TriangleAlert size={14} className="mt-px shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

export function TokenForm({
  workspaceOwned = false,
  slug,
  workspaces = [],
  repos = [],
  editing,
  preset = "read_only",
}: {
  /** A workspace's own token, made by an owner: it reaches that workspace. */
  workspaceOwned?: boolean;
  /** For a workspace's own token: the workspace. */
  slug?: string;
  /** For a personal token: the workspaces you belong to. */
  workspaces?: WorkspaceChoice[];
  /** For a workspace's own token: the workspace's repositories. */
  repos?: string[];
  /** The token being changed: its reach's workspace and expiry stay. */
  editing?: AccessToken;
  /** What a new token's permissions start as. */
  preset?: PresetId;
}) {
  // Where it reaches. A personal token: every workspace (*), none (-), or one.
  const initialReach = editing
    ? editing.workspace ?? (editing.repositorySelection === "public" ? NO_WORKSPACE : ALL_WORKSPACES)
    : ALL_WORKSPACES;
  const [reach, setReach] = useState<string>(initialReach);
  const one = workspaceOwned ? (slug ?? "") : reach !== ALL_WORKSPACES && reach !== NO_WORKSPACE ? reach : null;
  const chosen = workspaces.find((choice) => choice.slug === one) ?? null;
  const [selection, setSelection] = useState<RepositorySelection>(editing?.repositorySelection ?? "all");
  const [picked, setPicked] = useState<string[]>(editing?.repositories ?? []);
  const [levels, setLevels] = useState<Permissions>(() =>
    editing ? tokenPermissions(editing) : permissionsOf(presetScopes(preset) ?? null),
  );
  const [website, setWebsite] = useState<boolean>(editing?.website ?? false);

  // The rules of the workspaces it would reach decide how long it may last.
  const reached = workspaceOwned ? [] : one ? [chosen] : reach === ALL_WORKSPACES ? workspaces : [];
  const choices = expiryChoices(reached.map((choice) => choice?.policy ?? null));
  const [expires, setExpires] = useState<string>(
    choices.days.includes(DEFAULT_EXPIRY_DAYS) ? String(DEFAULT_EXPIRY_DAYS) : String(choices.days[choices.days.length - 1]),
  );
  const expiryOptions = [
    ...choices.days.map((days) => ({ value: String(days), label: describeDays(days) })),
    ...(choices.never ? [{ value: "never", label: "No expiration" }] : []),
  ];
  const expiresShown = expiryOptions.some((option) => option.value === expires) ? expires : expiryOptions[expiryOptions.length - 1]!.value;

  const groups = permissionGroups(workspaceOwned);
  const given = groups.flatMap((group) => group.resources).filter(({ resource }) => levels[resource]).length;
  const note = one && !workspaceOwned ? policyNote(one, chosen?.policy, chosen?.owner ?? false) : null;
  const blocked = Boolean(one && !workspaceOwned && chosen?.policy && !chosen.policy.allowTokensForThisWorkspace);
  const keptOut = !workspaceOwned && reach === ALL_WORKSPACES ? keptOutOfAll(workspaces) : [];
  const choosePreset = (id: PresetId) => setLevels(permissionsOf(presetScopes(id)));

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Field label="Token name" hint="Name it after what will use it.">
          <Input name="name" maxLength={100} placeholder="release bot" defaultValue={editing?.name} required={!editing} />
        </Field>
        <Field label="Description" hint="Optional. What it is for, for whoever reviews it.">
          <Textarea name="description" rows={2} maxLength={500} defaultValue={editing?.description ?? ""} />
        </Field>
        {!editing && (
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <label htmlFor="token-expires" className="text-sm font-medium text-muted">
              Expiration
            </label>
            <SelectField id="token-expires" name="expires" value={expiresShown} onValueChange={setExpires} options={expiryOptions} />
            {expiresShown === "never" ? (
              <p className="flex items-start gap-1.5 text-xs text-warn">
                <TriangleAlert size={13} className="mt-px shrink-0" />
                It works until someone deletes it. Prefer an expiration.
              </p>
            ) : (
              !choices.never && <p className="text-xs text-faint">The workspaces it reaches allow at most {describeDays(choices.days[choices.days.length - 1]!)}.</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium text-fg">Where it reaches</h3>
          <p className="mt-0.5 text-xs text-faint">
            {workspaceOwned
              ? `It acts as ${slug}, in ${slug} only, and keeps working when the person who made it leaves.`
              : "It never reaches more than you can; this narrows it further."}
          </p>
        </div>
        {!workspaceOwned &&
          (editing ? (
            <p className="rounded-md border border-line px-3 py-2 text-sm">
              {reach === ALL_WORKSPACES
                ? "All your workspaces"
                : reach === NO_WORKSPACE
                  ? "No workspace: your account and public repositories"
                  : <span className="font-mono">{reach}</span>}
              <input type="hidden" name="workspace" value={reach} />
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="token-workspace" className="text-sm font-medium text-muted">
                Workspaces
              </label>
              <SelectField
                id="token-workspace"
                name="workspace"
                value={reach}
                onValueChange={setReach}
                options={[
                  { value: ALL_WORKSPACES, label: "All your workspaces", description: "Every workspace you belong to, now and later." },
                  ...workspaces.map((choice) => ({
                    value: choice.slug,
                    label: choice.slug,
                    disabled: choice.policy?.allowTokensForThisWorkspace === false,
                    description: choice.policy?.allowTokensForThisWorkspace === false ? "Does not allow tokens made for it" : "This workspace only",
                  })),
                  { value: NO_WORKSPACE, label: "No workspace", description: "Your account and public repositories only." },
                ]}
              />
            </div>
          ))}
        {keptOut.length > 0 && (
          <Note tone="warn">
            {keptOut.join(", ")} {keptOut.length === 1 ? "keeps" : "keep"} out tokens made for all of a member's workspaces: make a token for{" "}
            {keptOut.length === 1 ? "it" : "each"} alone to reach {keptOut.length === 1 ? "it" : "them"}.
          </Note>
        )}
        {note && <Note tone={blocked ? "danger" : "warn"}>{note}</Note>}
        {one && (
          <RepositoryChoice
            slug={one}
            repos={workspaceOwned ? repos : (chosen?.repos ?? editing?.repositories ?? [])}
            selection={selection}
            onSelection={setSelection}
            picked={picked}
            onPicked={setPicked}
            allowPublic={!workspaceOwned}
          />
        )}
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="mr-1 text-sm font-medium text-fg">Permissions</h3>
          {PRESETS.filter((option) => option.id !== "full").map((option) => (
            <Hint key={option.id} label={option.description}>
              <Button
                type="button"
                onClick={() => choosePreset(option.id)}
                variant="outline"
                size="inline"
                className="rounded-full px-2.5 py-0.5 text-xs text-muted"
              >
                {option.label}
              </Button>
            </Hint>
          ))}
          <Button
            type="button"
            onClick={() => setLevels({})}
            variant="outline"
            size="inline"
            className="rounded-full px-2.5 py-0.5 text-xs text-muted font-normal"
          >
            Clear
          </Button>
          <span className="ml-auto text-xs text-faint">{given === 1 ? "1 permission" : `${given} permissions`}</span>
        </div>
        {groups.map((group) => (
          <section key={group.group} aria-labelledby={`group-${group.group}`} className="rounded-md border border-line">
            <header className="border-b border-line px-3 py-2 sm:px-4">
              <h4 id={`group-${group.group}`} className="text-xs font-medium text-muted">
                {group.label}
              </h4>
              <p className="text-xs text-faint">{group.about}</p>
            </header>
            <div className="divide-y divide-line px-3 sm:px-4">
              {group.resources.map(({ resource, label }) => (
                <PermissionRow
                  key={resource}
                  resource={resource}
                  label={label}
                  value={levels[resource] ?? "none"}
                  onChange={(value) =>
                    setLevels((now) => {
                      const next = { ...now };
                      if (value === "none") delete next[resource];
                      else next[resource] = value;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </section>
        ))}
        {levels.workflow_files === "write" && (
          <Note tone="warn">
            Workflow files: write lets this token add and change workflow files, which run with the repository's secrets.
          </Note>
        )}
        {workspaceOwned && levels.repo === "admin" && (
          <p className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
            <ShieldAlert size={14} className="mt-px shrink-0" />
            Repositories: admin makes this token an admin of {slug}'s repositories: it can rename, archive and delete them
            and change who has access, as far as its other permissions allow. Without it, it has Write, as a member does.
          </p>
        )}
      </section>

      {!workspaceOwned && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-fg">Website</h3>
            <p className="mt-0.5 text-xs text-faint">For automation that drives a browser, such as end-to-end tests.</p>
          </div>
          <CheckboxOption
            id="token-website"
            name="website"
            value="on"
            checked={website}
            onCheckedChange={(on) => setWebsite(on === true)}
            className="rounded-md border border-line px-3 py-2.5"
            labelClassName="font-medium"
            label="Use the website as you"
            description={
              <>
                Sent as <code className="font-mono">Authorization: Bearer</code> on each request, it signs g1t.sh in as you
                without a password or a two-factor code. Tokens, two-factor authentication, your password, email addresses,
                keys, deleting your account or a workspace, giving a workspace away and payment methods still need you to sign
                in.
              </>
            }
          />
          {website && (
            <Note tone="warn">
              The website does not hold this token to its permissions above: treat it as able to do anything you can in
              the workspaces it reaches. Keep it as safe as your password, and give it an expiration.
            </Note>
          )}
        </section>
      )}
    </div>
  );
}
