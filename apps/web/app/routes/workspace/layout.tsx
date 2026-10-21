import { Package, Plus } from "lucide-react";
import { Outlet, type ShouldRevalidateFunctionArgs, data, redirect, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/layout";
import { page } from "../../lib/meta";
import { ButtonLink } from "../../components/ui";
import { Avatar } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { WelcomeBanner } from "../../components/welcome";
import { clearWelcome, welcomes } from "../../lib/invites";
import { notFound } from "../../lib/not-found.server";
import { redirectIfRenamed } from "../../lib/renamed.server";
import { changesShell } from "../../lib/shell-changes";
import { rememberWorkspace } from "../../lib/workspace-choice";
import { workspacePage, workspaceRedirect } from "../../lib/workspace-nav";
import { shortcutOf, workspaceProjects } from "../../lib/workspace-projects.server";
import { WorkspacePageSkeleton } from "../../components/workspace-skeletons";
import { WorkTabs, workTab } from "../../components/plan-tabs";
import { identity } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";
import { isFailed, part } from "../../lib/partial";

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
  if (!role) {
    // The workspace is what the frame is about; its projects only fill the
    // sidebar, which goes without them rather than take every page down.
    const listed = await part(workspaceProjects(workspace.slug, viewer), "Repositories");
    return { workspace, role, welcome: false, projects: !isFailed(listed) && listed.ok ? listed.value.map(shortcutOf) : [] };
  }
  const secure = new URL(request.url).protocol === "https:";
  const headers = new Headers({ "Set-Cookie": rememberWorkspace(workspace.slug, secure) });
  // Just joined with an invite: welcomed once (routes/invite.tsx).
  const welcome = welcomes(request.headers.get("cookie"), workspace.slug);
  if (welcome) headers.append("Set-Cookie", clearWelcome(secure));
  return data({ workspace, role, welcome }, { headers });
}

/**
 * The workspace, and the viewer's role in it, change with the workspace
 * or after a submission that changes the frame (lib/shell-changes.ts):
 * not from one of its pages to the next, a filter, or a page refreshing
 * itself. An old address is still sent on to where it moved.
 */
export function shouldRevalidate({
  currentParams,
  nextParams,
  nextUrl,
  formMethod,
  formAction,
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentParams.owner !== nextParams.owner) return true;
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate && changesShell(formAction, formData);
  return Boolean(nextUrl.search && workspaceRedirect(nextUrl.pathname, nextUrl.search));
}

/** A workspace's own pages, each with its title and what it is for. */
const PAGES: Record<string, { title: string; about: string }> = {
  workspace: {
    title: "Workspace",
    about: "Who is in it, what it is on, and what it has spent this month. Everything about the workspace itself is in this sidebar.",
  },
  settings: {
    title: "General",
    about: "The workspace's name, icon, address and description, two-factor authentication, where its data lives, and deleting it.",
  },
  people: {
    title: "People",
    about: "Everyone in the workspace, in one directory: who they are, what they own, the teams they're on and who's around.",
  },
  members: {
    title: "Members",
    about:
      "Who is in the workspace and their roles. Owners invite people, manage members and owners, and see the outside collaborators; what members may do is under Permissions.",
  },
  "members/invitations": {
    title: "Invitations",
    about: "Every invitation to join the workspace: who it is for, who sent it, the role, and where it stands. Send one again, revoke it, or copy its link.",
  },
  permissions: {
    title: "Permissions",
    about: "Who may do what in the workspace, part by part: repositories, teams, chat, artifacts, deployments and packages. Owners only.",
  },
  "code/repositories": {
    title: "Repositories",
    about: "Everything the workspace builds and runs. Search, filter and sort them, and pin the ones you use most to keep them in your sidebar.",
  },
  teams: {
    title: "Teams",
    about: "People with a lead, a channel and roles on repositories. Everyone on a team knows who their teammates are.",
  },
  repositories: {
    title: "Repositories",
    about: "Every repository in the workspace: who can see it, whether it is archived, and the ones deleted recently.",
  },
  tokens: {
    title: "Access tokens",
    about:
      "Tokens that belong to the workspace, not a person: for CI, integrations and coding agents that work for the whole team. Each has the permissions an owner gives it, in all of the workspace's repositories or the ones chosen.",
  },
  "personal-access-tokens": {
    title: "Personal access tokens",
    about:
      "Which of your members' own tokens may reach the workspace and for how long, the tokens made for it that wait for an owner's approval, and every token that can reach it.",
  },
  packages: {
    title: "Packages",
    about:
      "What the workspace publishes and installs, beside its code: container images, npm, Composer, Go, Cargo, Maven, NuGet and RubyGems, with the same members, roles and tokens.",
  },
  work: {
    title: "Work",
    about: "Everything the workspace means to do, features, bugs and chores, numbered once for the whole workspace and linked to the repositories it lands in.",
  },
  "work/new": {
    title: "New work item",
    about: "Say what should change, and pick the repositories it should land in. Whoever works on it, person or agent, works from this text.",
  },
  "work/labels": {
    title: "Labels",
    about: "The workspace's labels, shared by every work item and pull request in it.",
  },
  "work/projects": {
    title: "Projects",
    about: "Homes for bodies of work: each with its brief, its lead and people, its work items, the repositories it lands in, and how it is going.",
  },
  "work/milestones": {
    title: "Milestones",
    about: "Goals with a due date, that work items and pull requests from every repository of the workspace are gathered under.",
  },
  insights: { title: "Insights", about: "Delivery, review times, work in progress and costs across your workspace." },
  usage: { title: "Usage", about: "What the workspace used and what it cost, by product, repository and day." },
  billing: { title: "Billing and plans", about: "The g1t plan, the trial, your spend limit, prepaying, and every charge." },
  audit: {
    title: "Audit log",
    about: "Every change people, tokens and g1t's own runs made: by whom, on whose behalf, to what, and whether it was allowed.",
  },
  guardrails: {
    title: "Guardrails",
    about: "How long every repository's runs may take. Each repository can override these under its settings.",
  },
  webhooks: {
    title: "Webhooks",
    about: "Every repository's events, sent to your own addresses as they happen. A repository can also have its own, under its settings.",
  },
  secrets: {
    title: "Secrets and variables",
    about: "Shared with every repository, or the ones you link: read by workflows, deployments, or both. A repository's own row of the same key wins.",
  },
  security: {
    title: "Security",
    about:
      "Open alerts in every repository: secrets found in pushes and history, and vulnerable dependencies. Each repository's Security page has the details and the security update g1t opened for each.",
  },
  integrations: {
    title: "Integrations",
    about: "The tools your team works with, connected once for everyone in the workspace. Secrets are sealed when saved, and never shown again.",
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

/** Artifacts' pages that are lists, not one artifact. */
const ARTIFACT_LISTS = new Set(["new", "templates", "trash", "stale", "spaces"]);

/** Whether the page (its path after `/-/`, in parts) is one artifact or a project's doc file. */
function isArtifactPage(parts: string[]): boolean {
  if (parts[0] !== "artifacts" || parts.length < 2) return false;
  if (parts[1] === "repo") return true;
  return !ARTIFACT_LISTS.has(parts[1]!) && parts.length === 2;
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
  // Chat fills the page edge to edge: its conversation, thread and details
  // are columns of their own (components/chat/channel.tsx). Its sessions
  // are pages like any other, with the page's margins.
  if (parts[0] === "chat" && parts[1] !== "sessions" && !next) return <Outlet />;
  // Code's Overview lays itself out, as Mission control did.
  if (parts[0] === "overview" && parts.length === 1 && !next) return <Outlet />;
  // An open artifact, or a repository's doc, fills the panel: its header runs edge to edge right under
  // the top bar (components/folios/shell.tsx), and its page sets its own width.
  if (isArtifactPage(parts) && !next) {
    return (
      <div className="px-4 pb-10 sm:px-6 lg:px-8">
        <Outlet />
      </div>
    );
  }
  if (shown !== "overview") {
    // A page of its own under another's address (Invitations under Members) has its own heading.
    const whole = parts.join("/");
    const key = shown ?? (PAGES[whole] ? whole : (parts[0] ?? ""));
    const heading = PAGES[key];
    // Pages within one (a single package or team) have headings of their own.
    const titled = heading && (shown != null || parts.length === 1 || key === whole);
    // Work's views (Plan, Board, Triage, All items, Milestones, Sessions) are its tabs, which name the page.
    const tab = parts[0] === "work" && !next ? workTab(pathname, workspace.slug) : null;
    return (
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-8">
        {tab != null ? <WorkTabs workspace={workspace.slug} /> : titled && <PageHeader title={heading.title} about={heading.about} />}
        {next ? <WorkspacePageSkeleton page={next} /> : <Outlet />}
      </div>
    );
  }
  return (
    <>
      {/* The workspace's own header band, above its overview. */}
      <div className="border-b border-line bg-surface/60">
        <div className="mx-auto max-w-7xl px-4 py-8">
          {welcome && (
            <div className="mb-6">
              <WelcomeBanner title={`You're in ${workspace.name}`}>You joined as a {role}. Its repositories, work and people are all here.</WelcomeBanner>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={workspace.slug} image={workspace.avatar} size={52} square />
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-2xl font-semibold tracking-tight">{workspace.name}</h1>
                <Badge size="md">Workspace</Badge>
                {role && <Badge size="md">{role}</Badge>}
              </div>
              <p className="font-mono text-sm text-muted">g1t.sh/{workspace.slug}</p>
            </div>
            {role ? (
              <ButtonLink to={`/new?workspace=${workspace.slug}`}>
                <Plus size={15} />
                New repository
              </ButtonLink>
            ) : (
              <ButtonLink to={`/${workspace.slug}/-/packages`} variant="outline" prefetch="intent">
                <Package size={15} />
                Packages
              </ButtonLink>
            )}
          </div>
          {workspace.description && <p className="mt-4 max-w-2xl text-sm text-muted">{workspace.description}</p>}
        </div>
      </div>
      <div className="mx-auto max-w-7xl px-4 py-8">{next ? <WorkspacePageSkeleton page="overview" /> : <Outlet />}</div>
    </>
  );
}
