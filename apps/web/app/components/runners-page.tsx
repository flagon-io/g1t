import { ArrowRight, Bot, Boxes, Cloud, Cpu, Laptop, Plus, ServerCog, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { RUN_KIND_LABEL, type Runner, type RunKind } from "@g1t/contracts";

import { money } from "../lib/money";
import { type CloudWork, machineTime, perMinute } from "../lib/runners";
import type { RunnersAction, RunnersPageData } from "../lib/runners.server";
import { Groups, NewRunner, RunnerRow, RunnerSettingsForm, STATUS } from "./runners";
import { EmptyState, ErrorText, TimeAgo } from "./ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** The most of what runs on g1t's cloud the card lists before saying how many more. */
const CLOUD_SHOWN = 6;

/** A small label that something is coming. */
function Coming() {
  return <span className="shrink-0 rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">Coming</span>;
}

function Section({ id, title, about, action, children }: { id?: string; title: string; about?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {about && <div className="mt-0.5 text-sm text-muted">{about}</div>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One figure in a place's card: a label and its value. */
function Figure({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-sm">
      <dt className="text-muted">
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-4">{label}</span>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
      </dt>
      <dd className="min-w-0 text-right text-fg tabular-nums">{children}</dd>
    </div>
  );
}

function Unknown({ what }: { what: string }) {
  return <span className="text-faint">{what} didn&apos;t answer</span>;
}

function PlaceCard({ icon, title, tag, about, headline, children }: { icon: ReactNode; title: string; tag: ReactNode; about: string; headline: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-line bg-surface">
      <header className="px-5 pt-4">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-raised text-fg-soft">{icon}</span>
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="ml-auto">{tag}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted">{about}</p>
      </header>
      <div className="px-5 pt-4">{headline}</div>
      <dl className="mt-2 divide-y divide-line border-t border-line px-5 py-1">{children}</dl>
    </section>
  );
}

function kindLabel(work: CloudWork): string {
  if (work.kind === "workflow") return "Workflow job";
  return RUN_KIND_LABEL[work.detail as RunKind] ?? "Agent run";
}

function CloudList({ data }: { data: RunnersPageData }) {
  const cloud = data.cloud;
  if (!cloud) return <p className="px-5 py-4 text-sm text-muted">What runs on g1t&apos;s cloud can&apos;t be read right now.</p>;
  if (cloud.running.length === 0) {
    return (
      <p className="px-5 py-4 text-sm text-muted">
        Nothing is running here now. A sandbox starts for each agent run or job and stops when it ends{cloud.queued > 0 ? `; ${cloud.queued} waiting to start` : ""}.
      </p>
    );
  }
  const shown = cloud.running.slice(0, CLOUD_SHOWN);
  const rest = cloud.running.length - shown.length;
  return (
    <ul className="divide-y divide-line">
      {shown.map((work) => (
        <li key={`${work.kind}:${work.id}`} className="flex items-center gap-3 px-5 py-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-info/12 text-info" aria-hidden>
            {work.kind === "agent" ? <Bot size={13} /> : <Workflow size={13} />}
          </span>
          <div className="min-w-0 grow">
            <Link to={work.href} className="block truncate text-sm text-fg hover:underline">
              {work.title}
            </Link>
            <p className="truncate text-xs text-muted">
              {kindLabel(work)} · {work.repo}
            </p>
          </div>
          {work.startedAt && (
            <span className="shrink-0 text-xs text-faint">
              <TimeAgo at={work.startedAt} />
            </span>
          )}
        </li>
      ))}
      {(rest > 0 || cloud.more || cloud.queued > 0) && (
        <li className="px-5 py-2.5 text-xs text-muted">
          {[rest > 0 || cloud.more ? `${rest > 0 ? rest : "More"}${cloud.more ? "+" : ""} more running` : null, cloud.queued > 0 ? `${cloud.queued} waiting to start` : null]
            .filter(Boolean)
            .join(" · ")}
        </li>
      )}
    </ul>
  );
}

function StatusCounts({ runners }: { runners: Runner[] }) {
  const counts = { busy: 0, online: 0, offline: 0 } as Record<Runner["status"], number>;
  for (const runner of runners) counts[runner.status] += 1;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {(["busy", "online", "offline"] as const).map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${STATUS[status].dot}`} aria-hidden />
          <span className="text-fg tabular-nums">{counts[status]}</span> {STATUS[status].label.toLowerCase()}
        </li>
      ))}
    </ul>
  );
}

/** The workspace's Runners page: g1t's cloud and its own runners, side by side. */
export function RunnersPage({ data, action, slug }: { data: RunnersPageData; action: RunnersAction | undefined; slug: string }) {
  const own = data.runners;
  const online = own.filter((runner) => runner.status !== "offline").length;
  const cost = data.cost;
  const running = data.cloud?.running.length ?? null;
  const usage = `/${slug}/-/usage`;
  return (
    <div className="space-y-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">Runners</h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
            The machines your agents and workflow jobs run on. g1t&apos;s cloud needs nothing set up; your own runners are any machine with{" "}
            <code className="font-mono text-fg-soft">g1t-runner</code> on it, and time on them is free.
          </p>
        </div>
        <a
          href="#add"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 self-start rounded-lg bg-accent px-3.5 text-sm font-medium text-bg transition-colors hover:bg-accent-hover"
        >
          <Plus size={15} />
          Add a runner
        </a>
      </header>

      {(action?.notice || action?.error || data.error) && (
        <div>
          {action?.notice && <p className="text-sm text-success">{action.notice}</p>}
          <ErrorText>{action?.error ?? data.error ?? null}</ErrorText>
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <PlaceCard
          icon={<Cloud size={15} />}
          title="g1t cloud"
          tag={<span className="rounded-full bg-raised px-2 py-0.5 text-xs text-fg-soft">Managed by g1t</span>}
          about="A fresh sandbox for every agent run and workflow job, stopped when it ends. Billed by the second at the price below."
          headline={
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">{running ?? "–"}</span>
              <span className="text-sm text-muted">running now</span>
            </div>
          }
        >
          <Figure label="This month" hint="Agent sandbox time and sandbox time on your usage, at price, from the first of the month.">
            {cost ? (
              <>
                {machineTime(cost.cloudSeconds)} · {money(cost.cloudMicros)}
              </>
            ) : (
              <Unknown what="Billing" />
            )}
          </Figure>
          {data.prices ? (
            <Figure label="Price" hint={`From g1t's price book: ${data.prices.map((price) => price.title).join("; ")}.`}>
              <span className="flex flex-wrap justify-end gap-x-1">
                {data.prices.map((price, at) => (
                  <span key={price.meter} className="whitespace-nowrap">
                    {at > 0 && "+ "}
                    {perMinute(price.perMinuteMicros)}/{price.unit}
                  </span>
                ))}
              </span>
            </Figure>
          ) : (
            <Figure label="Price">
              <Unknown what="Billing" />
            </Figure>
          )}
          {data.agentCap != null && (
            <Figure label="Agent runs at once" hint="Your plan's cap on agent runs at the same time.">
              up to {data.agentCap}
            </Figure>
          )}
        </PlaceCard>

        <PlaceCard
          icon={<ServerCog size={15} />}
          title="Your runners"
          tag={<span className="rounded-full bg-success/12 px-2 py-0.5 text-xs font-medium text-success">Free</span>}
          about="Your own machines: Linux, macOS or Windows, anywhere they can reach g1t. They only connect out, and take the work whose labels they have."
          headline={
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tracking-tight tabular-nums">{own.length === 0 ? 0 : online}</span>
                <span className="text-sm text-muted">{own.length === 0 ? "runners yet" : `of ${own.length} online`}</span>
              </div>
              {own.length > 0 && <StatusCounts runners={own} />}
            </div>
          }
        >
          <Figure label="This month" hint="Self-hosted runner time on your usage, from the first of the month. It is never charged.">
            {cost ? (
              <>
                {machineTime(cost.ownSeconds)} · {money(0)}
              </>
            ) : (
              <Unknown what="Billing" />
            )}
          </Figure>
          <Figure label="Waiting for one of them">
            {data.waiting ? (
              data.waiting.jobs + data.waiting.tasks === 0 ? (
                "Nothing"
              ) : (
                [
                  data.waiting.jobs > 0 ? `${data.waiting.jobs} ${data.waiting.jobs === 1 ? "job" : "jobs"}` : null,
                  data.waiting.tasks > 0 ? `${data.waiting.tasks} agent ${data.waiting.tasks === 1 ? "run" : "runs"}` : null,
                ]
                  .filter(Boolean)
                  .join(", ")
              )
            ) : (
              <Unknown what="Actions" />
            )}
          </Figure>
          <Figure label="Takes agent work">
            {data.settings ? (data.settings.agentsOnSelfHosted ? `Yes, labelled ${data.settings.agentLabels.join(", ")}` : "No") : "–"}
          </Figure>
        </PlaceCard>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Section title="On g1t cloud now" about="Agent runs and workflow jobs in g1t's sandboxes.">
          <div className="rounded-2xl border border-line bg-surface">
            <CloudList data={data} />
          </div>
        </Section>
        <Section
          title="Machine time"
          about={cost ? `${cost.from} to ${cost.until}, as your usage shows it.` : "From your usage."}
          action={
            <Link to={usage} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              Usage
              <ArrowRight size={12} />
            </Link>
          }
        >
          <TimeSplit data={data} />
        </Section>
      </div>

      <Section title="Your runners" about={own.length === 0 ? "None yet." : `${online} of ${own.length} online. A runner that hasn't been heard from for 90 seconds is offline.`}>
        {own.length === 0 ? (
          <EmptyState title="No runners of your own yet">
            <a href="#add" className="underline underline-offset-2">
              Add one
            </a>{" "}
            to run jobs and agents on your hardware. It connects out to g1t; nothing needs to reach the machine.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
            {own.map((runner) => (
              <RunnerRow key={runner.id} runner={runner} manage />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Where work runs" about="For every project in the workspace, unless a project says otherwise in its own settings.">
        <div className="grid gap-3 md:grid-cols-3">
          <WhereCard icon={<Workflow size={15} />} title="Workflow jobs">
            Each job&apos;s <code className="font-mono text-fg-soft">runs-on</code> decides. <code className="font-mono text-fg-soft">ubuntu-latest</code>,{" "}
            <code className="font-mono text-fg-soft">g1t-4core</code> and other Linux labels run on g1t cloud;{" "}
            <code className="font-mono text-fg-soft">self-hosted</code> and your own labels run on your runners.
          </WhereCard>
          <WhereCard icon={<Bot size={15} />} title="Agents">
            {data.settings?.agentsOnSelfHosted
              ? `Agent runs, checks, reviews and the merge queue run on your runners labelled ${data.settings.agentLabels.join(", ")}.`
              : "Agent runs, checks, reviews and the merge queue run on g1t cloud. Switch them to your runners below."}
          </WhereCard>
          <WhereCard icon={<Laptop size={15} />} title="Your desktop" coming>
            The desktop app will include a runner: for a logged-in browser, a simulator or a tool only your network reaches. It asks before each task.
          </WhereCard>
        </div>
        <RunnerSettingsForm
          key={data.settings ? `${data.settings.agentsOnSelfHosted}:${data.settings.forkPullRequests}:${data.settings.agentLabels.join(",")}` : "none"}
          data={data}
          manage
          scope="workspace"
        />
      </Section>

      <Section
        id="add"
        title="Add a runner"
        about="Download g1t-runner, register it with a token made here, and start it. Linux, macOS and Windows, x64 and arm64, or Docker."
      >
        <NewRunner token={action?.token ?? null} groups={data.groups} repoScoped={false} />
      </Section>

      <Section title="Groups" about="Which repositories may use which runners. A runner joins the default group, every repository, unless its token names another.">
        <Groups groups={data.groups} repositories={data.repositories} manage action={action} />
      </Section>

      <Section title="Coming to runners">
        <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
          <ComingRow icon={<Cpu size={15} />} title="Sessions that persist">
            An agent keeps its runner&apos;s disk between tasks, its checkouts, caches and notes, and picks up where it left off.
          </ComingRow>
          <ComingRow icon={<Boxes size={15} />} title="An official agent image">
            One image with git, Node and the agent&apos;s tools, so agent work runs on any runner with Docker without an image of your own.
          </ComingRow>
        </ul>
      </Section>
    </div>
  );
}

function WhereCard({ icon, title, coming, children }: { icon: ReactNode; title: string; coming?: boolean; children: ReactNode }) {
  return (
    <div className={`rounded-2xl border p-4 ${coming ? "border-dashed border-line" : "border-line bg-surface"}`}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className="text-muted">{icon}</span>
        {title}
        {coming && <span className="ml-auto"><Coming /></span>}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function ComingRow({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 text-muted">{icon}</span>
      <div className="min-w-0 grow">
        <p className="flex items-center gap-2 text-sm font-medium">
          {title}
          <Coming />
        </p>
        <p className="mt-0.5 text-sm text-muted">{children}</p>
      </div>
    </li>
  );
}

/** This month's machine time, g1t cloud's against the workspace's own, as one bar. */
function TimeSplit({ data }: { data: RunnersPageData }) {
  const cost = data.cost;
  if (!cost) {
    return (
      <div className="rounded-2xl border border-line bg-surface px-5 py-4 text-sm text-muted">Billing didn&apos;t answer, so this month&apos;s time can&apos;t be shown right now.</div>
    );
  }
  const total = cost.cloudSeconds + cost.ownSeconds;
  return (
    <div className="rounded-2xl border border-line bg-surface px-5 py-4">
      {total === 0 ? (
        <p className="text-sm text-muted">No machine time yet this month.</p>
      ) : (
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" role="img" aria-label="This month's machine time by where it ran">
          {cost.cloudSeconds > 0 && <span className="h-full min-w-[3px] bg-info" style={{ flexGrow: cost.cloudSeconds }} />}
          {cost.ownSeconds > 0 && <span className="h-full min-w-[3px] bg-success" style={{ flexGrow: cost.ownSeconds }} />}
        </div>
      )}
      <ul className="mt-3 space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[2px] bg-info" aria-hidden />
          <span className="min-w-0 grow truncate text-fg-soft">g1t cloud</span>
          <span className="text-muted tabular-nums">{machineTime(cost.cloudSeconds)}</span>
          <span className="w-20 text-right text-fg tabular-nums">{money(cost.cloudMicros)}</span>
        </li>
        <li className="flex items-center gap-2">
          <span className="size-2 shrink-0 rounded-[2px] bg-success" aria-hidden />
          <span className="min-w-0 grow truncate text-fg-soft">Your runners</span>
          <span className="text-muted tabular-nums">{machineTime(cost.ownSeconds)}</span>
          <span className="w-20 text-right text-fg tabular-nums">{money(0)}</span>
        </li>
      </ul>
      <p className="mt-4 text-[0.6875rem] leading-relaxed text-faint">
        {cost.free ? "Usage at cost: g1t charges nothing for it now." : "At price, before your plan's included usage or credit paid for any of it."} Models are separate.
      </p>
    </div>
  );
}
