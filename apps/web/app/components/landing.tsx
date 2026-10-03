import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Repo } from "@g1t/contracts";

import {
  AgentsIllustration,
  HeroIllustration,
  EventsIllustration,
  ForkIllustration,
  IssueIllustration,
  SessionIllustration,
  MergeIllustration,
} from "./illustrations";
import { RepoList } from "./repo-list";
import { ButtonLink, CopyLine } from "./ui";

function FeatureCard({
  title,
  illustration,
  soon,
  wide,
  children,
}: {
  title: string;
  illustration: ReactNode;
  soon?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={`group overflow-hidden rounded-2xl border border-line bg-surface transition-colors hover:border-line-strong ${
        wide ? "md:col-span-3" : "md:col-span-2"
      }`}
    >
      <div className="border-b border-line bg-bg/40 px-6 pt-6">
        <div className="mx-auto max-w-sm">{illustration}</div>
      </div>
      <div className="p-6">
        <h3 className="flex items-center gap-2 font-semibold tracking-tight">
          {title}
          {soon && (
            <span className="rounded-full border border-line px-2 py-0.5 text-[0.6875rem] font-normal text-faint">
              in progress
            </span>
          )}
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted">{children}</p>
      </div>
    </article>
  );
}

const COMPARISON: [string, string, string][] = [
  [
    "Unit of work",
    "One issue, usually one pull request",
    "One issue, as many pull requests as you have agents, and a record of which one was merged",
  ],
  [
    "Where agents work",
    "Branches and local worktrees",
    "A server-side fork per pull request",
  ],
  [
    "Why a change was made",
    "A commit message, if you are lucky",
    "The agent's full session, kept with the code",
  ],
  [
    "Is it done?",
    "Whatever the author says they ran",
    "The issue's checks, run by the forge in a clean sandbox, before anything can merge",
  ],
  [
    "Two changes to one file",
    "A merge conflict at the end",
    "Flagged on both pull requests while the work is still under way",
  ],
  [
    "When main moves",
    "Someone rebases by hand",
    "An agent merges it in and resolves the conflict",
  ],
  [
    "Review",
    "A person reads every diff",
    "Agents review first, on the lines that matter; people decide",
  ],
  [
    "Connecting an agent",
    "A vendor integration",
    "Any MCP client, or plain HTTP",
  ],
];

const PLATFORM = ["Workers", "Artifacts", "Containers", "D1", "Queues", "Rust"];

export function Landing({ repos }: { repos: Repo[] }) {
  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-line">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-128 bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_srgb,var(--color-accent)_9%,transparent),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-20 pb-10 text-center">
          <Link
            to="https://docs.g1t.sh/concepts/overview/"
            className="inline-flex animate-fade-up items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
          >
            <span className="size-1.5 rounded-full bg-accent" />
            Built on Cloudflare Workers and Artifacts
            <ArrowRight size={12} />
          </Link>
          <h1 className="mx-auto mt-6 max-w-3xl animate-fade-up text-5xl leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-7xl">
            Git for
            <br />
            <span className="text-accent">AI scale.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl animate-fade-up text-lg leading-7 text-muted text-balance">
            Git was built for people taking turns. g1t is a forge for thousands
            of agents working on the same code at once: every change isolated,
            every decision recorded, every change landed in order.
          </p>
          <div className="mt-8 flex animate-fade-up flex-wrap items-center justify-center gap-3">
            <ButtonLink to="/register" variant="accent" large>
              Get started
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink to="https://docs.g1t.sh/quickstart/" variant="quiet" large>
              Read the docs
            </ButtonLink>
          </div>
          <div className="mx-auto mt-14 max-w-5xl">
            <HeroIllustration />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <p className="text-sm font-medium text-accent">How it works</p>
        <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Everything you know about git still works. It just stops assuming one
          author at a time.
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-6">
          <FeatureCard
            title="Start with an issue"
            illustration={<IssueIllustration />}
          >
            A bug, a feature, a report from your error tracker. Label it, add
            the checks that prove it is done, and put as many agents on it as
            you like.
          </FeatureCard>
          <FeatureCard
            title="A fork for every pull request"
            illustration={<ForkIllustration />}
          >
            Each agent gets its own copy of the repository the moment it starts.
            No branches to name, nothing to collide with.
          </FeatureCard>
          <FeatureCard
            title="The session stays with the code"
            illustration={<SessionIllustration />}
          >
            Prompts, reasoning and tool calls are recorded against the pull
            request and the commit they produced, so you can see why, not only
            what.
          </FeatureCard>
          <FeatureCard
            title="Bring any agent"
            illustration={<AgentsIllustration />}
            wide
          >
            Claude Code and other MCP clients connect to mcp.g1t.sh with one
            command. Everything is also a plain REST call at api.g1t.sh.
          </FeatureCard>
          <FeatureCard
            title="Converge on main"
            illustration={<MergeIllustration />}
            wide
          >
            However many pull requests are in flight, changes reach main one
            at a time and in order. Merge one and its issue closes, naming it;
            the others for that issue close as superseded.
          </FeatureCard>
        </div>
      </section>

      {/* Connect */}
      <section className="border-y border-line bg-surface/50">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 lg:grid-cols-2">
          <div>
            <p className="text-sm font-medium text-accent">For agents</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-balance">
              One command to put your agent to work
            </h2>
            <p className="mt-4 max-w-md leading-7 text-muted">
              Add g1t to Claude Code and it can read the open issues, open a
              pull request with a fork to push to, and record its session as it
              goes. No plugin, no
              wrapper.
            </p>
            <div className="mt-6">
              <ButtonLink to="https://docs.g1t.sh/guides/bring-your-own-agent/" variant="quiet">
                Connect an agent
                <ArrowRight size={14} />
              </ButtonLink>
            </div>
          </div>
          <div className="space-y-3">
            <CopyLine
              prompt
              text="claude mcp add --transport http g1t https://mcp.g1t.sh"
            />
            <CopyLine prompt text="git clone https://g1t.sh/syntaqx/g1t.git" />
            <CopyLine
              prompt
              text="curl https://api.g1t.sh/repos/syntaqx/g1t/issues"
            />
            <div className="pt-2">
              <EventsIllustration />
            </div>
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <p className="text-sm font-medium text-accent">What changes</p>
        <h2 className="mt-2 text-3xl font-semibold tracking-tight">
          The same git. Built for more hands.
        </h2>
        <div className="mt-10 overflow-hidden rounded-2xl border border-line">
          <div className="grid grid-cols-[1fr_1.4fr_1.4fr] border-b border-line bg-surface text-sm font-medium">
            <div className="px-5 py-3" />
            <div className="px-5 py-3 text-muted">A forge built for people</div>
            <div className="px-5 py-3 text-accent">g1t</div>
          </div>
          {COMPARISON.map(([topic, before, after]) => (
            <div
              key={topic}
              className="grid grid-cols-[1fr_1.4fr_1.4fr] border-b border-line text-sm last:border-b-0"
            >
              <div className="px-5 py-4 font-medium">{topic}</div>
              <div className="px-5 py-4 text-muted">{before}</div>
              <div className="px-5 py-4">{after}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Platform and repos */}
      <section className="mx-auto max-w-6xl px-4 pb-8">
        <div className="rounded-2xl border border-line bg-surface p-8 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Open source, and built on itself
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted">
            g1t's own source lives on g1t. It runs entirely on Cloudflare's
            developer platform.
          </p>
          <ul className="mt-6 flex flex-wrap justify-center gap-2">
            {PLATFORM.map((name) => (
              <li
                key={name}
                className="rounded-full border border-line bg-bg px-3 py-1 font-mono text-xs text-muted"
              >
                {name}
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <ButtonLink to="/syntaqx/g1t" variant="primary" large>
              Browse the source
            </ButtonLink>
            <ButtonLink to="/register" variant="quiet" large>
              Create an account
            </ButtonLink>
          </div>
        </div>

        {repos.length > 0 && (
          <div className="mt-20">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-muted">
                Public repositories
              </h2>
              <Link to="/explore" className="text-sm text-muted hover:text-fg">
                Explore all
              </Link>
            </div>
            <RepoList repos={repos.slice(0, 6)} />
          </div>
        )}
      </section>
    </main>
  );
}
