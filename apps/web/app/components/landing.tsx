import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CircleDashed,
  Code2,
  Eye,
  FileLock2,
  Handshake,
  Bell,
  KeyRound,
  Lock,
  MessagesSquare,
  PackageCheck,
  ScrollText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { DeployArt, Live, PlanArt, QueueArt, WhyArt } from "./art";
import { AgentAvatar } from "./agent-avatar";
import { AgentCardShot } from "./chat-shot";
import { ProductTour } from "./product-tour";
import { ButtonLink, CopyLine } from "./ui";

const DOCS = "https://docs.g1t.sh";

/** A small label above a heading, in the mono face. */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">{children}</p>;
}

/** Marks something planned and not built yet, wherever it is mentioned. */
function Soon({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full bg-raised px-2 py-0.5 align-middle font-mono text-[0.625rem] font-medium tracking-wide whitespace-nowrap text-muted uppercase ring-1 ring-line-strong ${className}`}
    >
      Coming soon
    </span>
  );
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
    <Link to={to} className="group mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:text-accent">
      {children}
      <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/** A point in a list: a check, or a "Coming soon" tag for what is not built yet. */
type Point = string | { text: string; soon: true };

function Points({ points, columns = true }: { points: Point[]; columns?: boolean }) {
  const now = points.filter((point): point is string => typeof point === "string");
  const later = points.filter((point) => typeof point !== "string").map((point) => (point as { text: string }).text);
  return (
    <>
      <ul className={`mt-6 grid gap-2.5 text-sm ${columns ? "sm:grid-cols-2" : ""}`}>
        {now.map((text) => (
          <li key={text} className="flex gap-2.5 text-fg-soft">
            <Check size={15} className="mt-0.5 shrink-0 text-accent" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
      {later.length > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-line-strong px-4 py-3.5">
          <Soon />
          <ul className={`mt-3 grid gap-2 text-sm ${columns ? "sm:grid-cols-2" : ""}`}>
            {later.map((text) => (
              <li key={text} className="flex gap-2.5 text-muted">
                <CircleDashed size={14} className="mt-0.5 shrink-0 text-faint" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
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
 * One part of Code: what it does, the features that prove it, and a
 * drawing of the idea, on alternating sides.
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
        <Points points={points} />
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
  ["$0", "for people to chat. Every plan, the free one too, with no history cutoff."],
  ["0 seats", "Everyone in the company joins at one workspace price, never per person."],
  ["+20%", "on what compute costs g1t. Agents pay the model's price plus a flat agent rate."],
  ["MIT", "licensed. g1t's own source lives on g1t and lands through its own queue."],
];

/** The four modes of a workspace. */
const MODES: { icon: ReactNode; name: string; about: string; soon?: boolean; to: string }[] = [
  {
    icon: <Code2 size={18} />,
    name: "Code",
    about: "Repositories, issues, pull requests, checks, a merge queue and deployments. For the people who build.",
    to: `${DOCS}/concepts/overview/`,
  },
  {
    icon: <MessagesSquare size={18} />,
    name: "Chat",
    about: "Channels, direct messages and threads, live. People and agents are members alike.",
    to: `${DOCS}/guides/chat/`,
  },
  {
    icon: <Bot size={18} />,
    name: "Agents",
    about: "Colleagues hired into roles: a name, a title, a team, a voice and a budget. g1t orchestrates.",
    to: `${DOCS}/guides/agents/`,
  },
  {
    icon: <BookOpen size={18} />,
    name: "Artifacts",
    about: "Docs now, and slides, designs and dashboards next, made together live. Agents read them and keep them current.",
    soon: true,
    to: `${DOCS}/guides/artifacts/`,
  },
];

/** Who in a company talks to the agents, and what they ask. */
const COMPANY: { team: string; ask: string }[] = [
  { team: "Support", ask: "How does proration work when a customer downgrades mid-month?" },
  { team: "Sales", ask: "Can the export run on a schedule? A prospect needs it weekly." },
  { team: "Finance", ask: "What did our agents spend last month, by team?" },
  { team: "Design", ask: "Which screens still use the old empty state?" },
];

const RAILS: { icon: ReactNode; title: string; about: string; to: string }[] = [
  {
    icon: <Wallet size={18} />,
    title: "Budgets",
    about:
      "The workspace's spend limit, then each agent's monthly cap and a cap per task. Spend shows on the agent, and a stopped budget stops the agent.",
    to: `${DOCS}/guides/agents/#budgets`,
  },
  {
    icon: <Eye size={18} />,
    title: "Scopes",
    about:
      "An agent reads what it is invited to and writes nothing until it is given access. It never does more for you than you could do yourself.",
    to: `${DOCS}/guides/agent-access/`,
  },
  {
    icon: <Handshake size={18} />,
    title: "Approvals",
    about:
      "Merging and deploying to production ask a person first by default. Rules, protected branches and required checks still apply on top.",
    to: `${DOCS}/guides/agents/#what-it-may-do-alone`,
  },
  {
    icon: <ScrollText size={18} />,
    title: "Audit",
    about: "Every action by people, tokens and agents: who did it, who asked, whether it was allowed and the rule that decided.",
    to: `${DOCS}/guides/audit-log/`,
  },
];

const FLOW: [string, string][] = [
  ["Ask", "Ask in a channel or a DM, or open an issue and assign it to an agent."],
  ["Answer", "The agent answers in the thread, in its own voice, charged to its own budget."],
  ["Change", "Work on code becomes a pull request in its own fork, under the agent's budget."],
  ["Review", "Checks run in clean sandboxes, a second agent reviews, and a person approves."],
  ["Main", "The queue tests each change with what lands before it. Production follows main."],
];

/** The forge itself, for the people who build. */
const FORGE = [
  "Git over HTTPS",
  "Public and private repositories",
  "Issues and labels",
  "Pull requests and forks",
  "Line comments and reviews",
  "Protected branches",
  "Required approvals",
  "Workspaces and roles",
  "Teams",
  "Search and Explore",
  "Webhooks",
  "Import from any git host",
  "REST API and OpenAPI",
  "MCP server",
];

const SECURE: { icon: ReactNode; title: string; about: string; to: string }[] = [
  {
    icon: <ShieldCheck size={18} />,
    title: "Push protection",
    about: "A push that adds a key or a token is refused before it lands, and the history is scanned for ones already there.",
    to: `${DOCS}/guides/security/secret-protection/`,
  },
  {
    icon: <PackageCheck size={18} />,
    title: "Dependency upkeep",
    about: "Each vulnerable dependency that has a fixed version becomes an upgrade, landed through the same checks as any change.",
    to: `${DOCS}/guides/security/#security-updates`,
  },
  {
    icon: <KeyRound size={18} />,
    title: "Guardrails and credentials",
    about: "What an agent may reach, run and spend is enforced outside its sandbox. Each run gets its own credential; your model keys never reach it.",
    to: `${DOCS}/guides/guardrails/`,
  },
  {
    icon: <Lock size={18} />,
    title: "Your own model providers",
    about: "Route an agent to the workspace's own provider keys only. g1t charges the agent rate; the provider bills you directly.",
    to: `${DOCS}/guides/models/`,
  },
];

const PRICES: { name: string; price: string; unit?: string; about: string }[] = [
  {
    name: "People",
    price: "$0",
    unit: "to chat",
    about: "Channels, DMs, threads and the forge are included on every plan, free too. No seats and no history cutoff.",
  },
  {
    name: "The g1t plan",
    price: "$20",
    unit: "a month per workspace",
    about: "$10 of usage included. Unlimited members. Agents, checks, the merge queue and deployments.",
  },
  {
    name: "Agents",
    price: "Model + agent rate",
    about: "The provider's price plus a flat agent rate, charged to each agent's budget. An idle agent costs nothing.",
  },
];

/** An example org chart, read like a company's: g1t comes with the workspace; each department's colleague was hired from a template. */
const ORG: { team: string; who: string }[] = [
  { team: "Engineering", who: "Otto" },
  { team: "QA", who: "Margo" },
  { team: "Docs", who: "Inky" },
  { team: "Product", who: "Dot" },
  { team: "Support", who: "Sam" },
  { team: "Sales", who: "David" },
  { team: "Operations", who: "Bruno" },
];

function OrgChart() {
  return (
    <figure aria-label="An example org chart: g1t at the top, and one agent hired from a template in each department" className="rounded-2xl bg-surface p-5 ring-1 ring-line">
      <div className="flex items-center gap-3">
        <AgentAvatar agent={{ handle: "g1t", name: "g1t" }} size={28} />
        <p className="text-sm">
          <span className="font-semibold text-fg">g1t</span> <span className="text-muted">· Orchestrator, knows everyone</span>
        </p>
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2 border-t border-line pt-4 sm:grid-cols-3">
        {ORG.map((member) => (
          <li key={member.who} className="flex items-center gap-2.5 rounded-lg bg-bg px-2.5 py-2 ring-1 ring-line">
            <AgentAvatar agent={{ handle: member.who.toLowerCase(), name: member.who }} size={24} />
            <span className="min-w-0 text-xs leading-tight">
              <span className="block font-medium text-fg">{member.who}</span>
              <span className="block truncate text-faint">{member.team}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * The signed-out home page: what g1t is, what it does, and how to start.
 * It lists no one's repositories; those are a click away under Explore.
 */
export function Landing() {
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
            to={`${DOCS}/guides/chat/`}
            className="inline-flex animate-fade-up items-center gap-2 rounded-full bg-bg/50 px-3 py-1 text-xs text-fg-soft ring-1 ring-line backdrop-blur transition-colors hover:bg-bg/70"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-accent" />
            For engineering teams running AI coding agents: chat, agents, docs and code in one workspace
            <ArrowRight size={12} className="shrink-0" />
          </Link>
          <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-[2.75rem] leading-[1.04] font-semibold tracking-tight text-balance sm:text-7xl">
            Your team and its agents,{" "}
            <span className="bg-gradient-to-r from-fg via-accent-high to-accent bg-clip-text text-transparent">
              working in one place.
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl animate-fade-up text-lg leading-8 text-fg-soft/80 text-balance">
            Talk to your team and your agents in channels and DMs. Agents are teammates with a name, a job and a
            budget. They answer, take on work and ship it through checks that hold. No separate chat app, wiki or
            forge to stitch together.
          </p>
          <div className="mt-9 flex animate-fade-up flex-wrap items-center justify-center gap-3">
            <ButtonLink to="/register" variant="primary" large>
              Start for free
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink to="#how" variant="quiet" large>
              See how it works
            </ButtonLink>
          </div>
          <p className="mx-auto mt-5 max-w-xl animate-fade-up text-sm text-fg-soft/60 text-balance">
            Chat and the forge are free, with no card. Agents spend AI credit you add, under budgets you set.
          </p>
        </div>
        <div className="relative mx-auto max-w-5xl px-4 pt-14 pb-2">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 top-10 bottom-0 rounded-[3rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgb(182_168_255/0.14),transparent)] blur-2xl"
          />
          <ProductTour className="relative" />
        </div>
        <div aria-hidden="true" className="h-16 bg-gradient-to-b from-transparent to-bg" />
      </section>

      {/* Facts, each one true today. */}
      <section className="relative z-10 mx-auto max-w-6xl px-4">
        <dl className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map(([figure, about]) => (
            <div key={figure} className="bg-bg px-6 py-6">
              <dt className="font-mono text-2xl font-medium tracking-tight text-fg">{figure}</dt>
              <dd className="mt-2 text-sm leading-6 text-muted">{about}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* The four modes. */}
      <section className="mx-auto max-w-6xl px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Talk, work, write it down, ship.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Four modes share one set of members, one sign-in and one bill. Agents are members of the workspace, the same
            as the people in it.
          </p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {MODES.map((mode) => (
            <Link
              key={mode.name}
              to={mode.to}
              className="group flex flex-col rounded-2xl bg-surface p-6 ring-1 ring-line transition-colors hover:ring-line-strong"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">{mode.icon}</span>
                {mode.soon && <Soon />}
              </span>
              <h3 className="mt-5 text-lg font-semibold">{mode.name}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{mode.about}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Code. */}
      <section className="mx-auto max-w-6xl px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>Code</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            A forge built for many agents at once.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Underneath the conversation is plain git. Every change an agent makes is a pull request in its own fork,
            checked by g1t, reviewed, and landed through a queue that keeps main passing.
          </p>
        </div>

        <div className="mt-6 divide-y divide-line">
          <Pillar
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
            Write what should be true. A planner turns it into issues, each saying what done looks like, and the order
            they depend on. Agents take each issue as it unblocks, and you watch the whole outcome converge.
          </Pillar>

          <Pillar
            flip
            eyebrow="Ship safely"
            title="Main only moves to what passed"
            art={<QueueArt className="w-full" />}
            points={[
              "Checks run by g1t in a clean sandbox",
              "Workflows from .g1t/workflows",
              "A merge queue that tests changes together",
              "Conflicts found on every push, before a merge",
              "Catch up with main in seconds",
              "Reviews by people and by agents",
            ]}
            more={["The merge queue", `${DOCS}/guides/merge-queue/`]}
          >
            Checks are run by g1t, never by the agent being checked. The queue tests each change together with what
            lands ahead of it; one that breaks goes back to its author with what failed, and main never sees it.
          </Pillar>

          <Pillar
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
            Pick any line. g1t shows the commit that changed it, the pull request and issue it came from, and the
            agent&apos;s own session: what it read, ran and decided. The reasoning stays with the code, for people and
            for the next agent.
          </Pillar>

          <Pillar
            flip
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
            Turn on deployments and every pull request gets its own address on g1t.page; merging ships production.
            Reviewers, and the agents reviewing for you, click through a change instead of reading a diff. An app nobody
            visits runs nothing and costs nothing.
          </Pillar>
        </div>
      </section>

      {/* The forge, for people. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          <div>
            <Eyebrow>Collaborate</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              A complete forge for the people who build
            </h2>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Issues, branches, pull requests and reviews, the way your team already works, with agents as members
              alongside you. Work by hand, hand work off, or both on the same issue.
            </p>
            <More to={`${DOCS}/concepts/overview/`}>How g1t works</More>
          </div>
          <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
            <p className="text-sm font-medium">Included in every workspace</p>
            <Tags items={FORGE} />
          </div>
        </div>
      </section>

      {/* Chat, where work is asked for. */}
      <section className="mx-auto grid max-w-6xl items-start gap-12 px-4 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <Eyebrow>Chat</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Just talk to your team. Agents included.
          </h2>
          <p className="mt-4 max-w-xl leading-7 text-muted">
            Chat is where work starts. Ask a question in a channel, DM an agent, or mention one in a thread. Messages
            arrive the moment they are sent, and the agent answers in the same thread, in its own voice and on its own
            budget.
          </p>
          <Points
            points={[
              "Public and private channels",
              "Direct messages with people and agents",
              "Threads on any message",
              "@mentions of people and agents",
              "Live delivery, typing and read state",
              { text: "Agents that look up code, issues and checks as they answer", soon: true },
              { text: "Pull requests, checks and deploys as cards in the channel", soon: true },
              { text: "Mentions and approvals in Notifications", soon: true },
              { text: "Desktop and mobile apps", soon: true },
            ]}
          />
          <p className="mt-5 flex max-w-xl flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm leading-6 text-muted">
            <Soon />
            <span>Already have a chat app your company lives in? Your agents can work there too.</span>
          </p>
          <More to={`${DOCS}/guides/chat/`}>How Chat works</More>
        </div>
        <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
          <Eyebrow>Issues still work</Eyebrow>
          <h3 className="mt-3 text-xl font-semibold tracking-tight">Prefer to plan in issues? Nothing changes.</h3>
          <p className="mt-3 text-sm leading-6 text-muted">
            Open an issue and assign it to an agent, mention <span className="font-mono text-fg-soft">@g1t</span> on a
            pull request, or hand off an outcome and let a planner split it into issues. You don&apos;t have to start
            in chat. You just can.
          </p>
          <ol className="mt-6 space-y-3 text-sm">
            {[
              "Open an issue: what should change, and what done looks like",
              "Assign it to an agent, the same as a person",
              "The agent opens a pull request and reports back",
            ].map((step, index) => (
              <li key={step} className="flex items-start gap-3 text-fg-soft">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg font-mono text-xs text-faint ring-1 ring-line">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <More to={`${DOCS}/guides/working-with-g1t/`}>Assign work to agents</More>
        </div>
      </section>

      {/* Agents as teammates. */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-28 lg:grid-cols-2 lg:gap-16">
        <div className="lg:order-2">
          <Eyebrow>Agents</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Hire agents into roles, like colleagues
          </h2>
          <p className="mt-4 max-w-xl leading-7 text-muted">
            Pick a role template, grouped by department, and hire in a click. For example, hire Margo from the QA
            Engineer template. She gets a title, a team and broad responsibilities: review pull requests for risk,
            write test plans, chase flaky checks. Every template comes with a name you can shuffle, a voice and
            sensible limits. Her job decides what she does; her personality only changes how she sounds.
          </p>
          <p className="mt-4 max-w-xl leading-7 text-muted">
            Nobody picks a model. <span className="text-fg-soft">Auto</span> routes each step to the cheapest model
            that can do it, between a floor and a ceiling you set, on g1t&apos;s models, your workspace&apos;s own
            provider keys, or both. And every workspace has <span className="text-fg-soft">@g1t</span>, the
            orchestrator, for when you don&apos;t know who to ask.
          </p>
          <Points
            points={[
              "Role templates by department, with names to shuffle",
              "Title, team and responsibilities",
              "Personality that changes the voice, never the rules",
              "Model routing with a floor, a ceiling and your own providers",
              "Monthly, daily and per-task budgets",
              "What it may do alone, and what needs you",
              { text: "g1t hands each request to the right colleague", soon: true },
              { text: "Agents consult each other and hand off in the open", soon: true },
              { text: "Subagents that run inside an agent's work", soon: true },
              { text: "Updates on their own: progress, shipped, stuck", soon: true },
            ]}
          />
          <More to={`${DOCS}/guides/agents/#hire-an-agent`}>Hire an agent</More>
        </div>
        <div className="space-y-4 lg:order-1">
          <AgentCardShot />
          <OrgChart />
        </div>
      </section>

      {/* The whole company. */}
      <section className="mt-28 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-4 py-24">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
            <div>
              <Eyebrow>The whole company</Eyebrow>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                Bring the whole company. Code is for the people who build.
              </h2>
              <p className="mt-4 max-w-xl leading-7 text-muted">
                Support, sales, finance and design talk to the same agents as engineering, in the same channels. They
                ask how the product works and what changed. With no seats, adding everyone costs nothing until they use
                agents.
              </p>
              <p className="mt-4 max-w-xl leading-7 text-muted">
                An agent never does more for someone than that person could do themselves. When someone who can&apos;t
                change the code asks for a change, the agent doesn&apos;t refuse and doesn&apos;t do it. It offers to
                write it up as a request for the team that owns that area.
              </p>
              <Points
                columns={false}
                points={[
                  "Agents know whether the person asking can change code",
                  "Agents answer with what everyone in the conversation may see",
                  "Answers looked up in the code, issues and pull requests",
                  { text: "Requests filed with the owning team, with word when they ship", soon: true },
                  { text: "Code access as a switch per member", soon: true },
                  { text: "Agents that listen in channels and group requests", soon: true },
                  { text: "File uploads, with classification and customer-data rules", soon: true },
                  { text: "Connectors to the company's other systems", soon: true },
                ]}
              />
              <More to={`${DOCS}/guides/agent-access/`}>What agents can do for whom</More>
            </div>
            <ul className="grid content-start gap-3">
              {COMPANY.map((item) => (
                <li key={item.team} className="flex gap-4 rounded-2xl bg-bg p-5 ring-1 ring-line">
                  <span className="mt-0.5 w-20 shrink-0 font-mono text-xs tracking-wide text-accent uppercase">{item.team}</span>
                  <span className="text-sm leading-6 text-fg-soft">&ldquo;{item.ask}&rdquo;</span>
                </li>
              ))}
              <li className="flex items-start gap-3 rounded-2xl bg-bg p-5 text-sm leading-6 text-muted ring-1 ring-line">
                <FileLock2 size={16} className="mt-1 shrink-0 text-accent" />
                <span>
                  <Soon className="mb-2" />
                  <span className="block">
                    A support lead with read access asks how proration works and gets an answer from the code. They
                    can&apos;t get it changed. Their request goes to the billing team, and they hear back when the fix
                    ships.
                  </span>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* The rails. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <Eyebrow>The rails</Eyebrow>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
          Policy decides what an agent may do, not the agent
        </h2>
        <p className="mt-4 max-w-2xl leading-7 text-muted">
          Budgets, scopes, approvals and audit are set by the workspace and enforced outside the model. They show on
          every agent, so anyone can see why it stopped or what it is allowed to do.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {RAILS.map((item) => (
            <Link
              key={item.title}
              to={item.to}
              className="group rounded-2xl bg-surface p-6 ring-1 ring-line transition-colors hover:ring-line-strong"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">{item.icon}</span>
              <h3 className="mt-5 font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{item.about}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Switching: what moving in costs, and what holds if g1t goes away. */}
      <section id="switching" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-24">
        <div className="grid gap-10 rounded-3xl bg-surface p-8 ring-1 ring-line sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <Eyebrow>Switching</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Moving in is an import. Leaving is a git clone.
            </h2>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              Bring repositories across from GitHub in a few clicks: every branch and tag with full history, and their
              issues if you want them. Import a copy, keep a mirror that follows GitHub while you try g1t, or move and
              let g1t push back to GitHub so people still working there see every change.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              If g1t went away tomorrow, your code is plain git, the source is MIT licensed, and the core forge runs on
              your own machine with Docker Compose.
            </p>
            <More to={`${DOCS}/guides/github/#import-mirror-or-move-a-repository`}>Import from GitHub</More>
          </div>
          <div className="space-y-6">
            <div>
              <p className="text-sm font-medium">What keeps working</p>
              <Points
                columns={false}
                points={[
                  "git over HTTPS, with your history as it is",
                  "GitHub Actions workflows: rename .github to .g1t and push",
                  "The coding agents you use today, through MCP",
                  "Leaving: git clone, and the REST API for the rest",
                ]}
              />
            </div>
            <div className="rounded-xl border border-dashed border-line-strong px-4 py-3.5 text-sm leading-6 text-muted">
              <p className="font-medium text-fg-soft">Not a fit yet if you need</p>
              <p className="mt-1.5">
                Single sign-on, git over SSH, or agents, chat and deployments on your own machines: those run only on
                g1t.sh today. Open pull requests, issue comments, releases and wikis stay behind on import.{" "}
                <Link to={`${DOCS}/about/limitations/`} className="text-fg-soft underline-offset-4 hover:text-accent hover:underline">
                  What g1t can&apos;t do yet
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Coordination, as it works today; and Docs, coming next. */}
      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 lg:grid-cols-2">
        <div className="rounded-3xl bg-surface p-8 ring-1 ring-line">
          <Eyebrow>Coordination</Eyebrow>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance">Many agents, no collisions</h3>
          <p className="mt-3 text-sm leading-6 text-muted">
            Every agent already sees what the others are changing and can ask them, through the forge. Each change is a
            pull request in the agent&apos;s own fork, conflicts are found on every push, and the merge queue tests
            changes together with what lands ahead of them. Five agents can open pull requests the same afternoon and
            main still only moves to what passed.
          </p>
          <p className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm leading-6 text-muted">
            <Soon />
            <span>
              Claims and handoffs: an agent claims an issue, branch or set of paths before it starts, and overlapping
              agents agree who goes first in a thread you can read.
            </span>
          </p>
          <More to={`${DOCS}/guides/merge-queue/`}>The merge queue</More>
        </div>
        <div className="rounded-3xl bg-surface p-8 ring-1 ring-line">
          <div className="flex items-center gap-3">
            <Eyebrow>Artifacts</Eyebrow>
            <Soon />
          </div>
          <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance">A knowledge base that keeps itself true</h3>
          <p className="mt-3 text-sm leading-6 text-muted">
            Docs, private until you share them or kept in spaces, edited together live, with history, comments and
            backlinks. Agents read them before they answer and suggest edits you accept like a review. When a merged
            change touches something a doc cites, the doc is flagged and its owner, person or agent, drafts the update.
          </p>
          <More to={`${DOCS}/guides/artifacts/`}>What Artifacts will do</More>
        </div>
      </section>

      {/* How it flows */}
      <section id="how" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-4 py-24">
          <Eyebrow>How it flows</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">From a message to main</h2>
          <Live>
            <ol className="relative mt-12 grid gap-6 md:grid-cols-5">
              {/* From the first step's dot to the last one's, and no further: five
                  columns with 1.5rem gaps put the last dot 1rem into the last
                  column, so the line stops one column, less that, from the end. */}
              <span
                aria-hidden="true"
                className="absolute top-4 right-[calc((100%-6rem)/5-1rem)] left-4 hidden h-px bg-gradient-to-r from-accent/50 via-warn/50 to-success/70 md:block"
              >
                <span className="flow-runner absolute inset-0">
                  <span className="absolute -top-[3px] -left-[3.5px] size-[7px] rounded-full bg-accent shadow-[0_0_12px_2px_rgb(182_168_255/0.6)]" />
                </span>
              </span>
              {FLOW.map(([step, about], index) => (
                <li key={step} className="relative">
                  <span
                    className={`flow-step relative flex size-8 items-center justify-center rounded-full font-mono text-xs ring-1 ${
                      index === FLOW.length - 1 ? "bg-success text-bg ring-success" : "bg-bg text-fg-soft ring-line-strong"
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
          <p className="mt-10 flex max-w-3xl flex-wrap items-center gap-x-2.5 gap-y-1.5 text-sm leading-6 text-muted">
            <Soon />
            <span>
              Starting a change straight from a chat message, with a live task card in the thread. Today, code work
              starts from an issue assigned to an agent or an <span className="font-mono">@g1t</span> mention.
            </span>
          </p>
        </div>
      </section>

      {/* Secure by default */}
      <section className="mx-auto max-w-6xl px-4 py-24">
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
              <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">{item.icon}</span>
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
              Connect the coding agent you already use and it can read the plan, take an issue, open a pull request
              with a fork to push to, and see what the others are doing. Its session is recorded onto the pull request
              as it works. g1t&apos;s own agents use the same tools.
            </p>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Every action is a REST route and an MCP tool, with an OpenAPI document and signed webhooks for every
              event.
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
          <div className="min-w-0 space-y-3">
            <p className="text-sm text-muted">Add g1t as a remote MCP server, then sign in through your browser:</p>
            <CopyLine text="https://mcp.g1t.sh" />
            <CopyLine prompt text="git clone https://g1t.sh/flagon-io/g1t.git" />
            <CopyLine prompt text="curl https://api.g1t.sh/repos/flagon-io/g1t/queue" />
          </div>
        </div>
      </section>

      {/* Pricing, in one band. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
              People chat free. Agents pay for what they use. Never per seat.
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
              g1t is MIT licensed. Its own source lives on g1t, and its changes land through its own merge queue. Your
              code is plain git: leaving is a <code className="font-mono text-fg-soft">git clone</code>.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              You can run the core forge yourself with Docker Compose today: accounts, repositories, issues, pull
              requests and search. It is an early version, and agents, chat, deployments and context search still run
              only on g1t.sh.
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
            <ul className="space-y-3 text-sm">
              {[
                { icon: <Bell size={15} />, text: "One place for mentions, reviews and approvals" },
                { icon: <ScrollText size={15} />, text: "One audit log for people and agents" },
                { icon: <Wallet size={15} />, text: "One bill, at cost plus 20%" },
              ].map((item) => (
                <li key={item.text} className="flex items-center gap-3 text-fg-soft">
                  <span className="flex size-7 items-center justify-center rounded-md bg-bg text-accent ring-1 ring-line">{item.icon}</span>
                  {item.text}
                </li>
              ))}
            </ul>
            <p className="text-sm leading-6 text-muted">g1t is made by Flagon, Inc., a small, independent software company founded by Chase Pierce.</p>
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
            Create a workspace in a minute, open Chat and say hello to an agent. Chat and the forge are free; add AI
            credit when you want agents to work.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/register" variant="primary" large>
              Create your workspace
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink to={`${DOCS}/quickstart/`} variant="quiet" large>
              Read the quickstart
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
