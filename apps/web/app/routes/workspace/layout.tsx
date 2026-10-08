import { Package, Plus } from "lucide-react";
import { Outlet, data, redirect, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/layout";
import { page } from "../../lib/meta";
import { Avatar, ButtonLink, Pill } from "../../components/ui";
import { WelcomeBanner } from "../../components/welcome";
import { clearWelcome, welcomes } from "../../lib/invites";
import { notFound } from "../../lib/not-found.server";
import { redirectIfRenamed } from "../../lib/renamed.server";
import { rememberWorkspace } from "../../lib/workspace-choice";
import { workspacePage, workspaceRedirect } from "../../lib/workspace-nav";
import { WorkspacePageSkeleton } from "../../components/workspace-skeletons";
import { identity } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

export function meta({ loaderData, params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${loaderData?.workspace.name ?? params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // `?tab=projects` and the like, from the tabs this page once had: that
  // page's own address.
  const moved = url.search ? workspaceRedirect(url.pathname, url.search) : null;
  if (moved) throw redirect(moved);
  const viewer = getViewer(context);
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) {
    // A workspace's old name, after a rename: its pages are at the new one.
    await redirectIfRenamed(request, params.owner);
    throw notFound("workspace");
  }
  const role = roleIn(viewer, workspace.slug);
  // Opening one of your workspaces makes it the one you are in.
  if (!role) return { workspace, role, welcome: false };
  const secure = new URL(request.url).protocol === "https:";
  const headers = new Headers({ "Set-Cookie": rememberWorkspace(workspace.slug, secure) });
  // Just joined with an invite: welcomed once (routes/invite.tsx).
  const welcome = welcomes(request.headers.get("cookie"), workspace.slug);
  if (welcome) headers.append("Set-Cookie", clearWelcome(secure));
  return data({ workspace, role, welcome }, { headers });
}

/** A workspace's own pages, each with its title and what it is for. */
const PAGES: Record<string, { title: string; about: string }> = {
  settings: { title: "General", about: "The workspace's name, icon, address and description, and deleting it." },
  people: {
    title: "People",
    about: "Members create repositories and have the base permission on each one. Owners are Admins on every repository, and also manage members, tokens, billing and integrations.",
  },
  projects: {
    title: "Projects",
    about: "Everything the workspace builds and runs. Search, filter and sort them, and pin the ones you use most to keep them in your sidebar.",
  },
  teams: {
    title: "Teams",
    about: "Groups of members, given roles on repositories together, mentioned as @workspace/team and asked to review together. Child teams inherit their parent's access.",
  },
  repositories: {
    title: "Repositories",
    about: "Every repository in the workspace: who can see it, whether it is archived, and the ones deleted recently.",
  },
  tokens: {
    title: "Access tokens",
    about: "Tokens that belong to the workspace, not a person: for CI, integrations and agents that work for the whole team.",
  },
  packages: {
    title: "Packages",
    about: "What the workspace publishes and installs, beside its code: container images, npm, Composer, Go, Cargo, Maven, NuGet and RubyGems, with the same members, roles and tokens.",
  },
  usage: { title: "Usage", about: "What the workspace's agents cost, run by run, by repository, pull request and model." },
  billing: { title: "Billing and plans", about: "The g1t plan, the trial, your spend limit and caps, prepaying, and every charge." },
  agents: {
    title: "Agent fleet",
    about: "Every agent at work across the workspace's projects: what each holds, what it is doing now, and what it has cost.",
  },
  memory: {
    title: "Workspace memory",
    about: "What holds across all of the workspace's projects, given to every agent in every one of them, beside each project's own memory.",
  },
  context: {
    title: "Context",
    about: "Everything the workspace builds and runs, and what it knows: a catalog built from its projects, memory with a review queue, one search over all of it, and a scorecard for each project.",
  },
  audit: {
    title: "Audit log",
    about: "Every action agents took with their run credentials, and every change people and tokens made: by whom, on whose behalf, to what, and whether it was allowed.",
  },
  guardrails: {
    title: "Guardrails",
    about: "What agents may reach, run, spend and take in every project's sandboxes. Each project can override these under its settings.",
  },
  webhooks: {
    title: "Webhooks",
    about: "Every repository's events, sent to your own addresses as they happen. A repository can also have its own, under its settings.",
  },
  secrets: {
    title: "Secrets and variables",
    about: "Shared with every repository, or the ones you link: read by workflows, deployments, or both. A repository's own row of the same key wins.",
  },
  runners: {
    title: "Self-hosted runners",
    about: "Your own machines, which run workflow jobs, and if you choose agents' work, for free. They connect out to g1t; nothing reaches in.",
  },
  security: {
    title: "Security",
    about: "Open alerts in every project: secrets found in pushes and history, and vulnerable dependencies. Each project's Security page has the details and the security update g1t opened for each.",
  },
  integrations: {
    title: "Integrations",
    about: "Model providers, alerts and trackers. Secrets are sealed when saved, and agents never see them.",
  },
};

/** A workspace page's heading: its title and what it is for. */
function PageHeader({ title, about }: { title: string; about: string }) {
  return (
    <header className="mb-8 border-b border-line pb-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-muted">{about}</p>
    </header>
  );
}

export default function WorkspaceLayout({ loaderData }: Route.ComponentProps) {
  const { workspace, role, welcome } = loaderData;
  const { pathname } = useLocation();
  const going = useNavigation().location;
  // The workspace's own page is its overview. Its other pages are found
  // from the sidebar, which lights the one you are on, and the top bar's
  // trail leads back here; each has a heading of its own.
  const here = workspacePage(pathname, workspace.slug);
  // On the way to another of its pages: that page's heading and shape
  // until it arrives.
  const next = going && going.pathname !== pathname ? workspacePage(going.pathname, workspace.slug) : null;
  const shown = next ?? here;
  const parts = (pathname.split("/-/")[1] ?? "").split("/").filter(Boolean);
  if (shown !== "overview") {
    const key = shown ?? parts[0] ?? "";
    const heading = PAGES[key];
    // A page within one (a single package or team) and a page that is
    // coming (Insights) have headings of their own.
    const titled = heading && (shown != null || parts.length === 1);
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-8">
        {titled && <PageHeader title={heading.title} about={heading.about} />}
        {next ? <WorkspacePageSkeleton page={next} /> : <Outlet />}
      </div>
    );
  }
  return (
    <>
      {/* The workspace's own header band, above its overview. */}
      <div className="border-b border-line bg-surface/60">
        <div className="mx-auto max-w-6xl px-4 py-8">
          {welcome && (
            <div className="mb-6">
              <WelcomeBanner title={`You're in ${workspace.name}`}>
                You joined as a {role}. Its projects, issues and agents are all here.
              </WelcomeBanner>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={workspace.slug} image={workspace.avatar} size={52} square />
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {workspace.name}
                </h1>
                {role && <Pill>{role}</Pill>}
              </div>
              <p className="font-mono text-sm text-muted">g1t.sh/{workspace.slug}</p>
            </div>
            {role ? (
              <ButtonLink to={`/new?workspace=${workspace.slug}`}>
                <Plus size={15} />
                New project
              </ButtonLink>
            ) : (
              // A visitor's sidebar is not this workspace's: its packages
              // are a link here, as its projects are below.
              <ButtonLink to={`/${workspace.slug}/-/packages`} variant="quiet" prefetch="intent">
                <Package size={15} />
                Packages
              </ButtonLink>
            )}
          </div>
          {workspace.description && (
            <p className="mt-4 max-w-2xl text-sm text-muted">{workspace.description}</p>
          )}
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-8">
        {next ? <WorkspacePageSkeleton page="overview" /> : <Outlet />}
      </div>
    </>
  );
}
