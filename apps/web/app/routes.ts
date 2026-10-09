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
  // Where an account confirms its email address, with the code from the
  // email; every other page sends it here until it has (lib/confirm-gate.ts).
  route("confirm-email", "routes/confirm-email.tsx"),
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
    // Your access tokens: the list, a new one, and each one's page.
    route("tokens", "routes/settings/tokens.tsx"),
    route("tokens/new", "routes/settings/token-new.tsx"),
    route("tokens/:id", "routes/settings/token.tsx"),
    route("github", "routes/settings/github.tsx"),
    route("applications", "routes/settings/applications.tsx"),
    route("integrations", "routes/settings/integrations.tsx"),
    route("two-factor", "routes/settings/two-factor.tsx"),
    route("security-log", "routes/settings/security-log.tsx"),
    route("account", "routes/settings/account.tsx"),
  ]),
  // The account menu's header: name, primary email and invites left.
  route("settings/menu.json", "routes/settings-menu-json.ts"),
  // People, apart from workspaces: `u` is a reserved name.
  route("u/:username", "routes/user.tsx"),
  // The card that opens over a person's name or avatar (lib/hovercard.ts).
  // `-` is no workspace's name, so nothing else is ever found here.
  route("-/hovercard/user/:username", "routes/hovercard-user.ts"),
  // Live notifications: each tab's feed socket, and the person's
  // notification settings as JSON (services/notify).
  route("-/live", "routes/notify/live.ts"),
  route("-/notify", "routes/notify/api.ts"),
  route("explore", "routes/explore.tsx", { id: "explore" }),
  route("pricing", "routes/pricing.tsx"),
  route("search", "routes/search.tsx"),
  // Each person's inbox, and what its panel in the top bar fetches.
  route("inbox", "routes/inbox.tsx"),
  route("inbox.json", "routes/inbox-json.ts"),
  // What the command palette shows as someone types.
  route("search.json", "routes/search-json.ts"),
  route("workspaces/new", "routes/workspace/new.tsx"),
  // Workspace invitations waiting for the person's answer. `invitations` is reserved.
  route("invitations", "routes/invitations.tsx"),
  // People to invite, as the People page's invite form searches them.
  route("-/people.json", "routes/people-json.ts"),
  // Trust pages: reserved names, like the rest above.
  route("policies", "routes/policies.tsx"),
  route("policies/:policy", "routes/policy.tsx"),
  route("security", "routes/security.tsx"),
  route("support", "routes/support.tsx"),
  // Status moved to status.g1t.sh (apps/status); old links go there.
  route("status", "routes/status.tsx"),
  route("status.json", "routes/status-json.ts"),
  route(".well-known/security.txt", "routes/security-txt.ts"),
  // For search engines: what may be crawled, and a map of the public pages.
  route("robots.txt", "routes/robots-txt.ts"),
  route("sitemap.xml", "routes/sitemap-xml.ts"),
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
    // Code's Overview: Mission control's code panels, for this workspace.
    route("-/overview", "routes/workspace/code-overview.tsx"),
    // The workspace itself, at a glance: members, plan and spend.
    route("-/workspace", "routes/workspace/workspace-overview.tsx"),
    // Teams: the list, a new one, and each team's pages.
    route("-/teams", "routes/workspace/teams.tsx"),
    route("-/teams/new", "routes/workspace/team-new.tsx"),
    route("-/teams/:team", "routes/workspace/team/layout.tsx", [
      index("routes/workspace/team/members.tsx"),
      route("teams", "routes/workspace/team/teams.tsx"),
      route("repositories", "routes/workspace/team/repositories.tsx"),
      route("settings", "routes/workspace/team/settings.tsx"),
    ]),
    // The workspace's own access tokens: the list, a new one, and each one's page.
    route("-/tokens", "routes/workspace/tokens.tsx"),
    route("-/tokens/new", "routes/workspace/token-new.tsx"),
    route("-/tokens/:id", "routes/workspace/token.tsx"),
    // Its rules for members' personal access tokens, and approving them.
    route("-/personal-access-tokens", "routes/workspace/personal-access-tokens.tsx"),
    route("-/usage", "routes/workspace/usage.tsx"),
    route("-/gateway", "routes/workspace/gateway.tsx"),
    route("-/billing", "routes/workspace/billing.tsx"),
    route("-/billing/entries", "routes/workspace/statement-entries.ts"),
    route("-/billing/statement.csv", "routes/workspace/statement-csv.ts"),
    // The integrations directory, and the setup page for each kind of
    // provider connection: models, alerts, trackers (lib/integration-sections).
    route("-/integrations", "routes/workspace/integrations-directory.tsx"),
    route("-/integrations/:section", "routes/workspace/integrations.tsx"),
    route("-/webhooks", "routes/workspace/webhooks.tsx"),
    // The workspace's own emoji, for chat (components/emoji).
    route("-/emoji", "routes/workspace/emoji.tsx"),
    route("-/secrets", "routes/workspace/secrets.tsx"),
    route("-/runners", "routes/workspace/runners.tsx"),
    route("-/actions", "routes/workspace/actions-settings.tsx"),
    route("-/packages", "routes/workspace/packages.tsx"),
    route("-/packages/:ecosystem/*", "routes/workspace/package.tsx"),
    route("-/settings", "routes/workspace/settings.tsx"),
    // What members may do in chat: channels, emoji, default channels.
    route("-/settings/chat", "routes/workspace/chat-settings.tsx"),
    route("-/repositories", "routes/workspace/repositories.tsx"),
    // Agents mode: the overview (budget, sessions, roster, spend) first, then
    // each of the workspace's own agents and its sessions (docs/WORKSPACE.md).
    // `new` is no agent's handle.
    route("-/agents", "routes/workspace/agents/layout.tsx", [
      index("routes/workspace/agents.tsx"),
      route("new", "routes/workspace/agents/new.tsx"),
      route(":handle", "routes/workspace/agents/agent.tsx", [
        index("routes/workspace/agents/sessions.tsx"),
        route("sessions/:id", "routes/workspace/agents/session.tsx"),
        route("memory", "routes/workspace/agents/memory.tsx"),
        route("routines", "routes/workspace/agents/routines.tsx"),
        route("spend", "routes/workspace/agents/spend.tsx"),
        route("activity", "routes/workspace/agents/activity.tsx"),
        route("profile", "routes/workspace/agents/profile.tsx"),
      ]),
    ]),
    // Chat mode: channels by name, direct messages by id, and what the page
    // calls as it runs: the live socket and the JSON for sending and reading.
    route("-/chat/live", "routes/workspace/chat/live.ts"),
    route("-/chat/api", "routes/workspace/chat/api.ts"),
    // A person's card in Chat: their profile and teams here.
    route("-/chat/person/:username", "routes/workspace/chat/person.ts"),
    route("-/chat", "routes/workspace/chat/layout.tsx", [
      index("routes/workspace/chat/index.tsx"),
      route("browse", "routes/workspace/chat/browse.tsx"),
      route("dm/:id", "routes/workspace/chat/channel.tsx", { id: "routes/workspace/chat/dm" }),
      route(":channel", "routes/workspace/chat/channel.tsx"),
    ]),
    // Docs mode (docs/WORKSPACE.md, "Docs"): what its pages call as they
    // run (a page's live socket, JSON, comments, uploads, export), then
    // Home, search, templates, the trash, a new space, and each space and
    // page by its address. A page's address ends in its id, so renaming it
    // keeps links working.
    route("-/docs/live", "routes/workspace/docs/live.ts"),
    route("-/docs/api", "routes/workspace/docs/api.ts"),
    route("-/docs/threads/:page/*", "routes/workspace/docs/threads.ts"),
    route("-/docs/upload", "routes/workspace/docs/upload.ts"),
    route("-/docs/export", "routes/workspace/docs/export.ts"),
    route("-/docs", "routes/workspace/docs/layout.tsx", [
      index("routes/workspace/docs/home.tsx"),
      route("search", "routes/workspace/docs/search.tsx"),
      route("templates", "routes/workspace/docs/templates.tsx"),
      route("trash", "routes/workspace/docs/trash.tsx"),
      route("new", "routes/workspace/docs/new-space.tsx"),
      // Pages possibly out of date, and a project's docs folder, read-only.
      route("stale", "routes/workspace/docs/stale.tsx"),
      route("repo/:repoOwner/:repoName/*", "routes/workspace/docs/repo-file.tsx"),
      route(":space", "routes/workspace/docs/space.tsx"),
      route(":space/settings", "routes/workspace/docs/space-settings.tsx"),
      route(":space/:page", "routes/workspace/docs/page.tsx"),
    ]),
    // Home for a member without Code, and what Code's pages say to them
    // (docs/WORKSPACE.md, "Members without Code").
    route("-/home", "routes/workspace/home.tsx"),
    route("-/code-access", "routes/workspace/code-access.tsx"),
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
  // A file as it is, sent on to the usercontent origin (lib/usercontent.ts).
  route(":owner/:repo/raw/:ref/*", "routes/repo/raw.ts"),
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
    route("settings/guardrails", "routes/repo/settings-guardrails.tsx"),
    route("settings/agents", "routes/repo/settings-agents.tsx"),
    // What the project will have: one page for each Soon in its menu.
    route("soon/:feature", "routes/repo/soon.tsx"),
  ]),
  // Anything else: a 404 that still knows who is signed in.
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
