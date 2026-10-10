import { ChevronDown, ChevronRight, ExternalLink, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { Duration, StatusIcon } from "./actions";
import { DeployLink } from "./deploy";
import { GRAPH, type GraphJob, type EdgeState, type PlacedGroup, type PlacedNode, type Standing, layoutRun, sharedUrl, standingOf, unitStanding } from "../lib/run-graph";
import { Card } from "./ui/card";

/** A job calling a workflow shows as running while its jobs do. */
function Icon({ standing, environment, size = 14 }: { standing: Standing; environment?: string | null; size?: number }) {
  const status = standing.status === "calling" ? "in_progress" : standing.status;
  return <StatusIcon status={status} conclusion={standing.conclusion} of="job" environment={environment} size={size} />;
}

const EDGE: Record<EdgeState, string> = {
  idle: "stroke-line-strong",
  failed: "stroke-danger/70",
  active: "stroke-warn animate-dash",
};

const NODE = "absolute overflow-hidden rounded-lg border bg-surface text-sm shadow-sm transition-colors";

function nodeBorder(selected: boolean): string {
  return selected ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-line-strong";
}

function JobNode({ node, href, selected }: { node: PlacedNode & { unit: { kind: "job" } }; href: (job: GraphJob) => string; selected: string | null }) {
  const { job, label } = node.unit;
  return (
    <div className={`${NODE} ${nodeBorder(job.id === selected)}`} style={{ left: node.x, top: node.y, width: node.w, height: node.h }}>
      <Link
        to={href(job)}
        preventScrollReset
        className="flex items-center gap-2 px-3 hover:bg-raised/40"
        style={{ height: GRAPH.nodeHeight }}
        aria-current={job.id === selected ? "page" : undefined}
      >
        <Icon standing={job} environment={job.environment} />
        <span className="min-w-0 grow truncate font-medium">{label}</span>
        <Duration className="shrink-0 font-mono text-xs text-faint" start={job.startedAt} end={job.finishedAt} />
      </Link>
      {job.environmentUrl && <Address url={job.environmentUrl} />}
    </div>
  );
}

/** Where a deployment is, under its node's name. */
function Address({ url }: { url: string }) {
  return (
    <DeployLink
      href={url}
      className="-mt-2 flex items-center gap-1 truncate pr-3 pl-9 font-mono text-xs text-accent hover:underline"
      style={{ height: GRAPH.urlHeight }}
    >
      <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
      <ExternalLink size={11} className="shrink-0" />
    </DeployLink>
  );
}

function MatrixNode({
  node,
  href,
  selected,
  toggle,
}: {
  node: PlacedNode & { unit: { kind: "matrix" } };
  href: (job: GraphJob) => string;
  selected: string | null;
  toggle: (key: string) => void;
}) {
  const { jobs, label, key } = node.unit;
  const holdsSelected = jobs.some((job) => job.id === selected);
  const url = sharedUrl(jobs);
  return (
    <div className={`${NODE} ${nodeBorder(holdsSelected && !node.expanded)}`} style={{ left: node.x, top: node.y, width: node.w, height: node.h }}>
      <button
        type="button"
        onClick={() => toggle(key)}
        aria-expanded={node.expanded}
        className="flex w-full items-center gap-2 px-3 text-left hover:bg-raised/40"
        style={{ height: GRAPH.nodeHeight }}
      >
        <Icon standing={standingOf(jobs)} />
        <span className="min-w-0 grow truncate font-medium">{label}</span>
        <span className="shrink-0 text-xs text-faint">{jobs.length} jobs</span>
        {node.expanded ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
      </button>
      {url && <Address url={url} />}
      {node.expanded && (
        <ul className="border-t border-line py-0.5">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                to={href(job)}
                preventScrollReset
                aria-current={job.id === selected ? "page" : undefined}
                className={`flex items-center gap-2 px-3 text-[0.8125rem] ${job.id === selected ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"}`}
                style={{ height: GRAPH.rowHeight }}
              >
                <Icon standing={job} environment={job.environment} size={13} />
                <span className="min-w-0 grow truncate">{matrixValues(job.name, label)}</span>
                <Duration className="shrink-0 font-mono text-xs text-faint" start={job.startedAt} end={job.finishedAt} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `ubuntu-latest, 20` from `test (ubuntu-latest, 20)`; the whole name when it is not that. */
function matrixValues(name: string, label: string): string {
  const own = name.split(" / ").pop() ?? name;
  const match = /\(([^()]*)\)$/.exec(own);
  return match && own.startsWith(label) ? match[1]! : own;
}

function GroupBox({ group, href, selected }: { group: PlacedGroup; href: (job: GraphJob) => string; selected: string | null }) {
  const { unit } = group;
  const caller = unit.callers.length === 1 ? unit.callers[0]! : null;
  const title = (
    <>
      <Icon standing={unitStanding(unit)} size={13} />
      <span className="truncate font-medium">{unit.label}</span>
    </>
  );
  return (
    <div
      className="absolute rounded-xl border border-dashed border-line-strong bg-raised/20"
      style={{ left: group.x, top: group.y, width: group.w, height: group.h }}
    >
      <div className="flex items-center gap-2 px-3 text-xs" style={{ height: GRAPH.groupHead }}>
        {caller ? (
          <Link
            to={href(caller)}
            preventScrollReset
            className={`flex min-w-0 items-center gap-1.5 hover:text-fg ${caller.id === selected ? "text-fg" : "text-fg/85"}`}
          >
            {title}
          </Link>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-fg/85">{title}</span>
        )}
        {unit.uses && (
          <span className="ml-auto flex min-w-0 items-center gap-1 font-mono text-faint">
            <Workflow size={11} className="shrink-0" />
            <span className="truncate">{unit.uses.split("/").pop()}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A run's jobs as a graph: each job a node, joined to the jobs that need
 * it. A matrix's jobs make one node that opens to list them; a called
 * workflow's jobs sit in a box under the job that calls it. Scrolls
 * sideways inside its card when wider than the page.
 */
export function RunGraph({
  jobs,
  title,
  trigger,
  href,
  selected = null,
}: {
  jobs: GraphJob[];
  /** The workflow file's name. */
  title: string;
  /** The event that started the run. */
  trigger: string;
  href: (job: GraphJob) => string;
  selected?: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const layout = useMemo(() => layoutRun(jobs, expanded), [jobs, expanded]);
  const toggle = (key: string) =>
    setExpanded((was) => {
      const now = new Set(was);
      if (!now.delete(key)) now.add(key);
      return now;
    });
  if (jobs.length === 0) return null;
  return (
    <Card asChild className="overflow-hidden">
      <section aria-label="Jobs graph">
        <header className="flex min-w-0 items-center gap-1.5 border-b border-line px-4 py-2.5 text-sm">
          <span className="truncate font-mono font-medium">{title}</span>
          <span className="shrink-0 text-faint">· on: {trigger}</span>
        </header>
        <div className="overflow-x-auto bg-bg/40">
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            {layout.groups.map((group) => (
              <GroupBox key={group.unit.key} group={group} href={href} selected={selected} />
            ))}
            <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
              {layout.edges.map((edge) => (
                <path
                  key={`${edge.from}>${edge.to}`}
                  d={edge.path}
                  fill="none"
                  strokeWidth={1.5}
                  strokeDasharray={edge.state === "active" ? "4 4" : undefined}
                  className={EDGE[edge.state]}
                />
              ))}
            </svg>
            {layout.nodes.map((node) =>
              node.unit.kind === "job" ? (
                <JobNode key={node.unit.key} node={node as PlacedNode & { unit: { kind: "job" } }} href={href} selected={selected} />
              ) : (
                <MatrixNode
                  key={node.unit.key}
                  node={node as PlacedNode & { unit: { kind: "matrix" } }}
                  href={href}
                  selected={selected}
                  toggle={toggle}
                />
              ),
            )}
          </div>
        </div>
      </section>
    </Card>
  );
}
