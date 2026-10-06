These are the companies that process information for g1t on our behalf, what each does, and what it receives. Each is bound by a contract that limits it to doing that. **We'll update this page before we add a new subprocessor**, and list the change in the [policies' history](/policies).

## Subprocessors

| Company | What they do for g1t | What they receive | Where |
| --- | --- | --- | --- |
| **Cloudflare, Inc.** | Hosting and the network g1t runs on (Workers), databases (D1), storage for repositories, avatars and screenshots (Artifacts, KV and R2), queues, the sandboxes agents and checks run in (Containers), sending email (Email Service), search embeddings (Workers AI and Vectorize), the gateway hosted agents reach their model through (AI Gateway), and screenshots of deployed apps (Browser Rendering) | Everything stored on g1t, and every request to it | Global |
| **Stripe, Inc.** | Payments, cards, invoices and receipts | Workspace owners' billing details, card details (entered on Stripe's page, never on g1t), and what each invoice charges | United States |
| **Anthropic, PBC** | The AI model behind g1t's hosted agents | What an agent run needs: the issue or request, the relevant code and files, the conversation so far, and tool results. Not your account details. Only when a hosted agent runs | United States |

**AI Gateway logs.** Each hosted agent's model request passes through Cloudflare AI Gateway, which records it with the workspace, repository and pull request it was for, so we can bill it accurately. **[PLACEHOLDER: confirm whether AI Gateway stores request and response bodies, and for how long.]**

**Training.** Anthropic does not train its models on what g1t sends through its commercial API. **[PLACEHOLDER: confirm against Anthropic's current commercial terms, and record any zero-data-retention arrangement.]**

## Other services g1t calls

- **OSV.dev**, run by Google: the names and versions of packages in your lockfiles, to look up known vulnerabilities. Nothing that identifies you or your repository.

## Services you choose

When you connect these, your information goes to them because you asked, under your own agreement with them. They are not g1t's subprocessors:

- **Your own model providers**, such as OpenAI, Google, Groq, OpenRouter, or your own Anthropic or Azure account, when your workspace routes agents to them.
- **Integrations**, such as Slack, Linear, Jira, Sentry and Datadog.
- **Webhooks** you add, which send events to the addresses you choose.
- **Hosts your sandboxes reach**, such as package registries and anything you allow in your guardrails.
- **Custom domains** you point at your deployments.

Questions about subprocessors: [hey@flagon.io](mailto:hey@flagon.io).
