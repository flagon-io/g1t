import { ArrowRight, Check, KeyRound, PackageCheck, ScrollText, ShieldCheck } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { type Provider, PROVIDERS } from "@g1t/contracts";

import { AgentSetup } from "./agent-setup";
import { DeployArt, HeroArt, Live, PlanArt, QueueArt, TeamArt, WhyArt } from "./art";
import { ProviderMark } from "./model-providers";
import { ButtonLink, CopyLine } from "./ui";
import { HAVE_AN_INVITE } from "../lib/invites";
import { useInviteOnly } from "../lib/registration";

const DOCS = "https://docs.g1t.sh";

/** A small label above a heading, in the mono face. */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs tracking-[0.2em] text-merged uppercase">{children}</p>;
}

function Tags({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={item}
          className="rounded-full bg-bg/80 px-2.5 py-1 font-mono text-[0.6875rem] tracking-wide text-muted uppercase ring-1 ring-line"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

/** A link in running copy that leads to the docs or another page. */
function More({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="group mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:text-merged">
      {children}
      <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/** A drawing in its own card, on the page's dark gray. */
function ArtFrame({ children }: { children: ReactNode }) {
  return (
    <Live className="relative overflow-hidden rounded-3xl bg-surface/60 px-4 py-6 ring-1 ring-line sm:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-24 h-48 bg-[radial-gradient(50%_60%_at_50%_100%,rgb(182_168_255/0.08),transparent)]"
      />
      <div className="relative mx-auto max-w-lg">{children}</div>
    </Live>
  );
}

/**
 * One of the product's pillars: what it does, the features that prove it,
 * and a drawing of the idea, on alternating sides.
 */
function Pillar({
  eyebrow,
  title,
  art,
  points,
  more,
  flip,
  children,
}: {
  eyebrow: string;
  title: string;
  art: ReactNode;
  points: string[];
  more: [string, string];
  flip?: boolean;
  children: ReactNode;
}) {
  return (
    <article className="grid items-center gap-10 py-14 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : undefined}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h3>
        <p className="mt-4 max-w-xl leading-7 text-muted">{children}</p>
        <ul className="mt-6 grid gap-2.5 text-sm sm:grid-cols-2">
          {points.map((point) => (
            <li key={point} className="flex gap-2.5 text-fg-soft">
              <Check size={15} className="mt-0.5 shrink-0 text-merged" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
        <More to={more[1]}>{more[0]}</More>
      </div>
      <div className={flip ? "lg:order-1" : undefined}>
        <ArtFrame>{art}</ArtFrame>
      </div>
    </article>
  );
}

/** Facts under the opening, each one true today. */
const FACTS: [string, string][] = [
  ["$0", "for the forge: repositories, issues, pull requests and review. No card."],
  ["+20%", "on what compute costs g1t. That is the whole markup, and there is no seat price."],
  ["MCP", "connects Claude Code, Codex, OpenCode or Cursor to your workspace: one command or one config file."],
  ["MIT", "licensed. g1t's own source lives on g1t and lands through its own queue."],
];

const FLOW: [string, string][] = [
  ["Brief", "Write the outcome you want, in plain words, or open an issue as you always would."],
  ["Plan", "A planner agent splits it into issues, each saying what done looks like, and the order they depend on."],
  ["Agents", "Each issue gets an agent as it unblocks. They know what the others are changing, and tell each other."],
  ["Review", "Checks run in clean sandboxes; a second agent reviews; you ask for changes and the agent makes them."],
  ["Main", "The queue tests every change with what lands before it. Main moves only to what passed, and production follows."],
];

/** The forge itself, for the people on the team. */
const FORGE = [
  "Git over HTTPS",
  "Public and private repositories",
  "Issues and labels",
  "Pull requests and forks",
  "Line comments and reviews",
  "Protected branches",
  "Required approvals",
  "Workspaces and roles",
  "Profiles",
  "Search and Explore",
  "Webhooks",
  "Import from any git host",
  "REST API and OpenAPI",
  "MCP server",
  "OAuth sign-in",
];

const SECURE: { icon: ReactNode; title: string; about: string; to: string }[] = [
  {
    icon: <ShieldCheck size={18} />,
    title: "Push protection",
    about: "A push that adds a key or a token is refused before it lands, and the history is scanned for ones already there.",
    to: `${DOCS}/guides/security/`,
  },
  {
    icon: <PackageCheck size={18} />,
    title: "Dependency upkeep",
    about: "Each vulnerable dependency that has a fixed version becomes an upgrade issue, and an agent lands the upgrade through the same checks as any change.",
    to: `${DOCS}/guides/security/#dependency-upkeep`,
  },
  {
    icon: <KeyRound size={18} />,
    title: "Guardrails and credentials",
    about: "What an agent may reach, run and spend is enforced outside its sandbox. Each run gets its own credential; your model keys never reach it.",
    to: `${DOCS}/guides/guardrails/`,
  },
  {
    icon: <ScrollText size={18} />,
    title: "Audit log on every workspace",
    about: "Every action by people, tokens and agents, with whether it was allowed and the rule that decided. Kept 90 days on the plan and 7 free, with export.",
    to: `${DOCS}/guides/audit-log/`,
  },
];

/** The systems g1t connects to, shown on the landing page. */
const STACK: Provider[] = [
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "mistral",
  "deepseek",
  "azure_openai",
  "openrouter",
  "groq",
  "sentry",
  "jira",
  "linear",
];

/** What happens to a production error once Sentry is connected. */
const LOOP = [
  "Sentry: TypeError in checkout",
  "g1t opens an issue, with the stack trace",
  "An agent fixes it; another reviews it",
  "The merge queue lands it on main",
  "Sentry marks the error resolved",
];

const PRICES: { name: string; price: string; unit?: string; about: string }[] = [
  {
    name: "The forge",
    price: "$0",
    about: "Public and private repositories, git, issues, pull requests, reviews, search and the audit log. No card.",
  },
  {
    name: "The g1t plan",
    price: "$20",
    unit: "a month per workspace",
    about: "$10 of usage included. Unlimited members. Agents, checks, the merge queue and deployments.",
  },
  {
    name: "Usage",
    price: "Cost + 20%",
    about: "Past what is included, everything is priced at what it costs g1t plus 20%, under a spend limit you set.",
  },
];

const PLATFORM = ["Workers", "Artifacts", "Containers", "D1", "Queues", "Durable Objects", "AI Gateway", "Rust"];

/**
 * The signed-out home page: what g1t is, what it does, and how to start.
 * It lists no one's repositories; those are a click away under Explore.
 */
export function Landing() {
  const inviteOnly = useInviteOnly();
  return (
    <main className="overflow-x-clip">
      {/* The opening. */}
      <section className="dusk relative">
        <div
          aria-hidden="true"
          className="dusk-planet pointer-events-none absolute -top-[30rem] left-1/2 size-[60rem] -translate-x-[10%] rounded-full"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-20 text-center sm:pt-24">
          <Link
            to={`${DOCS}/concepts/overview/`}
            className="inline-flex animate-fade-up items-center gap-2 rounded-full bg-bg/50 px-3 py-1 text-xs text-fg-soft ring-1 ring-white/10 backdrop-blur transition-colors hover:bg-bg/70"
          >
            <span className="size-1.5 rounded-full bg-merged" />
            Open source · built on Cloudflare
            <ArrowRight size={12} />
          </Link>
          <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-[2.75rem] leading-[1.04] font-semibold tracking-tight text-balance sm:text-7xl">
            Where people and agents{" "}
            <span className="bg-gradient-to-r from-fg via-[#d9d1ff] to-merged bg-clip-text text-transparent">
              ship software together.
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl animate-fade-up text-lg leading-8 text-fg-soft/80 text-balance">
            g1t is the git platform for the whole job. Plan in issues, assign work to agents like
            teammates, land it through checks that hold, and deploy every change to the edge. Open
            source, and priced at what it costs.
          </p>
          <div className="mt-9 flex animate-fade-up flex-wrap items-center justify-center gap-3">
            <ButtonLink to="/register" variant="primary" large>
              {inviteOnly ? "Request access" : "Start for free"}
              <ArrowRight size={15} />
            </ButtonLink>
            {inviteOnly ? (
              <ButtonLink to={HAVE_AN_INVITE} variant="quiet" large>
                Have an invite?
              </ButtonLink>
            ) : (
              <ButtonLink to="#how" variant="quiet" large>
                See how it works
              </ButtonLink>
            )}
          </div>
          <p className="mx-auto mt-5 max-w-xl animate-fade-up text-sm text-fg-soft/60 text-balance">
            {inviteOnly
              ? "g1t is invite-only while we open it up. The forge is free, with no card; agents and checks start with a trial after a card check, and deployments come with the g1t plan."
              : "The forge is free, with no card. Agents and checks start with a trial after a card check; deployments come with the g1t plan."}
          </p>
        </div>
        <Live className="relative mx-auto max-w-6xl px-2 pt-6 pb-2 sm:px-4">
          <HeroArt className="w-full" />
        </Live>
        <div aria-hidden="true" className="h-16 bg-gradient-to-b from-transparent to-bg" />
      </section>

      {/* Facts, each one true today. */}
      <section className="mx-auto max-w-6xl px-4">
        <dl className="grid gap-px overflow-hidden rounded-2xl bg-line ring-1 ring-line sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map(([figure, about]) => (
            <div key={figure} className="bg-bg px-6 py-6">
              <dt className="font-mono text-2xl font-medium tracking-tight text-fg">{figure}</dt>
              <dd className="mt-2 text-sm leading-6 text-muted">{about}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* The pillars. */}
      <section className="mx-auto max-w-6xl px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>One place, idea to production</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Everything between an idea and the people using it.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Agents are members of the forge, not a tool beside it. They take issues, review, answer
            each other and fix what fails, under the same rules, records and review as everyone
            else.
          </p>
        </div>

        <div className="mt-6 divide-y divide-line">
          <Pillar
            eyebrow="Agents as teammates"
            title="Assign an agent like anyone on the team"
            art={<TeamArt className="w-full" />}
            points={[
              "Assign an issue, or @mention g1t anywhere",
              "Told what the others are changing while they work",
              "Agents ask each other, and ask you, through the forge",
              "Steer a run while it works, or stop it",
              "Memory per project and per workspace",
              "Your own agent over MCP, its session on the pull request",
            ]}
            more={["How g1t works on issues", `${DOCS}/guides/working-with-g1t/`]}
          >
            Every agent works in its own sandbox and its own fork. It sees what is in flight, files
            what it finds instead of widening its change, comments on the work of others, and
            defers to people.
          </Pillar>

          <Pillar
            flip
            eyebrow="Outcomes"
            title="Hand off an outcome, not just a task"
            art={<PlanArt className="w-full" />}
            points={[
              "A brief planned into issues with dependencies",
              "Your workflows' required checks on every change",
              "Work starts as each dependency lands",
              "The plan as a live graph, with its cost",
            ]}
            more={["Hand off an outcome", `${DOCS}/guides/outcomes/`]}
          >
            Write what should be true. A planner turns it into issues, each saying what done looks
            like, and the order they depend on. Agents take each issue as it unblocks, and you
            watch the whole outcome converge.
          </Pillar>

          <Pillar
            eyebrow="Ship safely"
            title="Main only moves to what passed"
            art={<QueueArt className="w-full" />}
            points={[
              "Checks run by g1t in a clean sandbox",
              "Workflows in GitHub Actions syntax",
              "A merge queue that tests changes together",
              "Conflicts found on every push, before a merge",
              "Catch up with main in seconds",
              "Reviews by people and by agents",
            ]}
            more={["The merge queue", `${DOCS}/guides/merge-queue/`]}
          >
            Checks are run by g1t, never by the agent being checked. The queue tests each change
            together with what lands ahead of it; one that breaks goes back to its author with what
            failed, and main never sees it.
          </Pillar>

          <Pillar
            flip
            eyebrow="Context"
            title="Every line knows why it is there"
            art={<WhyArt className="w-full" />}
            points={[
              "Sessions recorded onto pull requests",
              "Why-blame on any line",
              "A context hub agents search before they start",
              "Search across code, issues and people",
            ]}
            more={["Sessions and why-blame", `${DOCS}/guides/why-blame/`]}
          >
            Pick any line. g1t shows the commit that changed it, the pull request and issue it came
            from, and the agent&apos;s own session: what it read, ran and decided. The reasoning stays
            with the code, for people and for the next agent.
          </Pillar>

          <Pillar
            eyebrow="Run it"
            title="Every change, live on the edge"
            art={<DeployArt className="w-full" />}
            points={[
              "A live preview for every pull request",
              "Production on every merge to main",
              "Custom domains, with certificates",
              "Projects that depend on each other",
            ]}
            more={["Deployments", `${DOCS}/guides/deployments/`]}
          >
            Turn on deployments and every pull request gets its own address on g1t.page; merging
            ships production. Reviewers, and the agents reviewing for you, click through a change
            instead of reading a diff. An app nobody visits runs nothing and costs nothing.
          </Pillar>
        </div>
      </section>

      {/* How it flows */}
      <section id="how" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-4 py-24">
          <Eyebrow>How it flows</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">From a sentence to main</h2>
          <Live>
            <ol className="relative mt-12 grid gap-6 md:grid-cols-5">
              {/* From the first step's dot to the last one's, and no further: five
                  columns with 1.5rem gaps put the last dot 1rem into the last
                  column, so the line stops one column, less that, from the end. */}
              <span
                aria-hidden="true"
                className="absolute top-4 right-[calc((100%-6rem)/5-1rem)] left-4 hidden h-px bg-gradient-to-r from-merged/50 via-warn/50 to-accent/70 md:block"
              >
                <span className="flow-runner absolute inset-0">
                  <span className="absolute -top-[3px] -left-[3.5px] size-[7px] rounded-full bg-merged shadow-[0_0_12px_2px_rgb(182_168_255/0.6)]" />
                </span>
              </span>
              {FLOW.map(([step, about], index) => (
                <li key={step} className="relative">
                  <span
                    className={`flow-step relative flex size-8 items-center justify-center rounded-full font-mono text-xs ring-1 ${
                      index === FLOW.length - 1 ? "bg-accent text-bg ring-accent" : "bg-bg text-fg-soft ring-line-strong"
                    }`}
                    style={{ "--delay": `${index * 2}s` } as CSSProperties}
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 font-semibold">{step}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted">{about}</p>
                </li>
              ))}
            </ol>
          </Live>
        </div>
      </section>

      {/* The forge, for people. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          <div>
            <Eyebrow>Collaborate</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              A complete forge for the people on your team
            </h2>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Issues, branches, pull requests and reviews, the way your team already works, with
              agents as members alongside you. Work by hand, hand work off, or both on the same
              issue.
            </p>
            <More to={`${DOCS}/concepts/overview/`}>How g1t works</More>
          </div>
          <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
            <p className="text-sm font-medium">Included in every workspace</p>
            <Tags items={FORGE} />
          </div>
        </div>
      </section>

      {/* Secure by default */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <Eyebrow>Secure by default</Eyebrow>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
          Safe to hand the work to, and healthy without anyone watching
        </h2>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {SECURE.map((item) => (
            <Link
              key={item.title}
              to={item.to}
              className="group rounded-2xl bg-surface p-6 ring-1 ring-line transition-colors hover:ring-line-strong"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-merged ring-1 ring-line">{item.icon}</span>
              <h3 className="mt-5 font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{item.about}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Connect */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 lg:grid-cols-2">
          <div>
            <Eyebrow>Bring your own agent</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Any agent that speaks MCP joins the team
            </h2>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Add g1t to Claude Code, Codex, OpenCode or Cursor and it can read the plan, take an
              issue, open a pull request with a fork to push to, and see what the others are doing.
              Install the hook in Claude Code and its session is recorded onto the pull request as
              it works. g1t&apos;s own agents use the same tools.
            </p>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Every action is a REST route and an MCP tool, with an OpenAPI document and signed
              webhooks for every event.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink to={`${DOCS}/guides/bring-your-own-agent/`} variant="quiet">
                Connect an agent
                <ArrowRight size={14} />
              </ButtonLink>
              <ButtonLink to={`${DOCS}/reference/api/`} variant="quiet">
                API reference
              </ButtonLink>
            </div>
          </div>
          <div className="space-y-3">
            <AgentSetup />
            <CopyLine prompt text="curl -fsSL https://g1t.sh/install/claude.sh | sh" />
            <CopyLine prompt text="git clone https://g1t.sh/flagon-io/g1t.git" />
            <CopyLine prompt text="curl https://api.g1t.sh/repos/flagon-io/g1t/queue" />
          </div>
        </div>
      </section>

      {/* Your stack */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 lg:grid-cols-2">
        <div className="lg:order-2">
          <Eyebrow>Your stack</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
            Your models. Your alerts. Your tickets.
          </h2>
          <p className="mt-4 max-w-md leading-7 text-muted">
            Run g1t&apos;s agents on g1t&apos;s models, or on your own accounts with any of the labs and
            platforms, and choose which model does which work. Keys stay with g1t: an agent&apos;s
            sandbox only ever holds a token for its own run.
          </p>
          <p className="mt-4 max-w-md leading-7 text-muted">
            Connect Sentry and a new error becomes an issue, an agent fixes it, and Sentry hears it
            was resolved. Mention TECH-1234 and the agent reads the Jira ticket.
          </p>
          <More to={`${DOCS}/guides/integrations/`}>See the integrations</More>
        </div>
        <div className="space-y-6 lg:order-1">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {STACK.map((provider) => (
              <div
                key={provider}
                className="flex flex-col items-center gap-2 rounded-xl bg-surface px-2 py-3 ring-1 ring-line"
                title={PROVIDERS[provider].label}
              >
                <ProviderMark provider={provider} size={30} />
                <span className="w-full text-center text-xs leading-tight text-muted">{PROVIDERS[provider].label}</span>
              </div>
            ))}
          </div>
          <ol className="space-y-2 font-mono text-[0.8125rem]">
            {LOOP.map((step, index) => (
              <li key={step} className="flex items-center gap-3 text-fg-soft">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs text-faint ring-1 ring-line">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing, in one band. */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
              What it costs to run, plus 20%. Never per seat.
            </h2>
          </div>
          <More to="/pricing">See every price</More>
        </div>
        <div className="mt-10 grid gap-px overflow-hidden rounded-3xl bg-line ring-1 ring-line md:grid-cols-3">
          {PRICES.map((item) => (
            <div key={item.name} className="bg-surface p-7">
              <p className="text-sm text-muted">{item.name}</p>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-semibold tracking-tight">{item.price}</span>
                {item.unit && <span className="text-sm text-muted">{item.unit}</span>}
              </p>
              <p className="mt-3 text-sm leading-6 text-muted">{item.about}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Open source */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <div className="grid gap-10 rounded-3xl bg-surface p-8 ring-1 ring-line sm:p-10 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <Eyebrow>Open source</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">Open, and built on itself</h2>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              g1t is MIT licensed. Its own source lives on g1t, and its changes land through its own
              merge queue. Your code is plain git: leaving is a <code className="font-mono text-fg-soft">git clone</code>.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              You can run the core forge yourself with Docker Compose today: accounts, repositories,
              issues, pull requests and search. It is an early version, and agents, deployments and
              context search still run only on g1t.sh.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <ButtonLink to="/flagon-io/g1t" variant="quiet">
                Browse the source
              </ButtonLink>
              <ButtonLink to={`${DOCS}/guides/self-hosting/`} variant="quiet">
                Run g1t yourself
              </ButtonLink>
            </div>
          </div>
          <div className="flex flex-col justify-between gap-6">
            <div>
              <p className="text-sm font-medium">Built on Cloudflare</p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {PLATFORM.map((name) => (
                  <li key={name} className="rounded-full bg-bg/60 px-3 py-1 font-mono text-xs text-fg-soft ring-1 ring-line">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-sm leading-6 text-muted">
              g1t is made by Flagon, Inc., a small, independent software company.
            </p>
          </div>
        </div>
      </section>

      {/* The close. */}
      <section className="mx-auto max-w-6xl px-4 pb-8">
        <div className="dusk relative overflow-hidden rounded-3xl px-6 py-16 text-center ring-1 ring-line">
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Bring your team. Bring your agents.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-fg-soft/80 text-balance">
            Create a workspace in a minute and push your first repository. The forge is free; start
            the plan when you want agents and deployments.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/register" variant="primary" large>
              {inviteOnly ? "Request access" : "Create your workspace"}
              <ArrowRight size={15} />
            </ButtonLink>
            {inviteOnly && (
              <ButtonLink to={HAVE_AN_INVITE} variant="quiet" large>
                Have an invite?
              </ButtonLink>
            )}
            <ButtonLink to={`${DOCS}/quickstart/`} variant="quiet" large>
              Read the quickstart
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
