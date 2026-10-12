import { Laptop } from "lucide-react";
import { Link } from "react-router";

import type { DesktopBackend, DesktopDiagnosis, DesktopRunner } from "@g1t/contracts";

import { BACKEND_LABEL, type DesktopRunnerAction, desktopRunner, useDesktopRunner } from "../lib/desktop-runner";
import { EmptyState, TimeAgo } from "./ui";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/** A diagnosis's tone, as a dot. */
const DOT: Record<DesktopDiagnosis["tone"], string> = {
  ok: "bg-success",
  working: "bg-info",
  off: "bg-faint",
  warning: "bg-warn",
  problem: "bg-danger",
};

type Row = {
  machine: string;
  person: string | null;
  backend: DesktopBackend;
  version: string | null;
  diagnosis: DesktopDiagnosis;
  /** This computer's fixes, which only work here. */
  actions: DesktopRunnerAction[];
  here: boolean;
  reportedAt: string | null;
};

/** The desktops to list: this computer, live, first; then the others, as their apps last said, or closed. */
export function desktopRows(desktops: DesktopRunner[], here: ReturnType<typeof useDesktopRunner>, slug: string): Row[] {
  const rows: Row[] = [];
  if (here && here.workspace === slug) {
    rows.push({
      machine: here.machine,
      person: null,
      backend: here.backend,
      version: here.version,
      diagnosis: here.diagnosis,
      actions: here.diagnosis.actions,
      here: true,
      reportedAt: null,
    });
  }
  for (const desktop of desktops) {
    if (rows.some((row) => row.here && row.machine.toLowerCase() === desktop.machine.toLowerCase())) continue;
    rows.push({
      machine: desktop.machine,
      person: desktop.person,
      backend: desktop.backend,
      version: desktop.version,
      diagnosis: desktop.open ? desktop.diagnosis : desktop.closed,
      actions: [],
      here: false,
      reportedAt: desktop.reportedAt,
    });
  }
  return rows;
}

/**
 * The workspace's desktops: each person's computer with the g1t desktop
 * app, whose runner runs while g1t is open there. What each says, why it
 * isn't running and the fix, is the app's own words (lib/desktop-runner.ts).
 */
export function DesktopRunners({ desktops, slug }: { desktops: DesktopRunner[] | null; slug: string }) {
  const here = useDesktopRunner();
  if (!desktops) return <p className="text-sm text-muted">The desktops can&apos;t be read right now.</p>;
  const rows = desktopRows(desktops, here, slug);
  if (rows.length === 0) {
    return (
      <EmptyState title="No desktops yet">
        The <Link to="/download" className="underline underline-offset-2">g1t desktop app</Link> runs this workspace&apos;s self-hosted jobs while it&apos;s open, sandboxed, with nothing to set up.
        Open it signed in as an owner of {slug}.
      </EmptyState>
    );
  }
  return (
    <Card asChild divided>
      <ul>
        {rows.map((row) => (
          <li key={row.machine} className="flex items-start gap-3 px-4 py-3">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[row.diagnosis.tone]}`} aria-hidden />
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Laptop size={13} className="text-muted" aria-hidden />
                <span className="font-medium">{row.machine}</span>
                {row.here && <Badge tone="accent">This computer</Badge>}
                <Badge tone={row.backend === "sandboxed" ? "neutral" : "warn"}>{BACKEND_LABEL[row.backend]}</Badge>
                {row.person && <span className="text-xs text-faint">@{row.person}</span>}
              </div>
              <p className="mt-1 text-sm text-fg">{row.diagnosis.title}</p>
              {row.diagnosis.cause && <p className="mt-0.5 text-sm text-muted">{row.diagnosis.cause}</p>}
              {row.diagnosis.fix && <p className="mt-0.5 text-sm text-fg-soft">{row.diagnosis.fix}</p>}
              {row.actions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {row.actions.map((action, at) => (
                    <Button key={action.id} size="xs" variant={at === 0 ? "secondary" : "outline"} onClick={() => void desktopRunner()?.act(action.id).catch(() => {})}>
                      {action.label}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="shrink-0 text-right text-xs text-faint">
              {row.version && <div>g1t-runner {row.version}</div>}
              {row.reportedAt && (
                <div className="mt-0.5">
                  Heard from <TimeAgo at={row.reportedAt} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
