/** Published capabilities, with documentation for the details and limitations. */
export const FEATURES = [
  {
    id: "code",
    title: "A home for your code",
    description: "Host ordinary git repositories, track work and review pull requests. Keep the tools and workflows your team already knows.",
    links: [
      { label: "Repositories and git", href: "https://docs.g1t.sh/guides/git/" },
      { label: "Pull requests", href: "https://docs.g1t.sh/guides/pull-requests/" },
    ],
  },
  {
    id: "agents",
    title: "Bring your coding agents",
    description:
      "Connect agents through MCP, script work with the official CLI, or build integrations with the REST API. Scoped access keeps each tool working with the permissions you grant.",
    links: [
      { label: "Connect an agent", href: "https://docs.g1t.sh/guides/bring-your-own-agent/" },
      { label: "Developer resources", href: "/developers" },
    ],
  },
  {
    id: "checks",
    title: "Check changes before they land",
    description:
      "Run workflows and required checks, then use the merge queue to test changes together before they reach your default branch. Run jobs on g1t or your own runners.",
    links: [
      { label: "Workflows and checks", href: "https://docs.g1t.sh/guides/actions/" },
      { label: "Merge queue", href: "https://docs.g1t.sh/guides/merge-queue/" },
    ],
  },
  {
    id: "deployments",
    title: "From pull request to production",
    description: "Give pull requests preview deployments and ship production from the same project. Follow deployment status alongside the code that changed.",
    links: [{ label: "Deployments", href: "https://docs.g1t.sh/guides/deployments/" }],
  },
  {
    id: "chat",
    title: "Keep the conversation with the work",
    description:
      "Talk in channels, direct messages and threads, with mentions and notifications. Chat and the forge are included on the free plan, without a per-seat charge.",
    links: [
      { label: "Team chat", href: "https://docs.g1t.sh/guides/chat/" },
      { label: "Plans and usage", href: "/pricing" },
    ],
  },
  {
    id: "security",
    title: "See what needs attention",
    description:
      "Review secret scanning, code scanning and dependency findings where you review code. Inspect a repository's requests, logs, traces and errors through observability.",
    links: [
      { label: "Secret protection", href: "https://docs.g1t.sh/guides/security/secret-protection/" },
      { label: "Observability", href: "https://docs.g1t.sh/guides/observability/" },
    ],
  },
] as const;
