import { Settings, Timer } from "lucide-react";
import { data } from "react-router";

import type { Route } from "./+types/cycle";
import { CyclePageBody, PastCycles } from "../../../components/cycle-page";
import { ButtonLink, EmptyState } from "../../../components/ui";
import { cycleName, utcToday, workSettingsPath } from "../../../lib/cycles";
import { page } from "../../../lib/meta";
import { isFailed, part } from "../../../lib/partial";
import { workPages } from "../../../lib/repo-live";
import { work } from "../../../lib/services.server";
import { getViewer, roleIn } from "../../../lib/session.server";
import { useWorkspaceLive } from "../../../lib/use-repo-live";
import { canItem } from "../../../lib/work-access";

export function meta({ params, loaderData, ...args }: Route.MetaArgs) {
  const name = loaderData?.detail ? cycleName(loaderData.detail.cycle) : params.number ? `Cycle ${params.number}` : "Cycle";
  return page(args, { title: `${name} · Work · ${params.owner} · g1t` });
}

/**
 * A cycle: the current one (`-/work/cycle`) or one by number
 * (`-/work/cycles/:number`). The cycle is what the page is; the past
 * cycles beside it are a part. While cycles are off, the current cycle's
 * page says so and points to Work's settings.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const workspace = params.owner.toLowerCase();
  const number = params.number == null ? undefined : Number(params.number);
  if (number !== undefined && (!Number.isInteger(number) || number < 1)) throw data(null, { status: 404 });
  const [found, cycles] = await Promise.all([work.getCycle(workspace, viewer, number), part(work.listCycles(workspace, viewer, 12), "Past cycles")]);
  const member = roleIn(viewer, workspace) != null;
  const canConfigure = canItem(viewer, workspace, null, "manage_labels");
  const now = Date.now();
  if (!found.ok) {
    // Off is an answer: the current cycle's page says so.
    if (found.error.code === "conflict" && number === undefined) {
      return { workspace, member, canConfigure, detail: null, past: [], pastFailed: false, now, today: utcToday(now) };
    }
    throw data(null, { status: 404 });
  }
  const past = isFailed(cycles) || !cycles.ok ? [] : cycles.value.past;
  return { workspace, member, canConfigure, detail: found.value, past, pastFailed: isFailed(cycles), now, today: utcToday(now) };
}

/**
 * A cycle's page: its days and what is left of them, what it took on and
 * did, a burn-up, where each of its work items stands (Up next to Done),
 * and each person's and agent's share. A closed cycle's page is its
 * report: what it finished, what it carried into the next, and what it
 * took on after it started.
 */
export default function CyclePage({ loaderData }: Route.ComponentProps) {
  const { workspace, member, canConfigure, detail, past, pastFailed, now, today } = loaderData;
  useWorkspaceLive({ workspace, member, match: workPages.list() });
  if (!detail) {
    return (
      <div className="max-w-2xl">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Timer size={17} className="text-accent" />
          Cycle
        </h1>
        <div className="mt-5">
          <EmptyState title="Cycles are off">
            <p>
              A cycle is a one- or two-week time box. While cycles are on, the plan&apos;s Now is the current cycle, and what is unfinished when it ends carries
              into the next by itself.
            </p>
            {canConfigure ? (
              <ButtonLink to={workSettingsPath(workspace)} className="mt-4">
                <Settings size={14} />
                Turn on cycles
              </ButtonLink>
            ) : (
              <p className="mt-2 text-xs text-faint">Someone who can manage the workspace&apos;s milestones turns them on in Work&apos;s settings.</p>
            )}
          </EmptyState>
        </div>
        {past.length > 0 && (
          <div className="mt-6">
            <PastCycles past={past} workspace={workspace} current={null} />
          </div>
        )}
      </div>
    );
  }
  return <CyclePageBody detail={detail} past={past} pastFailed={pastFailed} workspace={workspace} canConfigure={canConfigure} now={now} today={today} />;
}
