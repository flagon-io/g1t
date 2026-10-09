import { useLocation } from "react-router";

/** Each of a project's settings pages: its name and what it is for. */
const PAGES: Record<string, { title: string; about: string }> = {
  "": { title: "General", about: "The project's name, where its code lives, and what it is for." },
  deployments: { title: "Deployments", about: "How the project builds, where it runs, and its previews." },
  domains: { title: "Domains", about: "Addresses of your own for the production deployment." },
  agents: { title: "Agents", about: "How g1t picks up work here, and what it reads first." },
  guardrails: { title: "Guardrails", about: "What agents may reach, run and spend while they work here." },
  repository: { title: "Repository", about: "Its name, details and default branch, who can see it, and archiving, moving or deleting it." },
  mirroring: { title: "Mirroring", about: "Copies of this repository on other hosts: which one leads, taking over and handing back, and remotes that follow it." },
  access: { title: "Access", about: "Who can see and change the repository, with which role, and invitations to it." },
  keys: { title: "Deploy keys", about: "SSH keys that let a machine clone this repository, or push to it, and reach nothing else." },
  branches: { title: "Branches and merging", about: "How pull requests merge, what g1t's agents do with theirs, and who owns which files." },
  rules: { title: "Rules", about: "Rulesets: what may happen to branches and tags, what a pull request needs before it merges, and how the rules judged each push and merge." },
  secrets: { title: "Secrets and variables", about: "Values workflows, builds and deployments read at run time." },
  actions: { title: "Actions", about: "What workflows' tokens may do, and whose pull requests' runs wait for approval." },
  environments: { title: "Environments", about: "Protection rules for the environments jobs deploy to: reviews, wait timers and branches." },
  runners: { title: "Runners", about: "Machines of your own for this project's workflow jobs, and where its agents' work runs." },
  webhooks: { title: "Webhooks", about: "Addresses g1t calls when something happens in the project." },
};

/**
 * The heading of a project's settings page, named from the address. The
 * pages themselves are listed in the sidebar while you are in settings.
 */
export function RepoSettingsHeading({ base }: { base: string }) {
  const { pathname } = useLocation();
  const section = pathname.slice(`${base}/settings`.length).replace(/^\//, "").split("/")[0] ?? "";
  const page = PAGES[section] ?? PAGES[""]!;
  return (
    <header className="mb-8 border-b border-line pb-5">
      <h1 className="text-lg font-semibold tracking-tight">{page.title}</h1>
      <p className="mt-1 text-sm text-muted">{page.about}</p>
    </header>
  );
}
