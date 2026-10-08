import { BookOpen, Box, Trash2 } from "lucide-react";
import { Link, data, redirect, useLocation, useNavigation } from "react-router";

import { ECOSYSTEMS, type Ecosystem, type PackageGrantee, type PackageRole, type PackageSettings, type PackageVersion, PACKAGE_RESTORE_DAYS } from "@g1t/contracts";

import type { Route } from "./+types/package";
import { Markdown } from "../../components/markdown";
import { PackageIcon } from "../../components/package-icon";
import { PackageSettingsSkeleton, PackageSettingsTab, type SettingsOutcome } from "../../components/package-settings";
import { ConfirmDialog } from "../../components/repo-lifecycle";
import { CopyLine, ErrorText, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Hint } from "../../components/ui/hint";
import { Loading } from "../../components/ui/skeleton";
import { TabStrip } from "../../components/ui/tab-strip";
import { page } from "../../lib/meta";
import { ECOSYSTEM_LABEL, formatBytes, installCommands, shortDigest } from "../../lib/packages";
import { packages } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

function ecosystemOf(value: string | undefined): Ecosystem {
  if (value && (ECOSYSTEMS as readonly string[]).includes(value)) return value as Ecosystem;
  throw data(null, { status: 404 });
}

type Tab = "overview" | "settings";

function tabOf(search: string): Tab {
  return new URLSearchParams(search).get("tab") === "settings" ? "settings" : "overview";
}

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params["*"]} · Packages · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const ecosystem = ecosystemOf(params.ecosystem);
  const name = params["*"] ?? "";
  const tab = tabOf(new URL(request.url).search);
  const found = await packages.get(params.owner, ecosystem, name, viewer);
  // Not found and not allowed look the same.
  if (!found.ok) throw data(null, { status: 404 });
  let settings: PackageSettings | null = null;
  if (tab === "settings") {
    // Only the package's admins have a Settings tab.
    if (!found.value.permissions.admin) throw redirect(`/${params.owner}/-/packages/${ecosystem}/${name}`);
    const got = await packages.settings(params.owner, ecosystem, name, viewer);
    if (!got.ok) throw data(null, { status: 404 });
    settings = got.value;
  }
  return { detail: found.value, username: viewer?.username ?? "you", tab, settings };
}

/** Who an access change names: a person by username, or a team by slug. */
function grantee(form: FormData): PackageGrantee | null {
  const kind = String(form.get("kind") ?? "");
  const user = String(form.get("user") ?? (kind === "user" ? form.get("who") : "") ?? "").trim();
  const team = String(form.get("team") ?? (kind === "team" ? form.get("who") : "") ?? "").trim();
  if (user) return { user };
  if (team) return { team };
  return null;
}

function roleOf(form: FormData): PackageRole | null {
  const role = String(form.get("role") ?? "");
  return role === "read" || role === "write" || role === "admin" ? role : null;
}

export async function action({ request, params, context }: Route.ActionArgs): Promise<SettingsOutcome | Response> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const ecosystem = ecosystemOf(params.ecosystem);
  const name = params["*"] ?? "";
  const ws = params.owner;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (message: string): SettingsOutcome => ({ error: message, message: null });
  const done = (result: { ok: true } | { ok: false; error: { message: string } }, message: string): SettingsOutcome =>
    result.ok ? { error: null, message } : fail(result.error.message);
  switch (intent) {
    case "delete-version": {
      const version = String(form.get("version") ?? "");
      return done(
        await packages.deleteVersion(user, ws, ecosystem, name, version, "web"),
        `Deleted ${shortDigest(version)} and its tags. An admin can restore it from Settings for ${PACKAGE_RESTORE_DAYS} days.`,
      );
    }
    case "delete-package": {
      const deleted = await packages.deletePackage(user, ws, ecosystem, name, "web");
      if (!deleted.ok) return fail(deleted.error.message);
      return redirect(`/${ws}/-/packages?view=deleted`);
    }
    case "restore-version": {
      const version = String(form.get("version") ?? "");
      const restored = await packages.restoreVersion(user, ws, ecosystem, name, version, "web");
      return done(restored, restored.ok ? `Restored ${shortDigest(restored.value.version)}.` : "");
    }
    case "visibility": {
      const visibility = form.get("visibility") === "public" ? "public" : "private";
      return done(await packages.set(user, ws, ecosystem, name, { visibility }, "web"), `It is ${visibility} now.`);
    }
    case "link": {
      const repo = String(form.get("repo") ?? "").trim();
      if (!repo) return fail("Name a repository of the workspace to link it to.");
      return done(await packages.set(user, ws, ecosystem, name, { link: repo }, "web"), `Linked to ${repo}.`);
    }
    case "unlink":
      return done(await packages.set(user, ws, ecosystem, name, { unlink: true }, "web"), "Unlinked: it is the workspace's now.");
    case "inherit": {
      const on = form.get("inherit") === "on";
      return done(
        await packages.set(user, ws, ecosystem, name, { inheritAccess: on }, "web"),
        on ? "It inherits access from its repository again." : "It no longer inherits access from its repository.",
      );
    }
    case "access-add":
    case "access-role": {
      const who = grantee(form);
      const role = roleOf(form);
      if (!who) return fail("Name a person by username, or a team by its slug.");
      if (!role) return fail("Choose a role: read, write or admin.");
      const label = "user" in who ? who.user : `the team ${who.team}`;
      return done(await packages.setAccess(user, ws, ecosystem, name, who, role, "web"), `${label} has the ${role} role.`);
    }
    case "access-remove": {
      const who = grantee(form);
      if (!who) return fail("Name a person by username, or a team by its slug.");
      return done(await packages.removeAccess(user, ws, ecosystem, name, who, "web"), "Removed.");
    }
    case "actions-add":
    case "actions-role": {
      const repo = String(form.get("repo") ?? "").trim();
      const role = form.get("role") === "write" ? "write" : "read";
      if (!repo) return fail("Name a repository of the workspace.");
      return done(
        await packages.setActionsAccess(user, ws, ecosystem, name, repo, role, "web"),
        `Workflows in ${repo} may ${role === "write" ? "publish" : "pull"} it.`,
      );
    }
    case "actions-remove": {
      const repo = String(form.get("repo") ?? "").trim();
      return done(await packages.removeActionsAccess(user, ws, ecosystem, name, repo, "web"), `Workflows in ${repo} can no longer use it.`);
    }
  }
  return fail("That is not something this page does.");
}

export default function PackagePage({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, settings } = loaderData;
  const { package: pkg, permissions } = detail;
  const outcome = actionData as SettingsOutcome | undefined;
  const navigation = useNavigation();
  const { pathname } = useLocation();
  // The tab being opened shows at once, its outline until its content
  // follows; a form posted on the page keeps the page as it is meanwhile.
  const switching = navigation.state === "loading" && !navigation.formMethod && navigation.location.pathname === pathname;
  const going = switching && tabOf(navigation.location.search) !== loaderData.tab ? tabOf(navigation.location.search) : null;
  const tab = going ?? loaderData.tab;
  const base = `/${pkg.workspace}/-/packages/${pkg.ecosystem}/${pkg.name}`;
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link to={`/${pkg.workspace}/-/packages`} className="text-sm text-muted hover:text-fg">
          Packages
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <PackageIcon ecosystem={pkg.ecosystem} size={32} />
          <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-all">{pkg.name}</h1>
          <Badge>{ECOSYSTEM_LABEL[pkg.ecosystem]}</Badge>
          <Badge>{pkg.visibility === "private" ? "Private" : "Public"}</Badge>
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted tabular-nums">
          {pkg.repo && (
            <Link to={`/${pkg.repo.namespace}/${pkg.repo.name}`} className="inline-flex items-center gap-1 hover:text-fg">
              <Box size={13} />
              {pkg.repo.namespace}/{pkg.repo.name}
            </Link>
          )}
          <span>{formatBytes(pkg.size)}</span>
          <span>
            {pkg.downloads.toLocaleString("en-US")}{" "}
            {pkg.ecosystem !== "container" ? (pkg.downloads === 1 ? "download" : "downloads") : pkg.downloads === 1 ? "pull" : "pulls"}
          </span>
          <span>
            Updated <TimeAgo at={pkg.updated_at} />
          </span>
        </p>
        {pkg.description && <p className="max-w-2xl text-sm text-fg-soft">{pkg.description}</p>}
      </header>

      {permissions.admin && (
        <TabStrip label="Package" className="gap-1 border-b border-line">
          {(["overview", "settings"] as const).map((name) => (
            <Link
              key={name}
              to={name === "overview" ? base : `${base}?tab=settings`}
              preventScrollReset
              aria-current={tab === name ? "page" : undefined}
              data-active={tab === name || undefined}
              className={`-mb-px border-b-2 px-3 pt-1 pb-2.5 text-sm transition-colors ${
                tab === name ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {name === "overview" ? "Overview" : "Settings"}
            </Link>
          ))}
        </TabStrip>
      )}

      {tab === "settings" ? (
        settings && !going ? (
          <PackageSettingsTab settings={settings} outcome={outcome} />
        ) : (
          <Loading label="Loading the package's settings…">
            <PackageSettingsSkeleton />
          </Loading>
        )
      ) : (
        <Overview detail={detail} username={loaderData.username} outcome={going ? undefined : outcome} />
      )}
    </div>
  );
}

function Overview({
  detail,
  username,
  outcome,
}: {
  detail: Route.ComponentProps["loaderData"]["detail"];
  username: string;
  outcome: SettingsOutcome | undefined;
}) {
  const { package: pkg, versions, tags, permissions } = detail;
  // Maven names a version to fetch; the others install their newest without one.
  const latest = tags.find((tag) => tag.tag === "latest")?.tag ?? tags[0]?.tag ?? (pkg.ecosystem === "maven" ? pkg.latest : null);
  const commands = installCommands(pkg, latest, username);
  // npm and Composer versions are numbers; images are digests and tags.
  const npm = pkg.ecosystem !== "container";
  // Composer's versions are the repository's tags and branches: they
  // change in git, not here.
  const fromGit = pkg.ecosystem === "composer";
  // Signatures and attestations hang off the images they describe.
  const images = versions.filter((version) => !version.subject);
  const attached = (digest: string) => versions.filter((version) => version.subject === digest);
  return (
    <div className="space-y-8">
      {outcome?.error && <ErrorText>{outcome.error}</ErrorText>}
      {outcome?.message && <p className="text-sm text-success">{outcome.message}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{npm ? "Install it" : "Pull it"}</h2>
        {commands.registry && <CopyLine prompt text={commands.registry} />}
        {pkg.visibility === "private" && <CopyLine prompt text={commands.login} />}
        <CopyLine prompt text={commands.install} />
        {commands.registry && pkg.visibility === "private" && pkg.ecosystem === "cargo" && (
          <p className="text-xs text-faint">
            <code className="font-mono">cargo login</code> asks for an{" "}
            <Link to="/settings/tokens" className="text-muted hover:text-fg">
              access token
            </Link>{" "}
            with <code className="font-mono">packages:read</code>.
          </p>
        )}
        {pkg.visibility === "private" && commands.login.includes("YOUR_TOKEN") && (
          <p className="text-xs text-faint">
            Put an{" "}
            <Link to="/settings/tokens" className="text-muted hover:text-fg">
              access token
            </Link>{" "}
            with <code className="font-mono">packages:read</code> in place of YOUR_TOKEN.
          </p>
        )}
      </section>

      {detail.readme && (
        <section className="overflow-hidden rounded-xl border border-line">
          <h2 className="flex items-center gap-2 border-b border-line bg-surface px-4 py-2.5 text-sm font-medium">
            <BookOpen size={15} className="text-faint" />
            README
          </h2>
          <div className="p-6">
            <Markdown source={detail.readme} repo={pkg.repo ? { namespace: pkg.repo.namespace, name: pkg.repo.name } : undefined} />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Versions <span className="font-normal text-faint">{images.length}</span>
        </h2>
        {fromGit && (
          <p className="text-xs text-faint">
            Each tag of {pkg.repo ? `${pkg.repo.namespace}/${pkg.repo.name}` : "its repository"} that reads as a version, and each branch as{" "}
            <code className="font-mono">dev-</code>, from its composer.json. Push a tag to publish one; delete it to take it away.
          </p>
        )}
        {images.length === 0 ? (
          <p className="text-sm text-muted">No versions are left.</p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {images.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                attached={attached(version.digest)}
                canDelete={permissions.delete && !fromGit}
                npm={npm}
                pulls={!npm}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function VersionRow({
  version,
  attached,
  canDelete,
  npm,
  pulls,
}: {
  version: PackageVersion;
  attached: PackageVersion[];
  canDelete: boolean;
  npm: boolean;
  /** Whether its downloads are pulls, as an image's are. */
  pulls: boolean;
}) {
  const downloads = version.downloads ?? 0;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {npm && <span className="font-mono text-sm font-medium">{version.version}</span>}
          {version.tags.length > 0
            ? version.tags.map((tag) => (
                <Badge key={tag} tone={tag === "latest" ? "accent" : "neutral"} className="font-mono">
                  {tag}
                </Badge>
              ))
            : !npm && <span className="text-xs text-faint">Untagged</span>}
          {!npm && (
            <Hint label={version.digest}>
              <code className="font-mono text-xs text-muted">{shortDigest(version.digest)}</code>
            </Hint>
          )}
          {version.deprecated && (
            <Hint label={version.deprecated}>
              <Badge tone="neutral">Deprecated</Badge>
            </Hint>
          )}
          {version.symbols && (
            <Hint label="A symbol package (.snupkg) was pushed: debuggers load its PDBs from the feed's symbol server.">
              <Badge tone="neutral">Symbols</Badge>
            </Hint>
          )}
        </div>
        {version.deprecated && <p className="text-xs text-muted">{version.deprecated}</p>}
        <p className="flex flex-wrap gap-x-3 text-xs text-faint tabular-nums">
          <span>{formatBytes(version.size)}</span>
          <span>
            {downloads.toLocaleString("en-US")} {pulls ? (downloads === 1 ? "pull" : "pulls") : downloads === 1 ? "download" : "downloads"}
          </span>
          {version.platforms.length > 0 && <span>{version.platforms.join(", ")}</span>}
          {attached.length > 0 && (
            <Hint label={attached.map((a) => a.artifact_type ?? a.media_type ?? "artifact").join(", ")}>
              <span>
                {attached.length} attached ({attached.map((a) => artifactWord(a)).join(", ")})
              </span>
            </Hint>
          )}
          <span>
            {version.published_by ? `${version.published_by} · ` : ""}
            <TimeAgo at={version.published_at} />
          </span>
        </p>
      </div>
      {canDelete && (
        <ConfirmDialog
          intent="delete-version"
          fields={{ version: npm ? version.version : version.digest }}
          title={`Delete ${npm ? version.version : (version.tags[0] ?? shortDigest(version.digest))}?`}
          description={
            npm
              ? "Anyone installing this version gets an error from then on."
              : "Anyone pulling it by this tag or digest gets an error from then on."
          }
          submit="Delete version"
          busy="Deleting…"
          trigger={(open) => (
            <Hint label="Delete this version">
              <button type="button" onClick={open} aria-label="Delete version" className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-danger">
                <Trash2 size={14} />
              </button>
            </Hint>
          )}
        >
          <li>Its tags go with it.</li>
          <li>An admin can restore it from the package's Settings for {PACKAGE_RESTORE_DAYS} days; until then its {npm ? "version" : "digest"} cannot be published again.</li>
        </ConfirmDialog>
      )}
    </li>
  );
}

/** "signature", "SBOM", "attestation", or what the artifact says it is. */
function artifactWord(version: PackageVersion): string {
  const type = version.artifact_type ?? version.media_type ?? "";
  if (/signature|cosign|notary/i.test(type)) return "signature";
  if (/spdx|cyclonedx|sbom/i.test(type)) return "SBOM";
  if (/in-toto|attestation|provenance/i.test(type)) return "attestation";
  return "artifact";
}
