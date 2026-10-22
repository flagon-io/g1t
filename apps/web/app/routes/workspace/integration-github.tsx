import { ArrowUpRight, Download } from "lucide-react";
import { Link } from "react-router";

import type { Route } from "./+types/integration-github";
import { Unavailable } from "../../components/boundary";
import { ConnectorMark } from "../../components/connectors";
import { ButtonLink } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { githubApp } from "../../lib/github.server";
import { page } from "../../lib/meta";
import { isFailed, part } from "../../lib/partial";
import { requireUser, roleIn } from "../../lib/session.server";
import { settingsPath } from "../../lib/workspace-nav";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `GitHub · Integrations · ${params.owner} · g1t` });
}

/**
 * GitHub, as one of the workspace's integrations: the accounts g1t's
 * GitHub App is installed on for it, and the way to import their
 * repositories. Opened from Apps and the integrations directory, it stays
 * among the integrations; importing is the step that goes on to Code.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const status = await part(githubApp.status(viewer, slug), "The GitHub App");
  return {
    slug,
    owner: role === "owner",
    status: isFailed(status) ? status : status.ok ? status.value : null,
  };
}

export default function GithubIntegration({ loaderData }: Route.ComponentProps) {
  const { slug, owner, status } = loaderData;
  const importPath = `/new/github?workspace=${slug}`;
  return (
    <div className="max-w-3xl space-y-8">
      <header className="flex items-start gap-4">
        <ConnectorMark view={{ id: "github", name: "GitHub", provider: null }} size={44} />
        <div className="min-w-0 grow">
          <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
          <p className="mt-1 text-sm text-muted">
            Import repositories, with their branches, tags and issues, through g1t&apos;s GitHub App. Each person can also connect their own GitHub account,
            under{" "}
            <Link to="/settings/github" className="text-fg underline underline-offset-4">
              their settings
            </Link>
            .
          </p>
        </div>
        <ButtonLink to={importPath}>
          <Download size={14} />
          Import repositories
        </ButtonLink>
      </header>

      {isFailed(status) ? (
        <Unavailable what={status.what} />
      ) : !status ? (
        <Unavailable what="The GitHub App" />
      ) : !status.configured ? (
        <Card className="p-5 text-sm text-muted">This g1t has no GitHub App set up. Whoever runs it adds one first.</Card>
      ) : (
        <Card asChild className="overflow-hidden">
          <section>
            <header className="flex items-center gap-2 border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Installed on</h2>
              {owner && status.installUrl && (
                <a href={status.installUrl} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
                  Install on another account <ArrowUpRight size={12} />
                </a>
              )}
            </header>
            {status.installations.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">
                Not installed for {slug} yet. {owner ? "Install it on a GitHub account or organization to import its repositories." : "An owner installs it."}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {status.installations.map((installation) => (
                  <li key={installation.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                    <span className="font-medium text-fg">{installation.account}</span>
                    <span className="text-xs text-faint">
                      {installation.accountType === "Organization" ? "Organization" : "Account"} ·{" "}
                      {installation.repositorySelection === "all" ? "every repository" : "chosen repositories"}
                    </span>
                    {installation.suspended && <Badge size="md">suspended on GitHub</Badge>}
                    <span className="ml-auto flex items-center gap-3 text-xs">
                      <Link to={`${importPath}&installation=${installation.id}`} className="text-muted hover:text-fg">
                        Import from it
                      </Link>
                      <a href={installation.settingsUrl} className="inline-flex items-center gap-1 text-muted hover:text-fg">
                        Manage on GitHub <ArrowUpRight size={12} />
                      </a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Card>
      )}

      <p className="text-xs text-faint">
        <Link to={settingsPath(slug, "integrations")} className="hover:text-fg">
          All integrations
        </Link>
      </p>
    </div>
  );
}
