/**
 * The workspace overview's ground truth (lib/ground.ts): the past week,
 * the quarter's spend threaded to the work beside what providers reported,
 * each team's last two weeks with what waits on a first review, and the
 * quiet changes in who works where.
 */
import { ArrowRight, Bot } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { COST_PROVIDERS, type CostProvider, isCostProvider } from "@g1t/contracts";

import type { Ground } from "../lib/ground";
import { dollars } from "../lib/signals";
import { Boundary, Unavailable } from "./boundary";
import { Rhythm } from "./rhythm";
import { PulseSkeleton, PulseStrip } from "./signals";
import { SpendFlow } from "./spend-flow";
import { Skeleton } from "./ui/skeleton";

export function GroundSkeleton() {
  return (
    <div className="space-y-6">
      <PulseSkeleton />
      <Skeleton className="h-112 w-full rounded-2xl" />
    </div>
  );
}

/** A part of the ground truth: a mono eyebrow, a sentence for a heading, and what it shows. */
function Section({ id, eyebrow, title, hint, children }: { id: string; eyebrow: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6 rounded-2xl border border-line bg-surface px-5 py-6 md:px-8 md:py-7">
      <p className="font-mono text-[0.6875rem] tracking-[0.16em] text-accent uppercase">{eyebrow}</p>
      <h2 id={`${id}-title`} className="mt-2 font-display text-2xl leading-tight tracking-tight text-fg">
        {title}
      </h2>
      {hint && <p className="mt-1.5 max-w-3xl text-sm text-muted">{hint}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

type QuietRow = Ground["silos"][number];

function QuietList({ title, hint, rows, empty }: { title: string; hint: string; rows: QuietRow[]; empty: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-0.5 text-xs text-muted">{hint}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-faint">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.key} className="text-sm">
              {row.to ? (
                <Link to={row.to} className="font-medium text-fg hover:text-accent">
                  {row.where}
                </Link>
              ) : (
                <span className="font-medium text-fg">{row.where}</span>
              )}
              <p className="text-fg-soft">{row.line}</p>
              <p className="font-mono text-[0.6875rem] text-faint">{row.more}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GroundTruth({ slug, ground }: { slug: string; ground: Ground }) {
  return (
    <div className="space-y-6">
      <Boundary what="The past week">
        <PulseStrip tiles={ground.tiles} />
      </Boundary>
      {!ground.complete && <p className="text-xs text-faint">Some projects didn&apos;t answer, so what follows leaves them out.</p>}
      <Section
        id="spend"
        eyebrow="Spend, threaded to the work"
        title={
          ground.quarterSpend
            ? `${dollars(ground.quarterSpend)} of agent spend this quarter, and what it went into`
            : "This quarter's work, and how much of it agents did"
        }
        hint={
          ground.sized === "spend"
            ? `Each milestone, its work items, their change set in each project and its pull requests, sized by what agents cost on them${ground.sessionSpend > 0 ? ` (g1t's metered usage, and ${dollars(ground.sessionSpend)} of harness sessions estimated at list price)` : ""} and shaded by how much was an agent's. Choose a box to open what is under it.`
            : "Usage isn't known for this quarter, so each box is sized by its pull requests and shaded by how many were an agent's. Choose a box to open what is under it."
        }
      >
        <ProvidersLine slug={slug} providers={ground.providers} threaded={ground.quarterSpend} />
        <Boundary what="Spend, threaded to the work">
          <SpendFlow flow={ground.flow} sized={ground.sized} />
        </Boundary>
        {ground.capped && <p className="mt-3 text-xs text-faint">There were more pull requests this quarter than this reads, so the newest are shown.</p>}
      </Section>
      <Section
        id="rhythm"
        eyebrow="What's moving and what's waiting"
        title={ground.rhythm?.by === "project" ? "Each project's last two weeks" : "Each team's last two weeks"}
        hint="Pull requests and agent sessions above the line; reviews, comments and requests for changes below it. Each row is drawn to its own scale: point at a day for its numbers."
      >
        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Boundary what="What's moving">
            {ground.rhythm ? <Rhythm rows={ground.rhythm.rows} by={ground.rhythm.by} /> : <Unavailable what="The teams" />}
          </Boundary>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-fg">Waiting on a first review</h3>
            <p className="mt-0.5 text-xs text-muted">Open, and no one has reviewed them yet: the oldest first.</p>
            {ground.waiting.length === 0 ? (
              <p className="mt-3 text-sm text-faint">Nothing is waiting for a first review.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {ground.waiting.map((pull) => (
                  <li key={`${pull.repoId}#${pull.number}`} className="py-2.5 text-sm">
                    <Link to={pull.to} className="flex items-start gap-2 hover:text-accent">
                      <span className="shrink-0 pt-px font-mono text-xs text-muted">#{pull.number}</span>
                      <span className="min-w-0 grow">
                        <span className="line-clamp-2 font-medium text-fg">{pull.title}</span>
                        <span className="font-mono text-[0.6875rem] text-faint">
                          {pull.repo.name} · open {pull.age}
                          {pull.blocks.length > 0 && ` · holds up ${pull.blocks.length}`}
                        </span>
                      </span>
                      {pull.agent && <Bot size={13} className="mt-0.5 shrink-0 text-accent" aria-label="An agent's" />}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link to={`/${slug}/-/overview?tab=needs#work`} className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
              The review queue <ArrowRight size={11} />
            </Link>
          </div>
        </div>
      </Section>
      <Section
        id="quiet"
        eyebrow="Quiet changes"
        title="Who works where, and what is spreading"
        hint="What no roll-up shows: knowledge resting with one person, people moving into new ground, and new ways of working taking hold. Each is a place to look, not a verdict."
      >
        <div className="grid gap-8 md:grid-cols-2 xl:grid-cols-4">
          <QuietList
            title="Knowledge silos"
            hint="Projects where one person has done most of the last 90 days' work"
            rows={ground.silos}
            empty="No project rests on one person right now."
          />
          <QuietList
            title="New ground"
            hint="People who merged to a project for the first time in the last two weeks"
            rows={ground.newGround}
            empty="No one has moved into a new project in the last two weeks."
          />
          <QuietList
            title="Spreading"
            hint="A harness more people took up this month, after someone started with it"
            rows={ground.spreading}
            empty="No harness has caught on in a team this month."
          />
          <QuietList
            title="New habits"
            hint="People whose first agent-made change merged in the last two weeks"
            rows={ground.habits}
            empty="No one new started merging agents' work in the last two weeks."
          />
        </div>
      </Section>
    </div>
  );
}

const providerName = (provider: string) => (isCostProvider(provider) ? COST_PROVIDERS[provider as CostProvider].label : provider);

/**
 * What the connected providers reported for the quarter, beside what g1t
 * threads to the work: their bill holds everything the organization ran,
 * so it is the larger figure, never added to the other.
 */
function ProvidersLine({ slug, providers, threaded }: { slug: string; providers: Ground["providers"]; threaded: number | null }) {
  if (!providers) {
    return (
      <p className="-mt-2 mb-5 text-sm text-muted">
        <Link to={`/${slug}/-/provider-costs`} className="text-accent hover:underline">
          Connect a provider&apos;s cost report
        </Link>{" "}
        to see everything your organization spent with Anthropic or OpenAI, not only what g1t can tie to the work.
      </p>
    );
  }
  return (
    <div className="-mt-2 mb-5 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-xl border border-line bg-bg px-4 py-3 text-sm">
      <span className="text-fg">
        <span className="font-semibold">{dollars(providers.total)}</span> reported by your providers this quarter
      </span>
      <span className="font-mono text-xs text-muted">
        {providers.providers.map((row) => `${providerName(row.provider)} ${dollars(row.micros)}`).join(" · ")}
      </span>
      {threaded != null && threaded > 0 && providers.total > 0 && (
        <span className="text-xs text-muted">{Math.min(100, Math.round((threaded / providers.total) * 100))}% of it is threaded to the work below</span>
      )}
      {!providers.complete && <span className="text-xs text-faint">Some of the quarter isn&apos;t read yet</span>}
      <Link to={`/${slug}/-/provider-costs`} className="ml-auto text-xs text-muted hover:text-fg">
        Provider costs
      </Link>
    </div>
  );
}
