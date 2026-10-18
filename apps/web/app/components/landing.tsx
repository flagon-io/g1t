import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  CircleDashed,
  Code2,
  Eye,
  Handshake,
  Bell,
  KeyRound,
  Lock,
  MessagesSquare,
  PackageCheck,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

import { DeployArt, Live, QueueArt, WhyArt } from "./art";
import { NeedsYouArt, WhatChangedArt } from "./landing-home";
import { ProductTour } from "./product-tour";
import { ButtonLink, CopyLine } from "./ui";

const DOCS = "https://docs.g1t.sh";

/** A small label above a heading, in the mono face. */
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">
      {children}
    </p>
  );
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
    <Link
      to={to}
      className="group mt-7 inline-flex items-center gap-1.5 text-sm font-medium text-fg hover:text-accent"
    >
      {children}
      <ArrowRight
        size={14}
        className="transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

/**
 * A point in a list: a check, a check whose words link somewhere, or a
 * "Coming soon" tag for what is not built yet.
 */
type Point =
  | string
  | { text: string; link: { to: string; label: string } }
  | { text: string; soon: true };

function Points({
  points,
  columns = true,
}: {
  points: Point[];
  columns?: boolean;
}) {
  const now = points.filter((point) => typeof point === "string" || !("soon" in point));
  const later = points
    .filter((point) => typeof point !== "string" && "soon" in point)
    .map((point) => (point as { text: string }).text);
  return (
    <>
      <ul
        className={`mt-6 grid gap-2.5 text-sm ${columns ? "sm:grid-cols-2" : ""}`}
      >
        {now.map((point) =>
          typeof point === "string" ? (
            <li key={point} className="flex gap-2.5 text-fg-soft">
              <Check size={15} className="mt-0.5 shrink-0 text-accent" />
              <span>{point}</span>
            </li>
          ) : (
            "link" in point && (
              <li key={point.text} className="flex gap-2.5 text-fg-soft">
                <Check size={15} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  {point.text}{" "}
                  <Link
                    to={point.link.to}
                    className="text-fg underline underline-offset-4 hover:text-accent"
                  >
                    {point.link.label}
                  </Link>
                </span>
              </li>
            )
          ),
        )}
      </ul>
      {later.length > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-line-strong px-4 py-3.5">
          <Soon />
          <ul
            className={`mt-3 grid gap-2 text-sm ${columns ? "sm:grid-cols-2" : ""}`}
          >
            {later.map((text) => (
              <li key={text} className="flex gap-2.5 text-muted">
                <CircleDashed
                  size={14}
                  className="mt-0.5 shrink-0 text-faint"
                />
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
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          {title}
        </h3>
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

/** Facts under the opening. */
const FACTS: [string, string][] = [
  [
    "$0",
    "for people to chat. Every plan, the free one too, with no history cutoff.",
  ],
  [
    "0 seats",
    "Everyone in the company joins at one workspace price, never per person.",
  ],
  [
    "+20%",
    "on what compute costs g1t: checks, workflows and deployments. Your own runners are free.",
  ],
  [
    "MIT",
    "licensed. g1t's own source lives on g1t and lands through its own queue.",
  ],
];

/** What a workspace holds, and the coding agents it works with. */
const MODES: {
  icon: ReactNode;
  name: string;
  about: string;
  soon?: boolean;
  to: string;
}[] = [
  {
    icon: <Code2 size={18} />,
    name: "Code",
    about:
      "Repositories, work items, pull requests, checks, a merge queue and deployments. For the people who build.",
    to: `${DOCS}/concepts/overview/`,
  },
  {
    icon: <MessagesSquare size={18} />,
    name: "Chat",
    about:
      "Channels, direct messages and threads, live, for everyone in the company.",
    to: `${DOCS}/guides/chat/`,
  },
  {
    icon: <Bot size={18} />,
    name: "Your coding agents",
    about:
      "Claude Code, Codex, Cursor or any MCP client, working as you through MCP, the g1t CLI or the API, with only the access you give them.",
    to: `${DOCS}/guides/bring-your-own-agent/`,
  },
  {
    icon: <BookOpen size={18} />,
    name: "Artifacts",
    about:
      "Docs now, and slides, designs and dashboards next, made together live.",
    to: `${DOCS}/guides/artifacts/`,
  },
];

const RAILS: { icon: ReactNode; title: string; about: string; to: string }[] = [
  {
    icon: <KeyRound size={18} />,
    title: "Scopes",
    about:
      "A token or an OAuth app gets only the scopes you grant it, and never does more than you could do yourself.",
    to: `${DOCS}/guides/authentication/#access-tokens`,
  },
  {
    icon: <Handshake size={18} />,
    title: "Rules",
    about:
      "Protected branches, required checks and required approvals apply to every push and every merge, whoever made it.",
    to: `${DOCS}/guides/rules/`,
  },
  {
    icon: <Eye size={18} />,
    title: "Guardrails",
    about:
      "How long a project's checks and merge queue may run, enforced in g1t's sandboxes.",
    to: `${DOCS}/guides/guardrails/`,
  },
  {
    icon: <ScrollText size={18} />,
    title: "Audit",
    about:
      "Every action by people and tokens: who did it, through what, whether it was allowed and the rule that decided.",
    to: `${DOCS}/guides/audit-log/`,
  },
];

const FLOW: [string, string][] = [
  [
    "Ask",
    "Open a work item, or raise it in a channel: what should change, and what done looks like.",
  ],
  [
    "Change",
    "You or your coding agent push a branch and open a pull request. The agent's session is recorded onto it.",
  ],
  [
    "Check",
    "Required checks run on g1t's runners or your own, and the pull request gets a live preview.",
  ],
  [
    "Review",
    "A person reviews and approves. Rules and protected branches apply to everyone.",
  ],
  [
    "Main",
    "The queue tests each change with what lands before it. Production follows main.",
  ],
];

/** The forge itself, for the people who build. */
const FORGE = [
  "Git over HTTPS",
  "Public and private repositories",
  "Work items and labels",
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
  "The g1t CLI",
];

const SECURE: { icon: ReactNode; title: string; about: string; to: string }[] =
  [
    {
      icon: <ShieldCheck size={18} />,
      title: "Push protection",
      about:
        "A push that adds a key or a token is refused before it lands, and the history is scanned for ones already there.",
      to: `${DOCS}/guides/security/secret-protection/`,
    },
    {
      icon: <PackageCheck size={18} />,
      title: "Dependency upkeep",
      about:
        "Each vulnerable dependency that has a fixed version becomes an upgrade, landed through the same checks as any change.",
      to: `${DOCS}/guides/security/#security-updates`,
    },
    {
      icon: <ScanSearch size={18} />,
      title: "Code scanning",
      about:
        "Static analysis results become alerts, comments on the pull request that caused them, and a check that can block the merge.",
      to: `${DOCS}/guides/security/code-scanning/`,
    },
    {
      icon: <Lock size={18} />,
      title: "Supply chain",
      about:
        "The dependency graph, an SBOM of it, and dependency review on every pull request that changes what you depend on.",
      to: `${DOCS}/guides/security/supply-chain/`,
    },
  ];

const PRICES: { name: string; price: string; unit?: string; about: string }[] =
  [
    {
      name: "People",
      price: "$0",
      unit: "to chat",
      about:
        "Channels, DMs, threads and the forge are included on every plan, free too. No seats and no history cutoff.",
    },
    {
      name: "The g1t plan",
      price: "$21",
      unit: "a month per workspace",
      about:
        "$10 of usage included. Unlimited members. Checks, workflows, the merge queue and deployments.",
    },
    {
      name: "Usage",
      price: "From cost + 20%",
      about:
        "Checks, workflows, deployments and storage, priced from what they cost g1t plus 20%. Time on your own runners costs nothing.",
    },
  ];

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
          className="dusk-planet pointer-events-none absolute -top-120 left-1/2 size-240 translate-x-[-10%] rounded-full"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-20 text-center sm:pt-24">
          <Link
            to={`${DOCS}/guides/bring-your-own-agent/`}
            className="inline-flex animate-fade-up items-center gap-2 rounded-full bg-bg/50 px-3 py-1 text-xs whitespace-nowrap text-fg-soft ring-1 ring-line backdrop-blur transition-colors hover:bg-bg/70"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-accent" />
            <span className="sm:hidden">Works with Claude Code, Codex and Cursor</span>
            <span className="hidden sm:inline">Works with Claude Code, Codex, Cursor and any MCP client</span>
            <ArrowRight size={12} className="shrink-0" />
          </Link>
          <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-[2.75rem] leading-[1.04] font-semibold tracking-tight text-balance sm:text-7xl">
            Where your team&apos;s code{" "}
            <span className="bg-linear-to-r from-fg via-accent-high to-accent bg-clip-text text-transparent">
              lands, whoever wrote it.
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl animate-fade-up text-lg leading-8 text-fg-soft/80 text-balance">
            Start each day on Home: what landed, what is live, and what needs
            you next. Behind it, repositories, pull requests, required checks,
            a merge queue and deployments, with chat and docs for your team.
            Connect the coding agents you already use, and their work lands
            through the same checks as everyone&apos;s.
          </p>
          <div className="mt-9 flex animate-fade-up flex-wrap items-center justify-center gap-3">
            <ButtonLink to="/register" size="lg" className="rounded-full">
              Get started
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink
              to="#how"
              variant="outline"
              size="lg"
              className="rounded-full"
            >
              See how it works
            </ButtonLink>
          </div>
          <p className="mx-auto mt-5 max-w-xl animate-fade-up text-sm text-fg-soft/60 text-balance">
            Chat and the forge are free, with no card. No seats, ever.
          </p>
        </div>
        <div className="relative mx-auto max-w-5xl px-4 pt-14 pb-2">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-10 top-10 bottom-0 rounded-[3rem] bg-[radial-gradient(60%_60%_at_50%_40%,rgb(182_168_255/0.14),transparent)] blur-2xl"
          />
          <ProductTour className="relative" />
        </div>
        <div
          aria-hidden="true"
          className="h-16 bg-linear-to-b from-transparent to-bg"
        />
      </section>

      {/* Facts. */}
      <section className="relative z-10 mx-auto max-w-6xl px-4">
        <dl className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {FACTS.map(([figure, about]) => (
            <div key={figure} className="bg-bg px-6 py-6">
              <dt className="font-mono text-2xl font-medium tracking-tight text-fg">
                {figure}
              </dt>
              <dd className="mt-2 text-sm leading-6 text-muted">{about}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Home: where the day starts. */}
      <section id="home" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>Home</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Start every day knowing where things stand.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Home is your daily update and your way into the forge. g1t keeps
            track of everything your team and its coding agents did, clears
            what resolved itself, tells you in plain English what changed and
            what is live, and takes you straight to what is yours to decide: a
            merge, a review, a fix.
          </p>
        </div>

        <div className="mt-6 divide-y divide-line">
          <Pillar
            eyebrow="Where you're needed"
            title="Only what still needs you"
            art={<NeedsYouArt />}
            points={[
              "Notifications that settle themselves",
              "Why each one settled, and who did it",
              "Pull requests ready for you to merge",
              "Reviews asked of you, by name",
              "Start here: the one to do first, and why",
            ]}
            more={["Home", `${DOCS}/guides/home/`]}
          >
            A notification is done once a later event resolves it: the next run
            passes, the pull request merges, the fix deploys. g1t settles it
            for you, and Home shows only what still waits on you. Start here
            picks the one to do first and opens it.
          </Pillar>

          <Pillar
            flip
            eyebrow="What changed"
            title="Come back to what changed, in plain English"
            art={<WhatChangedArt />}
            points={[
              "A summary of what landed since you were last here",
              "Whether each change is live, deploying or failed",
              "Explain on any change that landed",
              "Ask a follow-up, in your direct message with g1t",
            ]}
            more={["Ask g1t", `${DOCS}/guides/ask/`]}
          >
            Home asks &ldquo;What are we building today?&rdquo; Press
            Summarize and What changed reads the commits, pull requests, deploys
            and conversations since you were last here, then tells you what
            changed, why, and what is live. Explain any one change, or ask a
            follow-up. It runs on your workspace&apos;s own AI provider.
          </Pillar>
        </div>
      </section>

      {/* What a workspace holds. */}
      <section className="mx-auto max-w-6xl px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>One workspace</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Talk, write it down, ship.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Home, Code, Chat and Artifacts share one set of members, one
            sign-in and one bill. The coding agents you connect work as you, through MCP,
            the g1t CLI and the API.
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
                <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">
                  {mode.icon}
                </span>
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
            A forge built for many changes at once.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Underneath is plain git. Every change, whether you wrote it or
            your coding agent did, is a pull request: checked, reviewed, and
            landed through a queue that keeps main passing.
          </p>
        </div>

        <div className="mt-6 divide-y divide-line">
          <Pillar
            eyebrow="Ship safely"
            title="Main only moves to what passed"
            art={<QueueArt className="w-full" />}
            points={[
              "Checks in a clean sandbox, or free on your own runners",
              "Your computer as a runner, with the desktop app",
              "A merge queue that tests changes together",
              "Conflicts found on every push, before a merge",
              "Catch up with main in seconds",
              "Required reviews, with code owners",
            ]}
            more={["The merge queue", `${DOCS}/guides/merge-queue/`]}
          >
            Required checks run on g1t&apos;s runners, or free on your own: a
            server, or your computer while the desktop app is open. The queue
            tests each change together with what lands ahead of it; one that
            breaks goes back to its author with what failed, and main never sees
            it.
          </Pillar>

          <Pillar
            flip
            eyebrow="Context"
            title="Every line knows why it is there"
            art={<WhyArt className="w-full" />}
            points={[
              "Sessions recorded onto pull requests",
              "Why-blame on any line",
              "Decisions recorded with the reasons behind them",
              "Search across code, work items and people",
            ]}
            more={["Sessions and why-blame", `${DOCS}/guides/why-blame/`]}
          >
            Pick any line. g1t shows the commit that changed it, the pull
            request and work item it came from, and the session your coding agent
            recorded as it worked: what it read, ran and decided. The reasoning
            stays with the code, for people and for the next agent.
          </Pillar>

          <Pillar
            eyebrow="Run it"
            title="Every change, live on the edge"
            art={<DeployArt className="w-full" />}
            points={[
              "A live preview for every pull request",
              "Production on every merge to main",
              "Custom domains, with certificates",
              "A new app from one sentence on Home",
            ]}
            more={["Deployments", `${DOCS}/guides/deployments/`]}
          >
            Turn on deployments and every pull request gets its own address on
            g1t.page; merging ships production. Reviewers click through a
            change instead of reading a diff. An app nobody visits runs nothing
            and costs nothing. Or start from Home: ask for something new, and one
            click makes its repository, starts your coding agent on it and puts
            the first version live.
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
              Work items, branches, pull requests and reviews, the way your team
              already works. Write a change by hand, have your coding agent
              write it, or both on the same branch.
            </p>
            <More to={`${DOCS}/concepts/overview/`}>How g1t works</More>
          </div>
          <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
            <p className="text-sm font-medium">Included in every workspace</p>
            <Tags items={FORGE} />
          </div>
        </div>
      </section>

      {/* Chat, where people talk about the work. */}
      <section className="mx-auto grid max-w-6xl items-start gap-12 px-4 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
        <div>
          <Eyebrow>Chat</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Just talk to your team.
          </h2>
          <p className="mt-4 max-w-xl leading-7 text-muted">
            Chat is where your team talks about the work, next to the code it
            is about. Ask a question in a channel, DM a colleague, or reply in
            a thread. Messages arrive the moment they are sent, and everyone in
            the company can join for free.
          </p>
          <More to={`${DOCS}/guides/chat/`}>How Chat works</More>
        </div>
        <div className="rounded-3xl bg-surface p-7 ring-1 ring-line">
          <p className="text-sm font-medium">Free on every plan</p>
          <Points
            columns={false}
            points={[
              "Private, workspace and public channels",
              "Direct messages",
              "Threads on any message",
              "@mentions",
              "Live delivery, typing and read state",
              "A desktop app for Windows, macOS and Linux",
              {
                text: "An Android app with notifications: scan the QR code on",
                link: { to: "/download", label: "Download" },
              },
              {
                text: "Pull requests, checks and deploys as cards in the channel",
                soon: true,
              },
              { text: "Chat mentions in Notifications", soon: true },
              { text: "The phone app on iPhone", soon: true },
            ]}
          />
        </div>
      </section>

      {/* Agents: they do the work, you make the calls. */}
      <section id="agents" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-24">
        <div className="max-w-3xl">
          <Eyebrow>Agents</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Agents do the work. You make the calls.
          </h2>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-muted">
            Your coding agents push the branches and open the pull requests,
            and their work lands through the same checks as everyone&apos;s.
            You decide what they take on and what ships.
          </p>
        </div>

        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl bg-surface p-7 ring-1 ring-line sm:p-8">
            <Eyebrow>Work</Eyebrow>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance">
              Point your coding agent at a work item
            </h3>
            <p className="mt-3 text-sm leading-6 text-muted">
              Your coding agent connects to g1t through MCP and works as you. It
              reads the work item, pushes a branch, opens the pull request and
              records its session onto it, and the pull request goes through
              the same checks and reviews as anyone&apos;s.
            </p>
            <ol className="mt-6 space-y-3 text-sm">
              {[
                "Open a work item: what should change, and what done looks like",
                "Work it yourself, or hand it to your coding agent",
                "The pull request runs your checks and lands through the queue",
              ].map((step, index) => (
                <li key={step} className="flex items-start gap-3 text-fg-soft">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg font-mono text-xs text-faint ring-1 ring-line">
                    {index + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
            <More to={`${DOCS}/guides/bring-your-own-agent/`}>
              Connect a coding agent
            </More>
          </div>
          <div className="rounded-3xl bg-surface p-7 ring-1 ring-line sm:p-8">
            <Eyebrow>Coordination</Eyebrow>
            <h3 className="mt-3 text-2xl font-semibold tracking-tight text-balance">
              Many agents, no collisions
            </h3>
            <p className="mt-3 text-sm leading-6 text-muted">
              Run as many coding agents as you like. Each claims the work item it
              takes, and every session shows live as it works, so everyone sees
              who is on what. Two that start changing the same files are told
              while they work, before either opens a pull request. The merge
              queue tests changes together with what lands ahead of them, and
              one that breaks another goes back to the session that caused it,
              with the change it breaks and the check that failed. Five agents
              can open pull requests the same afternoon and main still only
              moves to what passed.
            </p>
            <More to={`${DOCS}/work/claims-and-dependencies/`}>Sessions, claims and overlaps</More>
          </div>
        </div>
      </section>

      {/* Connect */}
      <section className="mt-24 border-y border-line bg-surface/40">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 lg:grid-cols-2">
          <div>
            <Eyebrow>Bring your own agent</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Any agent that speaks MCP works on g1t
            </h2>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Connect Claude Code, Codex, Cursor or any other MCP client and
              sign in once. It works as you: it reads work items, pushes branches,
              opens pull requests, and records its session and its decisions
              onto them.
            </p>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Every action is a REST route and an MCP tool, with an OpenAPI
              document, OAuth apps, access tokens and signed webhooks for every
              event. The g1t CLI does the same from a terminal or a script:
              open a pull request, wait on its checks, read a failed run&apos;s
              logs.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink
                to={`${DOCS}/guides/bring-your-own-agent/`}
                variant="outline"
              >
                Connect an agent
                <ArrowRight size={14} />
              </ButtonLink>
              <ButtonLink to={`${DOCS}/guides/cli/`} variant="outline">
                The g1t CLI
              </ButtonLink>
              <ButtonLink to={`${DOCS}/reference/api/`} variant="outline">
                API reference
              </ButtonLink>
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <p className="text-sm text-muted">
              Add g1t as a remote MCP server, then sign in through your browser:
            </p>
            <CopyLine text="https://mcp.g1t.sh" />
            <p className="pt-3 text-sm text-muted">
              Install the CLI, then sign in with{" "}
              <code className="font-mono text-fg-soft">g1t auth login</code>:
            </p>
            <CopyLine prompt text="curl -fsSL https://g1t.sh/install | sh" />
            <p className="pt-3 text-sm text-muted">
              Underneath, it is plain git and HTTP:
            </p>
            <CopyLine
              prompt
              breakAtSlashes
              text="git clone https://g1t.sh/flagon-io/g1t.git"
            />
            <CopyLine
              prompt
              breakAtSlashes
              text="curl https://api.g1t.sh/repos/flagon-io/g1t/queue"
            />
          </div>
        </div>
      </section>

      {/* Artifacts: the docs the work cites. */}
      <section className="mx-auto max-w-6xl px-4 pt-24">
        <div className="grid gap-10 rounded-3xl bg-surface p-8 ring-1 ring-line sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <Eyebrow>Artifacts</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              A knowledge base that keeps itself true
            </h2>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              Docs, private until you share them or kept in spaces, edited
              together live, with history, comments and backlinks. When a merged
              change touches something a doc cites, the doc is flagged for its
              owner to update.
            </p>
            <More to={`${DOCS}/guides/artifacts/`}>How Artifacts work</More>
          </div>
          <div>
          <Points
            columns={false}
            points={[
              "Docs edited together live",
              "History, comments and backlinks",
              "Flagged when a merged change touches what they cite",
              { text: "Slides, designs and dashboards", soon: true },
            ]}
          />
          </div>
        </div>
      </section>

      {/* The rails. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <Eyebrow>The rails</Eyebrow>
        <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
          Rules decide what lands, not whoever wrote it
        </h2>
        <p className="mt-4 max-w-2xl leading-7 text-muted">
          Scopes, rules, guardrails and audit are set by the workspace and
          enforced by g1t. They hold the same for a person at a keyboard and
          for the coding agent working as them.
        </p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {RAILS.map((item) => (
            <Link
              key={item.title}
              to={item.to}
              className="group rounded-2xl bg-surface p-6 ring-1 ring-line transition-colors hover:ring-line-strong"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">
                {item.icon}
              </span>
              <h3 className="mt-5 font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{item.about}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* How it flows */}
      <section
        id="how"
        className="scroll-mt-20 border-y border-line bg-surface/40"
      >
        <div className="mx-auto max-w-6xl px-4 py-24">
          <Eyebrow>How it flows</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">
            From a work item to main
          </h2>
          <Live>
            <ol className="relative mt-12 grid gap-6 md:grid-cols-5">
              {/* From the first step's dot to the last one's, and no further: five
                  columns with 1.5rem gaps put the last dot 1rem into the last
                  column, so the line stops one column, less that, from the end. */}
              <span
                aria-hidden="true"
                className="absolute top-4 right-[calc((100%-6rem)/5-1rem)] left-4 hidden h-px bg-linear-to-r from-accent/50 via-warn/50 to-success/70 md:block"
              >
                <span className="flow-runner absolute inset-0">
                  <span className="absolute -top-0.75 left-[-3.5px] size-1.75 rounded-full bg-accent shadow-[0_0_12px_2px_rgb(182_168_255/0.6)]" />
                </span>
              </span>
              {FLOW.map(([step, about], index) => (
                <li key={step} className="relative">
                  <span
                    className={`flow-step relative flex size-8 items-center justify-center rounded-full font-mono text-xs ring-1 ${
                      index === FLOW.length - 1
                        ? "bg-success text-bg ring-success"
                        : "bg-bg text-fg-soft ring-line-strong"
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
              <span className="flex size-9 items-center justify-center rounded-lg bg-bg text-accent ring-1 ring-line">
                {item.icon}
              </span>
              <h3 className="mt-5 font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{item.about}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Switching: what moving in costs, and what holds if g1t goes away. */}
      <section
        id="switching"
        className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-24"
      >
        <div className="grid gap-10 rounded-3xl bg-surface p-8 ring-1 ring-line sm:p-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <Eyebrow>Switching</Eyebrow>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Moving in is an import. Leaving is a git clone.
            </h2>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              Bring repositories across from GitHub in a few clicks: every
              branch and tag with full history, and their issues as work items if you want
              them. The copy on g1t is then your own.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              If g1t went away tomorrow, your code is plain git, the source is
              MIT licensed, and the core forge runs on your own machine with
              Docker Compose.
            </p>
            <More
              to={`${DOCS}/guides/github/#import-a-repository`}
            >
              Import from GitHub
            </More>
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
              <p className="font-medium text-fg-soft">
                Not a fit yet if you need
              </p>
              <p className="mt-1.5">
                Single sign-on, git over SSH, or chat and deployments on your
                own machines: those run only on g1t.sh today. Open pull
                requests, issue comments, releases and wikis stay behind on
                import.{" "}
                <Link
                  to={`${DOCS}/about/limitations/`}
                  className="text-fg-soft underline-offset-4 hover:text-accent hover:underline"
                >
                  What g1t can&apos;t do yet
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing, in one band. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-balance">
              People chat free. Pay for what runs. Never per seat.
            </h2>
          </div>
          <More to="/pricing">See every price</More>
        </div>
        <div className="mt-10 grid gap-px overflow-hidden rounded-3xl bg-line ring-1 ring-line md:grid-cols-3">
          {PRICES.map((item) => (
            <div key={item.name} className="bg-surface p-7">
              <p className="text-sm text-muted">{item.name}</p>
              <p className="mt-3 flex flex-wrap items-baseline gap-x-2">
                <span className="text-3xl font-semibold tracking-tight">
                  {item.price}
                </span>
                {item.unit && (
                  <span className="text-sm text-muted">{item.unit}</span>
                )}
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
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Open, and built on itself
            </h2>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              g1t is MIT licensed. Its own source lives on g1t, and its changes
              land through its own merge queue. Your code is plain git: leaving
              is a <code className="font-mono text-fg-soft">git clone</code>.
            </p>
            <p className="mt-4 max-w-xl leading-7 text-muted">
              You can run the core forge yourself with Docker Compose today:
              accounts, repositories, work items, pull requests and search. It is an
              early version, and chat and deployments still run only on g1t.sh.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <ButtonLink to="/flagon-io/g1t" variant="outline">
                Browse the source
              </ButtonLink>
              <ButtonLink to={`${DOCS}/guides/self-hosting/`} variant="outline">
                Run g1t yourself
              </ButtonLink>
            </div>
          </div>
          <div className="flex flex-col justify-between gap-6">
            <ul className="space-y-3 text-sm">
              {[
                {
                  icon: <Bell size={15} />,
                  text: "One place for mentions, reviews and approvals",
                },
                {
                  icon: <ScrollText size={15} />,
                  text: "One audit log for people and tokens",
                },
                {
                  icon: <Wallet size={15} />,
                  text: "One bill, priced from cost plus 20%",
                },
              ].map((item) => (
                <li
                  key={item.text}
                  className="flex items-center gap-3 text-fg-soft"
                >
                  <span className="flex size-7 items-center justify-center rounded-md bg-bg text-accent ring-1 ring-line">
                    {item.icon}
                  </span>
                  {item.text}
                </li>
              ))}
            </ul>
            <p className="text-sm leading-6 text-muted">
              g1t is made by Flagon, Inc.
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
            Anyone can sign up. Create a workspace in a minute, push a
            repository and connect the coding agent you already use. Chat and
            the forge are free.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/register" size="lg" className="rounded-full">
              Get started
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink
              to={`${DOCS}/quickstart/`}
              variant="outline"
              size="lg"
              className="rounded-full"
            >
              Read the quickstart
            </ButtonLink>
          </div>
        </div>
      </section>
    </main>
  );
}
