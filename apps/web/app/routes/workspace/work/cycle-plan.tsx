import { ArrowLeft, ArrowRight, CalendarRange } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, data, redirect, useFetcher } from "react-router";

import type { CycleChoice, WorkItem } from "@g1t/contracts";

import type { Route } from "./+types/cycle-plan";
import { inTextField } from "../../../components/command-palette";
import { CycleItemRow } from "../../../components/cycles";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Kbd } from "../../../components/ui/kbd";
import { cycleDays, cycleName, cyclePath, dayText } from "../../../lib/cycles";
import { page } from "../../../lib/meta";
import { workPages } from "../../../lib/repo-live";
import { work } from "../../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../../lib/session.server";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { canItem } from "../../../lib/work-access";
import { workPath } from "../../../lib/work-items";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Plan the next cycle · Work · ${params.owner} · g1t` });
}

/**
 * Planning the coming cycle: Next, the pool it is drawn from, beside what
 * is already planned into it. While cycles are off there is no next cycle,
 * and the page goes to the current cycle's, which says so.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const [found, next] = await Promise.all([work.getCycle(workspace, viewer), work.listWorkItems(workspace, viewer, { horizon: "next", limit: 100 })]);
  if (!found.ok) {
    if (found.error.code === "conflict") throw redirect(cyclePath(workspace));
    throw data(null, { status: 404 });
  }
  const detail = found.value;
  if (!detail.next) throw redirect(cyclePath(workspace));
  const coming = detail.next.number;
  return {
    workspace,
    member: roleIn(viewer, workspace) != null,
    cycle: detail.cycle,
    next: detail.next,
    planned: detail.planned,
    // Next in rank order, less what is planned already.
    pool: unwrap(next).filter((item) => item.cycle !== coming),
    canPlan: canItem(viewer, workspace, null, "manage_labels"),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const workspace = params.owner.toLowerCase();
  const form = await request.formData();
  const number = Number(form.get("number"));
  const choice = form.get("cycle") === "next" ? "next" : "none";
  if (!Number.isInteger(number) || number < 1) return { error: "Choose a work item." };
  const result = await work.cycleWorkItem(user, workspace, number, choice);
  return result.ok ? { error: null } : { error: result.error.message };
}

type Side = "pool" | "planned";

/**
 * Next beside the coming cycle. Pulling a work item in plans it into the
 * coming cycle: it stays in Next, in its rank, and moves into Now when
 * the current cycle closes. From the keyboard: J and K (or the arrows)
 * move, H and L (or Tab) switch sides, Y pulls in or takes out.
 */
export default function CyclePlanPage({ loaderData }: Route.ComponentProps) {
  const { workspace, member, cycle, next, canPlan } = loaderData;
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  const fetcher = useFetcher<typeof action>();
  // What is moving, shown where it lands before the answer.
  const moving = fetcher.formData ? { number: Number(fetcher.formData.get("number")), to: fetcher.formData.get("cycle") as CycleChoice } : null;
  const all = [...loaderData.pool, ...loaderData.planned];
  const plannedNow = (item: WorkItem) => (moving?.number === item.number ? moving.to === "next" : loaderData.planned.some((one) => one.number === item.number));
  const pool = all.filter((item) => !plannedNow(item));
  const planned = all.filter(plannedNow);
  const [focus, setFocus] = useState<{ side: Side; index: number }>({ side: "pool", index: 0 });
  const rows = useRef(new Map<string, HTMLLIElement>());
  const list = (side: Side) => (side === "pool" ? pool : planned);
  const move = (item: WorkItem, to: CycleChoice) => fetcher.submit({ number: String(item.number), cycle: to }, { method: "post" });
  const error = fetcher.state === "idle" ? (fetcher.data?.error ?? null) : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || inTextField(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      const key = event.key.toLowerCase();
      const items = list(focus.side);
      const step = (side: Side, index: number) => {
        const length = list(side).length;
        if (length === 0) return;
        const at = Math.max(0, Math.min(length - 1, index));
        setFocus({ side, index: at });
        rows.current.get(`${side}:${at}`)?.querySelector("a")?.focus();
      };
      if (key === "j" || key === "arrowdown") step(focus.side, focus.index + 1);
      else if (key === "k" || key === "arrowup") step(focus.side, focus.index - 1);
      else if (key === "h" || key === "arrowleft") step("pool", focus.index);
      else if (key === "l" || key === "arrowright") step("planned", focus.index);
      else if (key === "y" && canPlan && items[focus.index]) move(items[focus.index]!, focus.side === "pool" ? "next" : "none");
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const column = (side: Side) => {
    const items = list(side);
    return (
      <ul className="px-2 pb-2">
        {items.map((item, index) => (
          <CycleItemRow
            key={item.id}
            item={item}
            workspace={workspace}
            selected={focus.side === side && focus.index === index}
            rowRef={(node) => {
              if (node) rows.current.set(`${side}:${index}`, node);
              else rows.current.delete(`${side}:${index}`);
            }}
            onFocus={() => setFocus({ side, index })}
            action={
              canPlan ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={side === "pool" ? `Plan #${item.number} into ${cycleName(next)}` : `Take #${item.number} out of ${cycleName(next)}`}
                  onClick={() => move(item, side === "pool" ? "next" : "none")}
                  className="max-sm:h-9"
                >
                  {side === "pool" ? (
                    <>
                      Pull in
                      <ArrowRight size={13} />
                    </>
                  ) : (
                    <>
                      <ArrowLeft size={13} />
                      Take out
                    </>
                  )}
                </Button>
              ) : undefined
            }
          />
        ))}
      </ul>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CalendarRange size={17} className="text-accent" />
            Plan {cycleName(next)}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {cycleDays(next)}, after {cycleName(cycle)}. Pull work in from Next: it keeps its rank, and moves into Now when {cycleName(cycle)} closes, with
            whatever is still open in {cycleName(cycle)}.
          </p>
        </div>
        <Link to={cyclePath(workspace)} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft size={14} />
          {cycleName(cycle)}
        </Link>
      </div>
      {error && (
        <Alert role="alert" className="mt-3">
          {error}
        </Alert>
      )}
      {canPlan ? (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-faint pointer-coarse:hidden">
          <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>H</Kbd> <Kbd>L</Kbd> switch sides · <Kbd>Y</Kbd> pull in or take out
        </p>
      ) : (
        <p className="mt-3 text-xs text-faint">You can read the plan; planning a cycle takes the right to manage milestones.</p>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card asChild className="min-w-0 self-start">
          <section aria-labelledby="plan-pool">
            <header className="flex items-center gap-2 px-4 pt-3 pb-2">
              <h2 id="plan-pool" className="text-sm font-semibold">
                Next
              </h2>
              <span className="text-xs text-faint">in rank order, the top first</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-faint">{pool.length}</span>
            </header>
            {pool.length === 0 ? (
              <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                Nothing else in Next. Place work there from{" "}
                <Link to={workPath(workspace, "triage")} className="underline underline-offset-2 hover:text-fg">
                  Triage
                </Link>{" "}
                or Later.
              </p>
            ) : (
              column("pool")
            )}
          </section>
        </Card>
        <Card asChild className="min-w-0 self-start border-accent/30">
          <section aria-labelledby="plan-coming">
            <header className="flex items-center gap-2 px-4 pt-3 pb-2">
              <h2 id="plan-coming" className="text-sm font-semibold">
                {cycleName(next)}
              </h2>
              <span className="text-xs text-faint">from {dayText(next.startsOn)}</span>
              <span className="ml-auto font-mono text-xs tabular-nums text-faint">{planned.length}</span>
            </header>
            {planned.length === 0 ? (
              <p className="mx-4 mb-3 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-faint">
                Nothing planned yet. {canPlan && "Pull work in from Next, or press Y on one."}
              </p>
            ) : (
              column("planned")
            )}
            <p className="border-t border-line px-4 py-2.5 text-xs text-muted">
              Plus whatever is still open in {cycleName(cycle)} when it ends: {cycle.scope - cycle.done} open now.
            </p>
          </section>
        </Card>
      </div>
    </div>
  );
}
