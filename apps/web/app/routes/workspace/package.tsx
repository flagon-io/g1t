import { BookOpen, Box, Trash2 } from "lucide-react";
import { Form, Link, data, redirect, useNavigation } from "react-router";

import { ECOSYSTEMS, type Ecosystem, type PackageVersion } from "@g1t/contracts";

import type { Route } from "./+types/package";
import { Markdown } from "../../components/markdown";
import { PackageIcon } from "../../components/package-icon";
import { ConfirmDialog } from "../../components/repo-lifecycle";
import { Button, CopyLine, ErrorText, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { page } from "../../lib/meta";
import { ECOSYSTEM_LABEL, formatBytes, installCommands, shortDigest } from "../../lib/packages";
import { packages } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";

function ecosystemOf(value: string | undefined): Ecosystem {
  if (value && (ECOSYSTEMS as readonly string[]).includes(value)) return value as Ecosystem;
  throw data(null, { status: 404 });
}

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params["*"]} · Packages · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const ecosystem = ecosystemOf(params.ecosystem);
  const name = params["*"] ?? "";
  const found = await packages.get(params.owner, ecosystem, name, viewer);
  // Not found and not allowed look the same.
  if (!found.ok) throw data(null, { status: 404 });
  return { detail: found.value, username: viewer?.username ?? "you" };
}

type Outcome = { error: string | null; message: string | null };

export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome | Response> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const ecosystem = ecosystemOf(params.ecosystem);
  const name = params["*"] ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (message: string): Outcome => ({ error: message, message: null });
  if (intent === "delete-version") {
    const version = String(form.get("version") ?? "");
    const done = await packages.deleteVersion(user, params.owner, ecosystem, name, version, "web");
    return done.ok ? { error: null, message: `Deleted ${shortDigest(version)} and its tags.` } : fail(done.error.message);
  }
  if (intent === "delete-package") {
    const done = await packages.deletePackage(user, params.owner, ecosystem, name, "web");
    if (!done.ok) return fail(done.error.message);
    return redirect(`/${params.owner}/-/packages`);
  }
  if (intent === "visibility") {
    const visibility = form.get("visibility") === "public" ? "public" : "private";
    const done = await packages.set(user, params.owner, ecosystem, name, { visibility }, "web");
    return done.ok ? { error: null, message: `It is ${visibility} now.` } : fail(done.error.message);
  }
  if (intent === "link") {
    const repo = String(form.get("repo") ?? "").trim();
    const done = repo
      ? await packages.set(user, params.owner, ecosystem, name, { link: repo }, "web")
      : await packages.set(user, params.owner, ecosystem, name, { unlink: true }, "web");
    return done.ok ? { error: null, message: repo ? `Linked to ${repo}.` : "Unlinked." } : fail(done.error.message);
  }
  return fail("That is not something this page does.");
}

export default function PackagePage({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, username } = loaderData;
  const { package: pkg, versions, tags, permissions } = detail;
  const outcome = actionData as Outcome | undefined;
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
      <header className="space-y-3">
        <Link to={`/${pkg.workspace}/-/packages`} className="text-sm text-muted hover:text-fg">
          Packages
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <PackageIcon ecosystem={pkg.ecosystem} size={32} />
          <h1 className="text-2xl font-semibold tracking-tight">{pkg.name}</h1>
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
            {npm ? (pkg.downloads === 1 ? "download" : "downloads") : pkg.downloads === 1 ? "pull" : "pulls"}
          </span>
          <span>
            Updated <TimeAgo at={pkg.updated_at} />
          </span>
        </p>
        {pkg.description && <p className="max-w-2xl text-sm text-fg-soft">{pkg.description}</p>}
      </header>

      {outcome?.error && <ErrorText>{outcome.error}</ErrorText>}
      {outcome?.message && <p className="text-sm text-accent">{outcome.message}</p>}

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
            <Markdown
              source={detail.readme}
              repo={pkg.repo ? { namespace: pkg.repo.namespace, name: pkg.repo.name } : undefined}
            />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Versions <span className="font-normal text-faint">{images.length}</span>
        </h2>
        {fromGit && (
          <p className="text-xs text-faint">
            Each tag of {pkg.repo ? `${pkg.repo.namespace}/${pkg.repo.name}` : "its repository"} that reads as a version, and each
            branch as <code className="font-mono">dev-</code>, from its composer.json. Push a tag to publish one; delete it to take it away.
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
              />
            ))}
          </ul>
        )}
      </section>

      {permissions.admin && <Settings detail={detail} />}
    </div>
  );
}

function VersionRow({
  version,
  attached,
  canDelete,
  npm,
}: {
  version: PackageVersion;
  attached: PackageVersion[];
  canDelete: boolean;
  npm: boolean;
}) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {npm && <span className="font-mono text-sm font-medium">{version.version}</span>}
          {npm ? (
            version.tags.map((tag) => (
              <Badge key={tag} tone={tag === "latest" ? "accent" : "neutral"} className="font-mono">
                {tag}
              </Badge>
            ))
          ) : version.tags.length > 0 ? (
            version.tags.map((tag) => (
              <Badge key={tag} tone={tag === "latest" ? "accent" : "neutral"} className="font-mono">
                {tag}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-faint">Untagged</span>
          )}
          {!npm && (
            <code className="font-mono text-xs text-muted" title={version.digest}>
              {shortDigest(version.digest)}
            </code>
          )}
          {version.deprecated && (
            <Badge tone="neutral" title={version.deprecated}>
              Deprecated
            </Badge>
          )}
        </div>
        {version.deprecated && <p className="text-xs text-muted">{version.deprecated}</p>}
        <p className="flex flex-wrap gap-x-3 text-xs text-faint tabular-nums">
          <span>{formatBytes(version.size)}</span>
          {version.platforms.length > 0 && <span>{version.platforms.join(", ")}</span>}
          {attached.length > 0 && (
            <span title={attached.map((a) => a.artifact_type ?? a.media_type ?? "artifact").join(", ")}>
              {attached.length} attached ({attached.map((a) => artifactWord(a)).join(", ")})
            </span>
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
            <button type="button" onClick={open} aria-label="Delete version" className="rounded-md p-1.5 text-faint hover:bg-raised hover:text-danger">
              <Trash2 size={14} />
            </button>
          )}
        >
          <li>Its tags go with it.</li>
          <li>Files no other version uses are removed within a day.</li>
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

function Settings({ detail }: { detail: Route.ComponentProps["loaderData"]["detail"] }) {
  const { package: pkg } = detail;
  const busy = useNavigation().state !== "idle";
  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold">Settings</h2>
      {pkg.repo ? (
        <p className="text-sm text-muted">
          Linked to{" "}
          <Link to={`/${pkg.repo.namespace}/${pkg.repo.name}`} className="text-fg-soft hover:text-fg">
            {pkg.repo.namespace}/{pkg.repo.name}
          </Link>
          : it has the repository's visibility and roles.
        </p>
      ) : (
        <Form method="post" className="flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="intent" value="visibility" />
          <span className="text-muted">Visibility</span>
          <select
            name="visibility"
            defaultValue={pkg.visibility}
            className="h-8 rounded-md border border-line bg-bg px-2 text-sm"
            aria-label="Visibility"
          >
            <option value="private">Private: workspace members</option>
            <option value="public">Public: anyone can pull</option>
          </select>
          <Button type="submit" variant="quiet" disabled={busy}>
            Save
          </Button>
        </Form>
      )}
      <Form method="post" className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="intent" value="link" />
        <label className="text-muted" htmlFor="link-repo">
          Repository
        </label>
        <input
          id="link-repo"
          name="repo"
          defaultValue={pkg.repo?.name ?? ""}
          placeholder="none"
          className="h-8 w-56 rounded-md border border-line bg-bg px-2 font-mono text-sm placeholder:text-faint"
        />
        <Button type="submit" variant="quiet" disabled={busy}>
          {pkg.repo ? "Change link" : "Link"}
        </Button>
        <span className="text-xs text-faint">Empty to unlink. A linked package takes the repository's access.</span>
      </Form>
      {detail.permissions.delete && (
        <div className="border-t border-line pt-4">
          <ConfirmDialog
            intent="delete-package"
            title={`Delete ${pkg.name}?`}
            description="Every version and tag goes, and anyone pulling it gets an error."
            confirm={pkg.name}
            submit="Delete package"
            busy="Deleting…"
            trigger={(open) => (
              <Button type="button" variant="danger" onClick={open}>
                Delete package
              </Button>
            )}
          >
            <li>{detail.versions.length} versions and their tags.</li>
            <li>The name can be pushed again afterwards.</li>
          </ConfirmDialog>
        </div>
      )}
    </section>
  );
}
