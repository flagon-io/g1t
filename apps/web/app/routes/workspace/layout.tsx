import { CreditCard, KeyRound, LayoutGrid, Plug, Plus, Settings, Users } from "lucide-react";
import { Outlet, data, useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/layout";
import { Avatar, ButtonLink, Pill, TabLink } from "../../components/ui";
import { identity } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

export function meta({ loaderData, params }: Route.MetaArgs) {
  return [{ title: `${loaderData?.workspace.name ?? params.owner} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  return { workspace, role: roleIn(getViewer(context), workspace.slug) };
}

/** A workspace's own pages, each with its title and what it is for. */
const PAGES: Record<string, { title: string; about: string }> = {
  settings: { title: "General", about: "The workspace's name, address and description." },
  people: {
    title: "Members",
    about: "Members create repositories, push, manage issues and merge pull requests. Owners also manage members, tokens, billing and integrations.",
  },
  tokens: {
    title: "Access tokens",
    about: "Tokens that belong to the workspace, not a person: for CI, integrations and agents that work for the whole team.",
  },
  usage: { title: "Usage", about: "What the workspace's agents cost, run by run, by repository, pull request and model." },
  billing: { title: "Billing", about: "Agent credit, and every charge against it." },
  integrations: {
    title: "Integrations",
    about: "Model providers, alerts and trackers. Secrets are sealed when saved, and agents never see them.",
  },
};

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { workspace, role } = loaderData;
  const base = `/${workspace.slug}`;
  const signedIn = useRouteLoaderData("root")?.user != null;
  // The sidebar finds the workspace's pages for someone signed in, so its
  // pages need a title, not the workspace's whole header again.
  const page = PAGES[useLocation().pathname.split("/-/")[1]?.split("/")[0] ?? ""];
  if (signedIn && page) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
        <header className="mb-8 border-b border-line pb-6">
          <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
          <p className="mt-1.5 text-sm text-muted">{page.about}</p>
        </header>
        <Outlet />
      </div>
    );
  }
  return (
    <>
      {/* The workspace's own header band, under the site header. */}
      <div className="border-b border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-4 pt-8">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={workspace.slug} size={52} square />
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {workspace.name}
                </h1>
                {role && <Pill>{role}</Pill>}
              </div>
              <p className="font-mono text-sm text-muted">g1t.sh/{workspace.slug}</p>
            </div>
            {role && (
              <ButtonLink to={`/new?workspace=${workspace.slug}`}>
                <Plus size={15} />
                New repository
              </ButtonLink>
            )}
          </div>
          {workspace.description && (
            <p className="mt-4 max-w-2xl text-sm text-muted">{workspace.description}</p>
          )}
          {signedIn ? (
            <div className="pb-8" />
          ) : (
          <nav className="mt-6 flex flex-wrap gap-x-6">
            <TabLink to={base} end icon={<LayoutGrid size={15} />}>
              Overview
            </TabLink>
            {role && (
              <>
                <TabLink
                  to={`${base}/-/people`}
                  icon={<Users size={15} />}
                  count={workspace.memberCount}
                >
                  People
                </TabLink>
                <TabLink to={`${base}/-/tokens`} icon={<KeyRound size={15} />}>
                  Access tokens
                </TabLink>
                <TabLink to={`${base}/-/billing`} icon={<CreditCard size={15} />}>
                  Billing
                </TabLink>
                <TabLink to={`${base}/-/integrations`} icon={<Plug size={15} />}>
                  Integrations
                </TabLink>
              </>
            )}
            {role === "owner" && (
              <TabLink to={`${base}/-/settings`} icon={<Settings size={15} />}>
                Settings
              </TabLink>
            )}
          </nav>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </div>
    </>
  );
}
