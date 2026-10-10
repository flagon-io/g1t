import { ChevronDown, ChevronRight, Cloud, HardDrive, Moon, Power, RotateCcw, Terminal } from "lucide-react";
import { useState } from "react";
import { Link, useFetcher, useOutletContext } from "react-router";

import type { AgentComputerCommand, AgentComputerState, AgentComputerView, WorkspaceAgent } from "@g1t/contracts";

import type { Route } from "./+types/computer";
import { agentsAction, answer } from "../../../components/agents/actions.server";
import { type ActionResult, Confirm } from "../../../components/agents/dialogs";
import { Quiet } from "../../../components/agents/parts";
import { TimeAgo } from "../../../components/ui";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge, type BadgeTone } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Hint } from "../../../components/ui/hint";
import { Progress } from "../../../components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { page } from "../../../lib/meta";
import { useRefreshWhile } from "../../../lib/refresh";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Computer · @${params.handle} · ${params.owner} · g1t` });
}

/** The agent's computer: its state, disk and recent commands, and whether the viewer may act on it. */
export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ view: AgentComputerView | null; error: string | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw new Response(null, { status: 404 });
  const found = await workspaceAgents.computer(params.owner.toLowerCase(), params.handle.toLowerCase(), viewer).catch(() => null);
  if (!found) return { view: null, error: "The agents service didn't answer. Reload in a moment." };
  return found.ok ? { view: found.value, error: null } : { view: null, error: found.error.message };
}

/** Wake it, put it to sleep, or reset it: owners, or the member whose personal agent it is. */
export async function action({ params, context, request }: Route.ActionArgs): Promise<ActionResult> {
  const { viewer, slug, form } = await agentsAction(request, context, params.owner);
  const intent = String(form.get("intent") ?? "");
  const handle = params.handle.toLowerCase();
  if (intent === "wake") return answer(intent, workspaceAgents.wakeComputer(slug, handle, viewer));
  if (intent === "sleep") return answer(intent, workspaceAgents.sleepComputer(slug, handle, viewer));
  if (intent === "reset") return answer(intent, workspaceAgents.resetComputer(slug, handle, viewer));
  return { ok: false, intent, error: "Unknown request." };
}

const STATES: Record<AgentComputerState, { label: string; tone: BadgeTone; moving: boolean }> = {
  asleep: { label: "Asleep", tone: "neutral", moving: false },
  waking: { label: "Waking", tone: "info", moving: true },
  awake: { label: "Awake", tone: "success", moving: false },
  sleeping: { label: "Sleeping", tone: "info", moving: true },
};

/** Bytes as people read them: 1.2 GB, 340 MB, 12 KB. */
export function humanBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 10e9 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** A duration in milliseconds as a short word: 1.2 s, 42 s, 5 min. */
export function took(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/**
 * The Computer tab: whether the agent's computer is awake, how full its
 * home is, where it runs, the buttons to wake, sleep and reset it, and the
 * commands it ran most recently with their output.
 */
export default function ComputerTab({ loaderData, params }: Route.ComponentProps) {
  const agent = useOutletContext<WorkspaceAgent>();
  const { view, error } = loaderData;
  const fetcher = useFetcher<ActionResult>({ key: `computer-${agent.id}` });
  const state = view?.status.state ?? "asleep";
  useRefreshWhile(state === "waking" || state === "sleeping" || fetcher.state !== "idle");
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  if (!view) {
    return (
      <Quiet title="This computer can't be shown right now" icon={<Terminal size={18} />}>
        {error ?? "The agents service didn't answer. Reload in a moment."}
      </Quiet>
    );
  }
  const { status, commands, can_manage: canManage } = view;
  const shown = STATES[status.state];
  const share = Math.min(100, Math.round((status.disk_used_bytes / status.disk_cap_bytes) * 100));
  const busy = fetcher.state !== "idle";
  const slug = params.owner;
  return (
    <div className="space-y-8">
      <section aria-labelledby="computer-state" className="max-w-3xl">
        <h2 id="computer-state" className="sr-only">
          Its computer
        </h2>
        <p className="text-base leading-relaxed text-fg">
          {agent.display_name} has a computer of its own: a Linux machine with a home that stays between sessions. Sessions wake it to run commands and keep files; it sleeps
          after ten minutes idle and is saved as it was. Chat replies never use it.
        </p>
      </section>

      {failed && (
        <Alert tone="danger" role="alert">
          <AlertDescription>{failed}</AlertDescription>
        </Alert>
      )}
      {status.problem && (
        <Alert tone="warn">
          <AlertDescription>{status.problem}</AlertDescription>
        </Alert>
      )}
      {!status.disk_attached && (
        <Alert tone="info">
          <AlertDescription>This computer&apos;s disk isn&apos;t attached yet: it works, but forgets its home when it sleeps.</AlertDescription>
        </Alert>
      )}
      {status.delete_after && (
        <Alert tone="warn">
          <AlertDescription>
            Its disk will be deleted <TimeAgo at={status.delete_after} />, since the agent was archived.
          </AlertDescription>
        </Alert>
      )}

      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={shown.tone} size="md" className={shown.moving ? "animate-pulse motion-reduce:animate-none" : undefined}>
            <Power size={11} aria-hidden />
            {shown.label}
          </Badge>
          <span className="text-sm text-muted">
            since <TimeAgo at={status.since} />
          </span>
        </div>
        <dl className="mt-5 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0 sm:col-span-2">
            <dt className="flex items-center gap-1.5 text-xs text-faint">
              <HardDrive size={12} aria-hidden />
              Disk
            </dt>
            <dd className="mt-1.5">
              <Progress value={share} aria-label="Disk used" indicatorClassName={share >= 90 ? "bg-danger" : share >= 75 ? "bg-warn" : undefined} />
              <p className="mt-1.5 tabular-nums text-fg-soft">
                {humanBytes(status.disk_used_bytes)} of {humanBytes(status.disk_cap_bytes)} <span className="text-faint">· included, no disk charge</span>
              </p>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="flex items-center gap-1.5 text-xs text-faint">
              <Cloud size={12} aria-hidden />
              Where it runs
            </dt>
            <dd className="mt-1.5 flex flex-wrap items-center gap-2">
              g1t cloud
              <Hint label="Running an agent's computer on one of your own runners is coming.">
                <Badge tone="neutral">Pin to your own runner · coming</Badge>
              </Hint>
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-faint">Saved home</dt>
            <dd className="mt-1.5 text-fg-soft">
              {status.snapshot_at ? (
                <>
                  {humanBytes(status.snapshot_bytes ?? 0)} · <TimeAgo at={status.snapshot_at} />
                </>
              ) : (
                "Nothing saved yet"
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-faint">Last awake</dt>
            <dd className="mt-1.5 text-fg-soft">{status.last_woke_at ? <TimeAgo at={status.last_woke_at} /> : "Never"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-faint">Last slept</dt>
            <dd className="mt-1.5 text-fg-soft">{status.last_slept_at ? <TimeAgo at={status.last_slept_at} /> : "—"}</dd>
          </div>
        </dl>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {canManage ? (
            <>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="wake" />
                <Button type="submit" variant="accent" disabled={busy || status.state !== "asleep"}>
                  <Power size={15} />
                  {busy && fetcher.formData?.get("intent") === "wake" ? "Waking…" : "Wake"}
                </Button>
              </fetcher.Form>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="sleep" />
                <Button type="submit" variant="outline" disabled={busy || status.state !== "awake"}>
                  <Moon size={15} />
                  {busy && fetcher.formData?.get("intent") === "sleep" ? "Saving…" : "Put to sleep"}
                </Button>
              </fetcher.Form>
              <Confirm
                title="Reset this computer?"
                confirm="Reset computer"
                fields={{ intent: "reset" }}
                fetcherKey={`computer-reset-${agent.id}`}
                trigger={
                  <Button type="button" variant="destructive">
                    <RotateCcw size={15} />
                    Reset computer
                  </Button>
                }
              >
                This wipes {agent.display_name}&apos;s home: its clones, installed tools, notes and the commands listed here. Its memory and artifacts are kept. If it is awake it is
                stopped first.
              </Confirm>
            </>
          ) : (
            <p className="text-sm text-muted">{agent.scope === "personal" ? "Its member" : "The workspace's owners"} wake, sleep and reset it. Sessions wake it by themselves.</p>
          )}
          <span className="ml-auto text-xs text-faint">Awake time is sandbox time on the workspace&apos;s usage, under this agent.</span>
        </div>
      </Card>

      <section aria-labelledby="commands" className="space-y-3">
        <div>
          <h2 id="commands" className="text-sm font-semibold">
            Recent commands
          </h2>
          <p className="text-sm text-muted">
            {commands.length === 0 ? "Up to 50 of the commands it runs are kept here, newest first." : `The last ${commands.length === 1 ? "command" : `${commands.length} commands`} it ran, newest first.`} Each
            session&apos;s page shows its own.
          </p>
        </div>
        {commands.length === 0 ? (
          <Quiet title="Nothing run yet" icon={<Terminal size={18} />}>
            When a session runs a command on this computer it is listed here with its output.
          </Quiet>
        ) : (
          <CommandsTable slug={slug} handle={agent.handle} commands={commands} />
        )}
      </section>
    </div>
  );
}

/** The commands, one row each, with the output folded under the row. */
function CommandsTable({ slug, handle, commands }: { slug: string; handle: string; commands: AgentComputerCommand[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">When</TableHead>
          <TableHead className="w-32">Session</TableHead>
          <TableHead>Command</TableHead>
          <TableHead className="w-20 text-right">Exit</TableHead>
          <TableHead className="w-20 text-right">Took</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {commands.map((command) => {
          const shown = open.has(command.id);
          return [
            <TableRow key={command.id}>
              <TableCell className="text-muted">
                <TimeAgo at={command.started_at} />
              </TableCell>
              <TableCell>
                {command.session_id ? (
                  <Link to={`/${slug}/-/agents/${handle}/sessions/${command.session_id}`} className="font-mono text-xs hover:underline">
                    {command.session_id.slice(0, 12)}
                  </Link>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </TableCell>
              <TableCell className="max-w-0">
                <span className="block truncate font-mono text-xs">{command.cmd.split("\n")[0]}</span>
              </TableCell>
              <TableCell className="text-right">
                <Badge tone={command.exit_code === 0 ? "success" : "danger"}>{command.timed_out ? "timed out" : command.exit_code}</Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted">{took(command.duration_ms)}</TableCell>
              <TableCell className="text-right">
                <Button type="button" variant="ghost" size="xs" aria-expanded={shown} aria-controls={`output-${command.id}`} onClick={() => toggle(command.id)}>
                  {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Output
                </Button>
              </TableCell>
            </TableRow>,
            shown ? (
              <TableRow key={`${command.id}-output`} id={`output-${command.id}`}>
                <TableCell colSpan={6} className="bg-bg">
                  <p className="mb-1.5 font-mono text-xs text-faint">
                    $ {command.cmd} <span className="text-faint">· in {command.cwd}</span>
                  </p>
                  <pre className="max-h-96 overflow-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs whitespace-pre-wrap text-muted">{command.output || "(no output)"}</pre>
                  {command.truncated && <p className="mt-1.5 text-xs text-faint">The output was cut.</p>}
                </TableCell>
              </TableRow>
            ) : null,
          ];
        })}
      </TableBody>
    </Table>
  );
}
