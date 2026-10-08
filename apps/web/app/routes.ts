import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  // The second step of signing in, for an account with two-factor authentication.
  route("login/two-factor", "routes/login-two-factor.tsx"),
  route("register", "routes/register.tsx"),
  // An invite link: who sent it, then sign-up or joining. `invite` is reserved.
  route("invite/:code", "routes/invite.tsx"),
  route("logout", "routes/logout.tsx"),
  route("verify", "routes/verify.tsx"),
  route("forgot", "routes/forgot.tsx"),
  route("reset", "routes/reset.tsx"),
  route("device", "routes/device.tsx"),
  route("oauth/authorize", "routes/oauth-authorize.tsx"),
  route("new", "routes/new.tsx"),
  // GitHub: signing in with it, and bringing repositories across through
  // g1t's GitHub App. `auth` and `integrations` are reserved names.
  route("new/github", "routes/new-github.tsx"),
  route("auth/github", "routes/auth-github.ts"),
  route("auth/github/callback", "routes/auth-github-callback.tsx"),
  route("auth/github/username", "routes/auth-github-username.tsx"),
  route("integrations/github/install", "routes/github-install.ts"),
  route("integrations/github/setup", "routes/github-setup.tsx"),
  // Your own settings: one page each, so links can name the one they mean.
  // `/settings` goes to the first; an old link's `#anchor` to its page.
  route("settings", "routes/settings/layout.tsx", [
    index("routes/settings/index.tsx"),
    route("profile", "routes/settings/profile.tsx"),
    route("emails", "routes/settings/emails.tsx"),
    route("notifications", "routes/settings/notifications.tsx"),
    route("invites", "routes/settings/invites.tsx"),
    route("keys", "routes/settings/keys.tsx"),
    route("tokens", "routes/settings/tokens.tsx"),
    route("github", "routes/settings/github.tsx"),
    route("applications", "routes/settings/applications.tsx"),
    route("two-factor", "routes/settings/two-factor.tsx"),
    route("security-log", "routes/settings/security-log.tsx"),
  ]),
  // The account menu's header: name, primary email and invites left.
  route("settings/menu.json", "routes/settings-menu-json.ts"),
  // People, apart from workspaces: `u` is a reserved name.
  route("u/:username", "routes/user.tsx"),
  route("explore", "routes/explore.tsx", { id: "explore" }),
  route("pricing", "routes/pricing.tsx"),
  route("search", "routes/search.tsx"),
  // Each person's inbox, and what its panel in the top bar fetches.
  route("inbox", "routes/inbox.tsx"),
  route("inbox.json", "routes/inbox-json.ts"),
  // What the command palette shows as someone types.
  route("search.json", "routes/search-json.ts"),
  route("workspaces/new", "routes/workspace/new.tsx"),
  // Trust pages: reserved names, like the rest above.
  route("policies", "routes/policies.tsx"),
  route("policies/:policy", "routes/policy.tsx"),
  route("security", "routes/security.tsx"),
  route("support", "routes/support.tsx"),
  // Status moved to status.g1t.sh (apps/status); old links go there.
  route("status", "routes/status.tsx"),
  route("status.json", "routes/status-json.ts"),
  route(".well-known/security.txt", "routes/security-txt.ts"),
  // Releases of the self-hosted runner and the g1t CLI, from R2.
  route("downloads/:tool/*", "routes/downloads-runner.ts"),
  // A workspace's own pages sit under `-`, which no repository can be named.
  route(":owner", "routes/workspace/layout.tsx", [
    index("routes/workspace/overview.tsx"),
    // Its pages, each in the sidebar: Overview (above), Projects, People, Insights; Teams and Packages below.
    route("-/projects", "routes/workspace/projects.tsx"),
    route("-/people", "routes/workspace/people.tsx"),
    route("-/insights", "routes/workspace/tab-soon.tsx", { id: "routes/workspace/insights" }),
    // Pinning its projects, for the person signed in.
    route("-/pins", "routes/workspace/pins.ts"),
    // Pages that moved: Members is People, and the overview is the workspace.
    route("-/members", "routes/workspace/moved.ts", { id: "routes/workspace/moved-members" }),
    route("-/overview", "routes/workspace/moved.ts", { id: "routes/workspace/moved-overview" }),
    // Teams: the list, a new one, and each team's pages.
    route("-/teams", "routes/workspace/teams.tsx"),
    route("-/teams/new", "routes/workspace/team-new.tsx"),
    route("-/teams/:team", "routes/workspace/team/layout.tsx", [
      index("routes/workspace/team/members.tsx"),
      route("teams", "routes/workspace/team/teams.tsx"),
      route("repositories", "routes/workspace/team/repositories.tsx"),
      route("settings", "routes/workspace/team/settings.tsx"),
    ]),
    route("-/tokens", "routes/workspace/tokens.tsx"),
    // Its rules for members' personal access tokens, and approving them.
    route("-/personal-access-tokens", "routes/workspace/personal-access-tokens.tsx"),
    route("-/usage", "routes/workspace/usage.tsx"),
    route("-/gateway", "routes/workspace/gateway.tsx"),
    route("-/billing", "routes/workspace/billing.tsx"),
    route("-/billing/entries", "routes/workspace/statement-entries.ts"),
    route("-/billing/statement.csv", "routes/workspace/statement-csv.ts"),
    route("-/integrations", "routes/workspace/integrations.tsx"),
    route("-/webhooks", "routes/workspace/webhooks.tsx"),
    route("-/secrets", "routes/workspace/secrets.tsx"),
    route("-/runners", "routes/workspace/runners.tsx"),
    route("-/actions", "routes/workspace/actions-settings.tsx"),
    route("-/packages", "routes/workspace/packages.tsx"),
    route("-/packages/:ecosystem/*", "routes/workspace/package.tsx"),
    route("-/settings", "routes/workspace/settings.tsx"),
    route("-/repositories", "routes/workspace/repositories.tsx"),
    route("-/agents", "routes/workspace/agents.tsx"),
    route("-/memory", "routes/workspace/memory.tsx"),
    route("-/context", "routes/workspace/context.tsx"),
    route("-/security", "routes/workspace/security.tsx"),
    route("-/security/patterns", "routes/workspace/security-patterns.tsx"),
    route("-/security/bypass-requests", "routes/workspace/security-bypass.tsx"),
    route("-/security/settings", "routes/workspace/security-settings.tsx"),
    route("-/audit", "routes/workspace/audit.tsx"),
    route("-/audit/export", "routes/workspace/audit-export.ts"),
    route("-/guardrails", "routes/workspace/guardrails.tsx"),
    route("-/rules", "routes/workspace/rules.tsx"),
    route("-/rules/:id", "routes/workspace/ruleset.tsx"),
    // What the workspace will have across its projects.
    route("-/soon/:feature", "routes/workspace/soon.tsx"),
  ]),
  // Why a line is the way it is, fetched by the blame view.
  route(":owner/:repo/why/:hash", "routes/repo/why.ts"),
  // A project's agent runs as JSON, and stopping or messaging one.
  route(":owner/:repo/agents.json", "routes/repo/agents-live.ts"),
  // Its branch names, for changing the branch a pull request merges into.
  route(":owner/:repo/branches.json", "routes/repo/branch-names.ts"),
  // What a project's agent runs did, from the audit log, for the Agent panel.
  route(":owner/:repo/audit.json", "routes/repo/audit-live.ts"),
  // An invitation to a repository, answered by someone who cannot see it yet.
  route(":owner/:repo/invitations", "routes/repo/invitations.tsx"),
  // The Files page's About as JSON, asked again while it is first worked out.
  route(":owner/:repo/about.json", "routes/repo/about-json.ts"),
  // Starring it, from the header's Star button.
  route(":owner/:repo/star", "routes/repo/star.ts"),
  // Subscribing to its issues and pull requests, and watching it.
  route(":owner/:repo/notifications", "routes/repo/notifications.ts"),
  // A starter CI workflow, opened as a pull request (components/add-ci.tsx).
  route(":owner/:repo/add-ci", "routes/repo/add-ci.ts"),
  // A screenshot of a project's production, for its overview.
  route(":owner/:repo/production.jpg", "routes/repo/production-screenshot.ts"),
  // A project: its overview first, its repository's code under Code. The
  // 1:1 project of a repository has the repository's name, so every
  // repository address below keeps working.
  route(":owner/:repo", "routes/repo/layout.tsx", [
    index("routes/repo/overview.tsx"),
    route("code", "routes/repo/code.tsx"),
    route("tree/:ref/*", "routes/repo/tree.tsx"),
    route("blob/:ref/*", "routes/repo/blob.tsx"),
    route("archive/*", "routes/repo/archive.ts"),
    route("commits", "routes/repo/commits.tsx"),
    route("branches", "routes/repo/branches.tsx"),
    route("tags", "routes/repo/tags.tsx"),
    route("releases", "routes/repo/releases.tsx"),
    route("releases/new", "routes/repo/release-new.tsx"),
    route("releases/tag/*", "routes/repo/release.tsx"),
    route("contributors", "routes/repo/contributors.tsx"),
    route("activity", "routes/repo/activity.tsx"),
    route("stargazers", "routes/repo/stargazers.tsx"),
    route("compare/*", "routes/repo/compare.tsx", { id: "routes/repo/compare-range" }),
    route("compare", "routes/repo/compare.tsx"),
    route("commit/:hash", "routes/repo/commit.tsx"),
    // A check run reported on a commit: its report, annotations and buttons.
    route("checks/:id", "routes/repo/check-run.tsx"),
    route("labels", "routes/repo/labels.tsx"),
    route("milestones", "routes/repo/milestones.tsx"),
    route("milestones/:number", "routes/repo/milestone.tsx"),
    route("issues", "routes/repo/issues.tsx"),
    route("issues/new", "routes/repo/issue-new.tsx"),
    route("issues/:number", "routes/repo/issue.tsx"),
    route("pulls", "routes/repo/pulls.tsx"),
    route("pulls/new", "routes/repo/pull-new.tsx"),
    route("pull/:number", "routes/repo/pull.tsx"),
    route("queue", "routes/repo/queue.tsx"),
    route("agents", "routes/repo/agents.tsx"),
    route("usage", "routes/repo/usage.tsx"),
    route("agents/runs/:id", "routes/repo/agents-run.tsx"),
    route("sessions", "routes/repo/sessions.tsx"),
    route("sessions/:number", "routes/repo/session.tsx"),
    route("memory", "routes/repo/memory.tsx"),
    route("actions", "routes/repo/actions.tsx"),
    route("actions/runs/:id", "routes/repo/actions-run.tsx"),
    route("actions/runs/:id/artifacts/:name", "routes/repo/actions-artifact.ts"),
    route("actions/jobs/:job/log", "routes/repo/actions-log.ts"),
    route("actions/jobs/:job/log.txt", "routes/repo/actions-job-log-download.ts"),
    route("actions/runs/:id/logs.zip", "routes/repo/actions-logs-download.ts"),
    route("actions/workflows/:file/badge.svg", "routes/repo/actions-badge.ts"),
    route("deployments", "routes/repo/deployments.tsx"),
    route("deployments/:id", "routes/repo/deployment.tsx"),
    // Security: an overview, then a page for each part. Old links to
    // `security?tab=…` are sent on by the overview.
    route("security", "routes/repo/security-overview.tsx"),
    route("security/secret-scanning", "routes/repo/security-secrets.tsx"),
    route("security/secret-scanning/patterns", "routes/repo/security-patterns.tsx"),
    route("security/secret-scanning/:id", "routes/repo/security-secret.tsx"),
    route("security/code-scanning", "routes/repo/security-code.tsx"),
    route("security/code-scanning/setup", "routes/repo/security-code-setup.ts"),
    route("security/code-scanning/:number", "routes/repo/security-code-alert.tsx"),
    route("security/vulnerabilities", "routes/repo/security.tsx"),
    route("security/dependency-graph", "routes/repo/security-graph.tsx"),
    route("security/dependency-graph/sbom.json", "routes/repo/security-sbom.ts"),
    route("security/dependency-updates", "routes/repo/security-updates.tsx"),
    route("security/pulls/:number", "routes/repo/security-pull.tsx"),
    route("security/settings", "routes/repo/security-settings.tsx"),
    route("plans", "routes/repo/plans.tsx"),
    route("plans/:id", "routes/repo/plan.tsx"),
    route("settings", "routes/repo/settings.tsx"),
    route("settings/repository", "routes/repo/settings-repository.tsx"),
    route("settings/access", "routes/repo/settings-access.tsx"),
    route("settings/keys", "routes/repo/settings-deploy-keys.tsx"),
    route("settings/branches", "routes/repo/settings-branches.tsx"),
    route("settings/rules", "routes/repo/settings-rules.tsx"),
    route("settings/rules/:id", "routes/repo/settings-ruleset.tsx"),
    route("settings/webhooks", "routes/repo/webhooks.tsx"),
    route("settings/secrets", "routes/repo/secrets.tsx"),
    route("settings/actions", "routes/repo/settings-actions.tsx"),
    route("settings/environments", "routes/repo/settings-environments.tsx"),
    route("settings/runners", "routes/repo/settings-runners.tsx"),
    route("settings/deployments", "routes/repo/settings-deployments.tsx"),
    route("settings/domains", "routes/repo/settings-domains.tsx"),
    route("settings/dependencies", "routes/repo/settings-dependencies.tsx"),
    route("settings/guardrails", "routes/repo/settings-guardrails.tsx"),
    route("settings/agents", "routes/repo/settings-agents.tsx"),
    // What the project will have: one page for each Soon in its menu.
    route("soon/:feature", "routes/repo/soon.tsx"),
  ]),
  // Anything else: a 404 that still knows who is signed in.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
