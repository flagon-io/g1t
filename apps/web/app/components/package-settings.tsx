import { Box, Lock, RotateCcw, Trash2, User, UserPlus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import {
  type ActionsAccess,
  PACKAGE_ROLES,
  type PackageAccess,
  type PackageRole,
  type PackageSettings,
  type PackageVersion,
  PACKAGE_RESTORE_DAYS,
} from "@g1t/contracts";

import { ConfirmDialog } from "./repo-lifecycle";
import { SettingsSection as Section } from "./settings-section";
import { ErrorText, SubmitButton, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Hint } from "./ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton, SkeletonLine, SkeletonRows } from "./ui/skeleton";
import { SwitchCard } from "./ui/switch";
import { formatBytes, shortDigest } from "../lib/packages";

/** A one-line text field the height of the small selects beside it. */
const FIELD =
  "h-8 w-full min-w-0 rounded-md border border-line bg-bg px-2.5 font-mono text-sm placeholder:font-sans placeholder:text-faint focus:border-line-strong focus:outline-none";

/** What an action on the Settings tab answers. */
export type SettingsOutcome = { error: string | null; message: string | null };

export const PACKAGE_ROLE_LABEL: Record<PackageRole, string> = { read: "Read", write: "Write", admin: "Admin" };
const PACKAGE_ROLE_SUMMARY: Record<PackageRole, string> = {
  read: "Pull and install it.",
  write: "Also publish new versions and tags.",
  admin: "Also delete and restore it, and change these settings.",
};
const ACTIONS_ROLE_SUMMARY: Record<"read" | "write", string> = {
  read: "Its workflows pull or install the package.",
  write: "Its workflows publish it too.",
};

/** A role picker: read, write and admin, or read and write for a repository. */
function RoleSelect({
  value,
  roles,
  label,
  name,
  disabled,
  onValueChange,
  className = "w-28",
}: {
  value: string;
  roles: readonly ("read" | "write" | "admin")[];
  label: string;
  name?: string;
  disabled?: boolean;
  onValueChange?: (role: string) => void;
  className?: string;
}) {
  return (
    <Select name={name} value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger size="sm" aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" className="w-64">
        {roles.map((role) => (
          <SelectItem
            key={role}
            value={role}
            description={role === "admin" ? PACKAGE_ROLE_SUMMARY.admin : roles.length === 2 ? ACTIONS_ROLE_SUMMARY[role] : PACKAGE_ROLE_SUMMARY[role]}
          >
            {PACKAGE_ROLE_LABEL[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The Settings tab of a package: who may use it, from where, and what happens to it. Admins only. */
export function PackageSettingsTab({ settings, outcome }: { settings: PackageSettings; outcome: SettingsOutcome | undefined }) {
  const { package: pkg, access, actions_access: actions, deleted_versions: deleted, permissions } = settings;
  const repo = pkg.repo ? `${pkg.repo.namespace}/${pkg.repo.name}` : null;
  const npm = pkg.ecosystem !== "container";
  return (
    <div className="max-w-4xl space-y-8">
      {outcome?.error && <ErrorText>{outcome.error}</ErrorText>}
      {outcome?.message && (
        <p className="text-sm text-success" role="status">
          {outcome.message}
        </p>
      )}

      <Section
        title="Manage access"
        about={
          repo
            ? `People and teams with a role on the package itself. The workspace's owners administer every package.`
            : `People and teams with a role on the package itself, beyond what members of ${pkg.workspace} get from its base permission. Owners administer every package.`
        }
      >
        {repo && <InheritToggle on={pkg.inherit_access !== false} repo={repo} />}
        {access.length === 0 ? (
          <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
            <p>
              No one has a role on the package itself.
            </p>
          </Card>
        ) : (
          <Card asChild tone="plain" divided>
            <ul>
              {access.map((entry) => (
                <AccessRow key={`${entry.kind}:${entry.id}`} entry={entry} workspace={pkg.workspace} />
              ))}
            </ul>
          </Card>
        )}
        <AddAccessForm />
      </Section>

      <Section
        title="Manage Actions access"
        about="Which repositories' workflows may use the package with their job token, G1T_TOKEN. A workflow in any other repository is refused."
      >
        <Card asChild tone="plain" divided>
          <ul>
            {actions.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-muted">No repository's workflows may use it yet.</li>
            )}
            {actions.map((entry) => (
              <ActionsRow key={entry.repo_id} entry={entry} />
            ))}
          </ul>
        </Card>
        <AddActionsForm workspace={pkg.workspace} />
      </Section>

      <Section
        title="Visibility"
        about="Who may pull it. Public packages need no sign-in to pull; pushing always needs the Write role."
      >
        {repo ? (
          <Card asChild className="p-4 text-sm text-muted">
            <p>
              <span className="inline-flex items-center gap-1.5 font-medium text-fg">
                {pkg.visibility === "private" && <Lock size={13} />}
                {pkg.visibility === "private" ? "Private" : "Public"}
              </span>
              , as{" "}
              <Link to={`/${repo}`} className="text-fg-soft hover:text-fg">
                {repo}
              </Link>{" "}
              is. A linked package has its repository's visibility: change the repository's, or unlink the package.
            </p>
          </Card>
        ) : (
          <Card asChild className="flex flex-wrap items-center gap-3 p-4">
            <Form method="post">
              <input type="hidden" name="intent" value="visibility" />
              <Select name="visibility" defaultValue={pkg.visibility}>
                <SelectTrigger size="sm" aria-label="Visibility" className="w-full sm:w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="private" description={`Members of ${pkg.workspace}, by its base permission, and those given a role here.`}>
                    Private
                  </SelectItem>
                  <SelectItem value="public" description="Anyone can pull it, signed in or not.">
                    Public
                  </SelectItem>
                </SelectContent>
              </Select>
              <SubmitButton variant="outline" match={{ intent: "visibility" }} pending="Saving…">
                Save
              </SubmitButton>
            </Form>
          </Card>
        )}
      </Section>

      <Section
        title="Repository"
        about="A linked package shows on its repository, takes its visibility and, while inheriting access, its roles, and its repository's workflows may publish it."
      >
        <Card className="space-y-3 p-4">
          {repo ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 text-sm">
                <Box size={14} className="shrink-0 text-faint" />
                <span className="text-muted">Linked to</span>
                <Link to={`/${repo}`} className="truncate font-mono text-fg-soft hover:text-fg">
                  {repo}
                </Link>
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="unlink" />
                <SubmitButton variant="outline" match={{ intent: "unlink" }} pending="Unlinking…">
                  Unlink
                </SubmitButton>
              </Form>
            </div>
          ) : (
            <p className="text-sm text-muted">Not linked: it is the workspace's.</p>
          )}
          <Form method="post" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="intent" value="link" />
            <label className="sr-only" htmlFor="link-repo">
              Repository to link
            </label>
            <input id="link-repo" name="repo" required placeholder="repository" className={`${FIELD} sm:w-56`} />
            <SubmitButton variant="outline" match={{ intent: "link" }} pending="Linking…">
              {repo ? "Link to another" : "Link"}
            </SubmitButton>
          </Form>
          <p className="text-xs text-faint">Linking needs the Admin role on the repository too.</p>
        </Card>
      </Section>

      {permissions.delete && (
        <Section
          title="Deleted versions"
          about={`Versions deleted in the last ${PACKAGE_RESTORE_DAYS} days, which can still be restored. Their ${npm ? "versions" : "digests"} cannot be published again until they are purged.`}
        >
          {deleted.length === 0 ? (
            <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
              <p>No deleted versions.</p>
            </Card>
          ) : (
            <Card asChild tone="plain" divided>
              <ul>
                {deleted.map((version) => (
                  <DeletedVersionRow key={version.id} version={version} npm={npm} />
                ))}
              </ul>
            </Card>
          )}
        </Section>
      )}

      {permissions.delete && (
        <Section title="Delete this package" about={`Every version goes from the registry at once. An admin can restore it for ${PACKAGE_RESTORE_DAYS} days.`}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-danger/30 bg-surface p-4">
            <p className="text-sm text-muted">
              Its name stays taken until it is purged, so nobody else can publish a package called {pkg.name} meanwhile.
            </p>
            <ConfirmDialog
              intent="delete-package"
              title={`Delete ${pkg.name}?`}
              description={`Anyone pulling it gets an error from then on. It can be restored from the workspace's deleted packages for ${PACKAGE_RESTORE_DAYS} days.`}
              confirm={pkg.name}
              submit="Delete package"
              busy="Deleting…"
              trigger={(open) => (
                <Button type="button" variant="destructive" onClick={open}>
                  <Trash2 size={14} />
                  Delete package
                </Button>
              )}
            >
              <li>
                {pkg.versions} {pkg.versions === 1 ? "version" : "versions"} and their tags.
              </li>
              <li>After {PACKAGE_RESTORE_DAYS} days it is purged, and files no other package uses are removed.</li>
            </ConfirmDialog>
          </div>
        </Section>
      )}
    </div>
  );
}

/** Whether a linked package takes its repository's roles: saved as soon as it is flipped. */
function InheritToggle({ on, repo }: { on: boolean; repo: string }) {
  const fetcher = useFetcher<SettingsOutcome>();
  const shown = fetcher.formData ? fetcher.formData.get("inherit") === "on" : on;
  return (
    <>
      <SwitchCard
        title="Inherit access from the linked repository"
        checked={shown}
        disabled={fetcher.state !== "idle"}
        onCheckedChange={(checked) => fetcher.submit({ intent: "inherit", inherit: checked ? "on" : "off" }, { method: "post" })}
      >
        {shown
          ? `Everyone with a role on ${repo} has it on the package too, and the people and teams below add to it.`
          : `Only the people and teams below, and the workspace's owners, have access. Roles on ${repo} no longer reach the package.`}
      </SwitchCard>
      {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
    </>
  );
}

function AccessRow({ entry, workspace }: { entry: PackageAccess; workspace: string }) {
  const fetcher = useFetcher<SettingsOutcome>();
  const shown = fetcher.formData?.get("intent") === "access-role" ? String(fetcher.formData.get("role")) : entry.role;
  const removing = fetcher.formData?.get("intent") === "access-remove";
  const slug = entry.name.includes("/") ? entry.name.slice(entry.name.indexOf("/") + 1) : entry.name;
  const who: Record<string, string> = entry.kind === "user" ? { user: entry.name } : { team: slug };
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${removing ? "opacity-50" : ""}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-muted">
        {entry.kind === "user" ? <User size={15} /> : <Users size={15} />}
      </span>
      <div className="min-w-0 grow basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={entry.kind === "user" ? `/u/${entry.name}` : `/${workspace}/-/teams/${slug}`}
            className="truncate font-mono text-sm hover:text-accent"
          >
            {entry.name}
          </Link>
          <Badge>{entry.kind === "user" ? "Person" : "Team"}</Badge>
        </p>
        <p className="mt-0.5 text-xs text-faint">
          Added <TimeAgo at={entry.created_at} />
        </p>
        {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <RoleSelect
          value={shown}
          roles={PACKAGE_ROLES}
          label={`Role of ${entry.name}`}
          disabled={fetcher.state !== "idle"}
          onValueChange={(role) => fetcher.submit({ intent: "access-role", ...who, role }, { method: "post" })}
        />
        <Hint label={`Take ${entry.name}'s role away`}>
          <Button
            type="button"
            aria-label={`Remove ${entry.name}`}
            disabled={fetcher.state !== "idle"}
            onClick={() => fetcher.submit({ intent: "access-remove", ...who }, { method: "post" })}
            variant="ghost"
            size="inline"
            className="p-1.5 text-faint hover:text-danger"
          >
            <Trash2 size={14} />
          </Button>
        </Hint>
      </div>
    </li>
  );
}

/** A person by username, or a team by slug, and the role to give. */
function AddAccessForm() {
  const [kind, setKind] = useState<"user" | "team">("user");
  const [role, setRole] = useState<PackageRole>("read");
  const fetcher = useFetcher<SettingsOutcome>();
  const [key, setKey] = useState(0);
  // Cleared once someone was added, ready for the next.
  useEffect(() => {
    if (fetcher.data && !fetcher.data.error) setKey((k) => k + 1);
  }, [fetcher.data]);
  return (
    <Card asChild className="space-y-3 p-4">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="access-add" />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="role" value={role} />
        <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_7rem_auto] sm:items-center">
          <Select value={kind} onValueChange={(value) => setKind(value as "user" | "team")}>
            <SelectTrigger size="sm" aria-label="Person or team">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="user">Person</SelectItem>
              <SelectItem value="team">Team</SelectItem>
            </SelectContent>
          </Select>
          <input
            key={key}
            name="who"
            required
            aria-label={kind === "user" ? "Username" : "Team"}
            placeholder={kind === "user" ? "username" : "team slug"}
            className={FIELD}
          />
          <RoleSelect value={role} roles={PACKAGE_ROLES} label="Role" onValueChange={(value) => setRole(value as PackageRole)} className="w-full" />
          <SubmitButton variant="outline" fetcher={fetcher} match={{ intent: "access-add" }} pending="Adding…">
            <UserPlus size={14} />
            Add
          </SubmitButton>
        </div>
        <p className="text-xs text-faint">
          {PACKAGE_ROLE_LABEL[role]}: {PACKAGE_ROLE_SUMMARY[role].toLowerCase()}
        </p>
        {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
        {fetcher.data?.message && (
          <p className="text-sm text-success" role="status">
            {fetcher.data.message}
          </p>
        )}
      </fetcher.Form>
    </Card>
  );
}

function ActionsRow({ entry }: { entry: ActionsAccess }) {
  const fetcher = useFetcher<SettingsOutcome>();
  const shown = fetcher.formData?.get("intent") === "actions-role" ? String(fetcher.formData.get("role")) : entry.role;
  const removing = fetcher.formData?.get("intent") === "actions-remove";
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${removing ? "opacity-50" : ""}`}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised text-muted">
        <Box size={15} />
      </span>
      <div className="min-w-0 grow basis-40">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/${entry.repo}`} className="truncate font-mono text-sm hover:text-accent">
            {entry.repo}
          </Link>
          {entry.linked && <Badge tone="accent">Linked repository</Badge>}
        </p>
        <p className="mt-0.5 text-xs text-faint">
          {entry.linked ? "Its workflows always publish the package it is linked to." : <>Added {entry.created_at && <TimeAgo at={entry.created_at} />}</>}
        </p>
        {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {entry.linked ? (
          <span className="inline-flex h-8 w-28 items-center rounded-md border border-line px-2.5 text-[0.8125rem] text-muted">Write</span>
        ) : (
          <RoleSelect
            value={shown}
            roles={["read", "write"]}
            label={`Role of ${entry.repo}'s workflows`}
            disabled={fetcher.state !== "idle"}
            onValueChange={(role) => fetcher.submit({ intent: "actions-role", repo: entry.repo, role }, { method: "post" })}
          />
        )}
        <span className="flex w-[2.125rem] justify-end">
          {!entry.linked && (
            <Hint label={`Stop ${entry.repo}'s workflows using it`}>
              <Button
                type="button"
                aria-label={`Remove ${entry.repo}`}
                disabled={fetcher.state !== "idle"}
                onClick={() => fetcher.submit({ intent: "actions-remove", repo: entry.repo }, { method: "post" })}
                variant="ghost"
                size="inline"
                className="p-1.5 text-faint hover:text-danger"
              >
                <Trash2 size={14} />
              </Button>
            </Hint>
          )}
        </span>
      </div>
    </li>
  );
}

function AddActionsForm({ workspace }: { workspace: string }) {
  const [role, setRole] = useState<"read" | "write">("read");
  const fetcher = useFetcher<SettingsOutcome>();
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (fetcher.data && !fetcher.data.error) setKey((k) => k + 1);
  }, [fetcher.data]);
  return (
    <Card asChild className="space-y-3 p-4">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="actions-add" />
        <input type="hidden" name="role" value={role} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto] sm:items-center">
          <div className="flex h-8 min-w-0 items-center rounded-md border border-line bg-bg pl-2.5 font-mono text-sm focus-within:border-line-strong">
            <span className="shrink-0 text-faint">{workspace}/</span>
            <input
              key={key}
              name="repo"
              required
              aria-label="Repository"
              placeholder="repository"
              className="h-full min-w-0 grow bg-transparent pr-2.5 placeholder:text-faint focus:outline-none"
            />
          </div>
          <RoleSelect value={role} roles={["read", "write"]} label="Role" onValueChange={(value) => setRole(value as "read" | "write")} className="w-full" />
          <SubmitButton variant="outline" fetcher={fetcher} match={{ intent: "actions-add" }} pending="Adding…">
            Add repository
          </SubmitButton>
        </div>
        {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
        {fetcher.data?.message && (
          <p className="text-sm text-success" role="status">
            {fetcher.data.message}
          </p>
        )}
      </fetcher.Form>
    </Card>
  );
}

function DeletedVersionRow({ version, npm }: { version: PackageVersion; npm: boolean }) {
  const fetcher = useFetcher<SettingsOutcome>();
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          {npm ? (
            <span className="font-mono text-sm font-medium">{version.version}</span>
          ) : (
            <Hint label={version.digest}>
              <code className="font-mono text-sm">{shortDigest(version.digest)}</code>
            </Hint>
          )}
          {version.tags.map((tag) => (
            <Badge key={tag} className="font-mono">
              {tag}
            </Badge>
          ))}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-faint tabular-nums">
          <span>{formatBytes(version.size)}</span>
          {version.deleted_at && (
            <span>
              Deleted {version.deleted_by ? `by ${version.deleted_by} ` : ""}
              <TimeAgo at={version.deleted_at} />
            </span>
          )}
          {version.purge_at && <span>Purged {new Date(version.purge_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
        </p>
        {fetcher.data?.error && <ErrorText>{fetcher.data.error}</ErrorText>}
      </div>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="restore-version" />
        <input type="hidden" name="version" value={version.id} />
        <SubmitButton variant="outline" fetcher={fetcher} match={{ intent: "restore-version", version: version.id }} pending="Restoring…">
          <RotateCcw size={14} />
          Restore
        </SubmitButton>
      </fetcher.Form>
    </li>
  );
}

/** The Settings tab's outline while it loads. */
export function PackageSettingsSkeleton() {
  return (
    <div aria-hidden="true" className="max-w-4xl space-y-8">
      {[3, 2, 1].map((rows, index) => (
        <div key={index} className="grid gap-x-10 gap-y-4 border-t border-line pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr]">
          <div className="space-y-2">
            <SkeletonLine className="w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Card tone="plain">
            <SkeletonRows rows={rows} rowClassName="h-14" />
          </Card>
        </div>
      ))}
    </div>
  );
}
