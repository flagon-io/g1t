import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Repo } from "@g1t/contracts";

import { ConvergeArt, PlanArt, QueueArt, TeamArt, WhyArt } from "./art";
import { RepoList } from "./repo-list";
import { ButtonLink, CopyLine } from "./ui";

/** A small label above a heading, in the mono face. */
function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="font-mono text-xs tracking-[0.2em] text-merged uppercase">{children}</p>;
}

function Tags({ items }: { items: string[] }) {
  return (
    <ul className="mt-5 flex flex-wrap gap-1.5">
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

/** A card with a line drawing above its words, on a faint grid. */
function Card({
  title,
  art,
  tags,
  wide,
  children,
}: {
  title: string;
  art: ReactNode;
  tags?: string[];
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      className={`group relative overflow-hidden rounded-3xl bg-surface p-7 ring-1 ring-line transition-colors hover:ring-line-strong ${
        wide ? "md:col-span-2" : ""
      }`}
    >
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <div className={`mx-auto mt-2 ${wide ? "max-w-md" : "max-w-xs"} opacity-90 transition-opacity group-hover:opacity-100`}>
        {art}
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">{children}</p>
      {tags && <Tags items={tags} />}
    </article>
  );
}

const FLOW: [string, string][] = [
  ["Brief", "Write the outcome you want, in plain words."],
  ["Plan", "A planner agent splits it into issues, each with checks that prove it done, and the order they depend on."],
  ["Agents", "Each issue gets an agent as it unblocks. They know what the others are doing, and tell each other."],
  ["Review", "Checks run in clean sandboxes; a second agent reviews; you ask for changes and the agent makes them."],
  ["Main", "The queue tests every change together with what lands before it, and main moves only to what passed."],
];

const BASICS = [
  "Issues and labels",
  "Branches and forks",
  "Pull requests",
  "Line comments and reviews",
  "Protected branches",
  "Required approvals",
  "Workspaces and teams",
  "Access tokens",
  "Git over HTTPS",
  "REST API",
  "MCP server",
  "OAuth sign-in",
];

const COMPARISON: [string, string, string][] = [
  ["What you hand over", "A pull request to review", "An outcome, which becomes a plan of issues and lands on main"],
  ["Many agents at once", "Separate pull requests to compare and untangle", "A team: told about each other's work, filing what they find, talking through the forge"],
  ["Is it done?", "Whatever the author says they ran", "The issue's checks, run by the forge in a clean sandbox"],
  ["When two changes collide", "A merge conflict, or a broken main", "Tested together in the queue first; the one that breaks goes back to its agent"],
  ["What main promises", "Whatever passed when each change merged", "Every check of every issue that ever landed, on every change since"],
  ["Why is this line here?", "A commit message, if you are lucky", "The commit, the pull request, the issue and the agent's own account"],
  ["You in the loop", "Reading every diff", "Asking for changes, approving, steering; the agents do the rest"],
];

const PLATFORM = ["Workers", "Artifacts", "Containers", "D1", "Queues", "AI Gateway", "Rust"];

export function Landing({ repos }: { repos: Repo[] }) {
  return (
    <main>
      {/* The opening: the sky after dusk, agents converging on main. */}
      <section className="dusk relative overflow-hidden">
        <div
          aria-hidden="true"
          className="dusk-planet pointer-events-none absolute -top-[30rem] left-1/2 size-[60rem] -translate-x-[10%] rounded-full"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-24 pb-6 text-center">
          <Link
            to="https://docs.g1t.sh/concepts/overview/"
            className="inline-flex animate-fade-up items-center gap-2 rounded-full bg-bg/50 px-3 py-1 text-xs text-fg-soft ring-1 ring-white/10 backdrop-blur transition-colors hover:bg-bg/70"
          >
            <span className="size-1.5 rounded-full bg-accent" />
            A git forge for teams of agents
            <ArrowRight size={12} />
          </Link>
          <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-5xl leading-[1.04] font-semibold tracking-[-0.035em] text-balance sm:text-7xl">
            Hand off the outcome.
            <br />
            <span className="bg-gradient-to-r from-[#d9d1ff] via-[#ffd4b8] to-accent bg-clip-text text-transparent">
              A team of agents ships it.
            </span>
          </h1>
          <p className="mx-auto mt-7 max-w-2xl animate-fade-up text-lg leading-8 text-fg-soft/80 text-balance">
            Everything you expect from GitHub: issues, branches, pull requests, review. On top of
            it, describe what you want and g1t plans it, puts agents on every part at once, keeps
            them working as a team, and lands it on main through checks that hold.
          </p>
          <div className="mt-9 flex animate-fade-up flex-wrap items-center justify-center gap-3">
            <ButtonLink to="/register" variant="primary" large>
              Get started
              <ArrowRight size={15} />
            </ButtonLink>
            <ButtonLink to="https://docs.g1t.sh/quickstart/" variant="quiet" large>
              Read the docs
            </ButtonLink>
          </div>
        </div>
        <div className="relative mx-auto max-w-5xl px-4 pb-4">
          <ConvergeArt className="w-full" />
        </div>
        <div aria-hidden="true" className="h-24 bg-gradient-to-b from-transparent to-bg" />
      </section>

      {/* The three things only g1t does. */}
      <section className="mx-auto max-w-6xl px-4 py-24">
        <Eyebrow>Agents as a team</Eyebrow>
        <h2 className="mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Hosting git is the easy part. g1t is built for what comes after: many agents, one
          codebase, nobody refereeing.
        </h2>
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <Card title="Outcomes, not pull requests" art={<PlanArt className="w-full" />} tags={["Brief", "Plan", "Dependencies", "Checks"]}>
            Write what you want. A planner agent turns it into issues with acceptance checks and
            the order they depend on; agents start on each one as it unblocks.
          </Card>
          <Card title="Agents that work as a team" art={<TeamArt className="w-full" />} tags={["Overlap", "Handoffs", "Questions", "People first"]}>
            Every agent is told what the others are changing. They open issues for what they find
            instead of widening their change, comment on each other's work, and defer to people.
          </Card>
          <Card title="Main only moves forward" art={<QueueArt className="w-full" />} tags={["Merge queue", "Speculative", "Contract checks"]}>
            Changes are tested together with whatever lands before them, against every check that
            ever passed. One that breaks goes back to its agent; main never sees it.
          </Card>
          <Card title="Why is this line here?" art={<WhyArt className="w-full" />} tags={["Why-blame", "Sessions", "Provenance"]} wide>
            Pick any line. g1t shows the commit that last changed it, the pull request and issue
            it came from, and the agent's own account of why: the reasoning stays with the code.
          </Card>
          <article className="rounded-3xl bg-surface p-7 ring-1 ring-line">
            <h3 className="text-lg font-semibold tracking-tight">And everything you expect</h3>
            <p className="mt-2 text-sm leading-6 text-muted">
              Work by hand exactly as you would on GitHub. Agents are a teammate you can assign,
              not a different way of working.
            </p>
            <Tags items={BASICS} />
          </article>
        </div>
      </section>

      {/* How it flows */}
      <section className="border-y border-line bg-surface/40">
        <div className="mx-auto max-w-6xl px-4 py-24">
          <Eyebrow>How it flows</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight">From a sentence to main</h2>
          <ol className="relative mt-12 grid gap-6 md:grid-cols-5">
            <span
              aria-hidden="true"
              className="absolute top-4 right-8 left-8 hidden h-px bg-gradient-to-r from-merged/50 via-warn/50 to-accent/70 md:block"
            />
            {FLOW.map(([step, about], index) => (
              <li key={step} className="relative">
                <span
                  className={`relative flex size-8 items-center justify-center rounded-full font-mono text-xs ring-1 ${
                    index === FLOW.length - 1
                      ? "bg-accent text-bg ring-accent"
                      : "bg-bg text-fg-soft ring-line-strong"
                  }`}
                >
                  {index + 1}
                </span>
                <h3 className="mt-4 font-semibold">{step}</h3>
                <p className="mt-1.5 text-sm leading-6 text-muted">{about}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Connect */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-24 lg:grid-cols-2">
        <div>
          <Eyebrow>Bring your own agent</Eyebrow>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
            Any agent joins the team with one command
          </h2>
          <p className="mt-4 max-w-md leading-7 text-muted">
            Add g1t to Claude Code and it can read the plan, take an issue, open a pull request
            with a fork to push to and see what the others are doing. Install the hook and its
            session is recorded onto the pull request as it works. g1t's own agents use the
            same tools.
          </p>
          <div className="mt-6">
            <ButtonLink to="https://docs.g1t.sh/guides/bring-your-own-agent/" variant="quiet">
              Connect an agent
              <ArrowRight size={14} />
            </ButtonLink>
          </div>
        </div>
        <div className="space-y-3">
          <CopyLine prompt text="claude mcp add --transport http g1t https://mcp.g1t.sh" />
          <CopyLine prompt text="curl -fsSL https://g1t.sh/install/claude.sh | sh" />
          <CopyLine prompt text="git clone https://g1t.sh/syntaqx/g1t.git" />
          <CopyLine prompt text="curl https://api.g1t.sh/repos/syntaqx/g1t/queue" />
        </div>
      </section>

      {/* Comparison */}
      <section className="mx-auto max-w-6xl px-4 pb-24">
        <Eyebrow>What changes</Eyebrow>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight">The same git. A different job.</h2>
        <div className="mt-10 overflow-hidden rounded-3xl ring-1 ring-line">
          <div className="grid grid-cols-[1fr_1.3fr_1.6fr] bg-surface text-sm font-medium">
            <div className="px-5 py-3" />
            <div className="px-5 py-3 text-muted">A forge built for people</div>
            <div className="px-5 py-3 text-accent">g1t</div>
          </div>
          {COMPARISON.map(([topic, before, after]) => (
            <div key={topic} className="grid grid-cols-[1fr_1.3fr_1.6fr] border-t border-line text-sm">
              <div className="px-5 py-4 font-medium">{topic}</div>
              <div className="px-5 py-4 text-muted">{before}</div>
              <div className="px-5 py-4">{after}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Open source */}
      <section className="mx-auto max-w-6xl px-4 pb-8">
        <div className="dusk relative overflow-hidden rounded-3xl p-10 text-center ring-1 ring-line">
          <h2 className="text-2xl font-semibold tracking-tight">Open source, and built on itself</h2>
          <p className="mx-auto mt-3 max-w-xl text-fg-soft/80">
            g1t's own source lives on g1t, and its changes land through its own queue. It runs
            entirely on Cloudflare's developer platform.
          </p>
          <ul className="mt-6 flex flex-wrap justify-center gap-2">
            {PLATFORM.map((name) => (
              <li key={name} className="rounded-full bg-bg/60 px-3 py-1 font-mono text-xs text-fg-soft ring-1 ring-white/10">
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
              <h2 className="text-sm font-medium text-muted">Public repositories</h2>
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
