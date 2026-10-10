import { Bot, Boxes, Cpu, Plus, ServerCog, ShieldAlert, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link } from "react-router";

import { type RegistrationToken, RUNNER_DOWNLOADS, RUNNER_FILES, RUNNER_IMAGE, type Runner, type RunnerGroup } from "@g1t/contracts";

import { agentRunHref, workflowRunHref } from "../lib/runners";
import type { RunnersAction, RunnersData } from "../lib/runners.server";
import { Button, CopyLine, EmptyState, ErrorText, Field, Input, Pill, SubmitButton, TimeAgo } from "./ui";
import { SelectField } from "./ui/select";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

/** Online and waiting for work reads as Idle; online and working, Busy. */
export const STATUS: Record<Runner["status"], { dot: string; text: string; label: string }> = {
  online: { dot: "bg-success", text: "text-success", label: "Idle" },
  busy: { dot: "bg-info", text: "text-info", label: "Busy" },
  offline: { dot: "bg-faint", text: "text-muted", label: "Offline" },
};

/** Where a runner's current work is: its workflow run, or the agent run it is. */
function workHref(work: NonNullable<Runner["work"]>): string | null {
  if (!work.runId || !work.repo) return null;
  return work.kind === "workflow" ? workflowRunHref(work.repo, work.runId) : agentRunHref(work.repo, work.runId);
}

export const OS_NAMES: Record<Runner["os"], string> = { linux: "Linux", macos: "macOS", windows: "Windows" };

function Section({ icon, title, about, children }: { icon: React.ReactNode; title: string; about: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-line pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </h2>
        <div className="mt-1 text-sm text-muted">{about}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function RunnerRow({ runner, manage }: { runner: Runner; manage: boolean }) {
  const status = STATUS[runner.status];
  const href = runner.work ? workHref(runner.work) : null;
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${status.dot}`} aria-hidden />
      <div className="min-w-0 grow basis-60">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{runner.name}</span>
          <span className={`text-xs font-medium ${status.text}`}>{status.label}</span>
          {runner.ephemeral && <Pill>ephemeral</Pill>}
          {runner.group && <span className="text-xs text-faint">in {runner.group}</span>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {runner.labels.map((label) => (
            <span key={label} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-fg-soft">
              {label}
            </span>
          ))}
        </div>
        {runner.work && (
          <p className="mt-1.5 truncate text-xs text-muted">
            {runner.work.kind === "workflow" ? "Running " : "Agent work: "}
            {href ? (
              <Link to={href} className="text-fg hover:underline">
                {runner.work.name}
              </Link>
            ) : (
              <span className="text-fg">{runner.work.name}</span>
            )}
            {runner.work.repo && <> in {runner.work.repo}</>}
          </p>
        )}
      </div>
      <div className="ml-6 grow text-xs text-faint sm:ml-0 sm:shrink-0 sm:grow-0 sm:text-right">
        <div>
          {OS_NAMES[runner.os]} {runner.arch}
          {runner.version && <> · {runner.version}</>}
        </div>
        <div className="mt-0.5">{runner.lastSeenAt ? <>Seen <TimeAgo at={runner.lastSeenAt} /></> : "Never seen"}</div>
      </div>
      {manage && (
        <Form
          method="post"
          className="shrink-0"
          onSubmit={(event) => {
            if (!confirm(`Remove ${runner.name}? Its credential stops working at once${runner.work ? ", and the job it is running fails" : ""}.`)) event.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="id" value={runner.id} />
          <input type="hidden" name="name" value={runner.name} />
          <SubmitButton
            icon
            match={{ intent: "remove", id: runner.id }}
            aria-label={`Remove ${runner.name}`}
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={15} />
          </SubmitButton>
        </Form>
      )}
    </li>
  );
}

type Platform = "linux" | "macos" | "windows" | "docker";

/** The copy-paste steps for one platform. */
export function installSteps(platform: Platform, token: RegistrationToken | null, arch: "x64" | "arm64" = "x64"): { title: string; lines: string[] }[] {
  const url = token?.url ?? "https://g1t.sh";
  const value = token?.token ?? "<registration token>";
  const register = (exe: string) => `${exe} register --url ${url} --token ${value}`;
  switch (platform) {
    case "linux": {
      const file = arch === "arm64" ? RUNNER_FILES["linux-arm64"] : RUNNER_FILES["linux-x64"];
      return [
        { title: "Download", lines: [`curl -fsSLo g1t-runner ${RUNNER_DOWNLOADS}/latest/${file} && chmod +x g1t-runner`] },
        { title: "Register", lines: [register("./g1t-runner")] },
        { title: "Run it, or install it as a service", lines: ["./g1t-runner run", "sudo ./g1t-runner service install"] },
      ];
    }
    case "macos": {
      const file = arch === "x64" ? RUNNER_FILES["macos-x64"] : RUNNER_FILES["macos-arm64"];
      return [
        { title: "Download", lines: [`curl -fsSLo g1t-runner ${RUNNER_DOWNLOADS}/latest/${file} && chmod +x g1t-runner`] },
        { title: "Register", lines: [register("./g1t-runner")] },
        { title: "Run it, or install it as a launch agent", lines: ["./g1t-runner run", "./g1t-runner service install"] },
      ];
    }
    case "windows":
      return [
        {
          title: "Download (PowerShell)",
          lines: [`Invoke-WebRequest ${RUNNER_DOWNLOADS}/latest/${RUNNER_FILES["windows-x64"]} -OutFile g1t-runner.exe`],
        },
        { title: "Register", lines: [register(".\\g1t-runner.exe")] },
        { title: "Run it, or install it as a service (as Administrator)", lines: [".\\g1t-runner.exe run", ".\\g1t-runner.exe service install"] },
      ];
    case "docker":
      return [
        {
          title: "Register and run, with jobs in sibling containers",
          lines: [
            `docker run -d --name g1t-runner --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -v g1t-runner:/data -e G1T_RUNNER_DIR=/data ${RUNNER_IMAGE} register-and-run --url ${url} --token ${value}`,
          ],
        },
      ];
  }
}

export function NewRunner({ token, groups, repoScoped }: { token: RegistrationToken | null; groups: RunnerGroup[]; repoScoped: boolean }) {
  const [platform, setPlatform] = useState<Platform>("linux");
  const [arch, setArch] = useState<"x64" | "arm64">("x64");
  return (
    <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
      {!token ? (
        <Form method="post" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="token" />
          {!repoScoped && groups.length > 1 && (
            <Field label="Group">
              <SelectField
                name="group"
                defaultValue={groups.find((g) => g.default)?.name ?? groups[0]?.name}
                className="w-auto min-w-40"
                options={groups.map((group) => ({ value: group.name, label: group.name }))}
              />
            </Field>
          )}
          <SubmitButton match={{ intent: "token" }} pending="Making a token…">
            <Plus size={15} />
            New runner
          </SubmitButton>
          <p className="basis-full text-xs text-faint">Makes a registration token that lasts an hour and registers any number of runners. It is shown once.</p>
        </Form>
      ) : (
        <p className="text-sm">
          Registration token made. It expires <TimeAgoFuture at={token.expiresAt} />
          {token.group ? <>; its runners join {token.group}</> : null}. Copy it now: it is not shown again.
        </p>
      )}
      <Tabs value={platform} onValueChange={(value) => setPlatform(value as Platform)}>
        <div className="flex flex-wrap items-center gap-3">
          <TabsList aria-label="Where the runner runs">
            <TabsTrigger value="linux">Linux</TabsTrigger>
            <TabsTrigger value="macos">macOS</TabsTrigger>
            <TabsTrigger value="windows">Windows</TabsTrigger>
            <TabsTrigger value="docker">Docker</TabsTrigger>
          </TabsList>
          {(platform === "linux" || platform === "macos") && (
            <TabsList aria-label="Architecture">
              <button
                type="button"
                onClick={() => setArch("x64")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${arch === "x64" ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
              >
                {platform === "macos" ? "Intel" : "x64"}
              </button>
              <button
                type="button"
                onClick={() => setArch("arm64")}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${arch === "arm64" ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
              >
                {platform === "macos" ? "Apple silicon" : "arm64"}
              </button>
            </TabsList>
          )}
        </div>
      </Tabs>
      <ol className="space-y-3">
        {installSteps(platform, token, platform === "macos" && arch === "x64" ? "x64" : arch).map((step, at) => (
          <li key={step.title}>
            <p className="mb-1.5 text-xs text-muted">
              {at + 1}. {step.title}
            </p>
            <div className="space-y-1.5">
              {step.lines.map((line) => (
                <CopyLine key={line} text={line} prompt />
              ))}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-xs text-faint">
        Jobs run in Docker containers by default; add <code className="font-mono">--no-docker</code> to run them on the machine itself. Add{" "}
        <code className="font-mono">--labels gpu,cuda</code> for jobs to ask for, or <code className="font-mono">--ephemeral</code> for a runner that takes
        one job and removes itself.{" "}
        <a href="https://docs.g1t.sh/guides/self-hosted-runners/" className="underline underline-offset-2">
          Self-hosted runners
        </a>
      </p>
    </div>
  );
}

/** "in 59m", for a time still to come. */
function TimeAgoFuture({ at }: { at: string }) {
  const minutes = Math.max(0, Math.round((new Date(at).getTime() - Date.now()) / 60_000));
  return (
    <time dateTime={at} suppressHydrationWarning>
      {minutes >= 60 ? "in an hour" : `in ${minutes}m`}
    </time>
  );
}

export function Groups({
  groups,
  repositories,
  manage,
  action,
}: {
  groups: RunnerGroup[];
  repositories: string[];
  manage: boolean;
  action: RunnersAction | undefined;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // A group saved closes its form: the list above now shows it as saved.
  useEffect(() => {
    if (action?.notice) setEditing(null);
  }, [action]);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
        {groups.map((group) => (
          <li key={group.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{group.name}</span>
              {group.default && <Pill>default</Pill>}
              <span className="text-xs text-muted">
                {group.runners} {group.runners === 1 ? "runner" : "runners"} ·{" "}
                {group.repositories.length === 0 ? "every repository" : group.repositories.join(", ")}
              </span>
              {manage && (
                <span className="ml-auto flex items-center gap-2">
                  <Button type="button" variant="quiet" onClick={() => setEditing(editing === group.id ? null : group.id)}>
                    {editing === group.id ? "Close" : "Edit"}
                  </Button>
                  {!group.default && (
                    <Form method="post" onSubmit={(event) => { if (!confirm(`Delete ${group.name}? Its runners join the default group.`)) event.preventDefault(); }}>
                      <input type="hidden" name="intent" value="delete-group" />
                      <input type="hidden" name="id" value={group.id} />
                      <SubmitButton variant="quiet" match={{ intent: "delete-group", id: group.id }} pending="Deleting…">
                        Delete
                      </SubmitButton>
                    </Form>
                  )}
                </span>
              )}
            </div>
            {editing === group.id && <GroupForm group={group} repositories={repositories} />}
          </li>
        ))}
      </ul>
      {manage && (editing === "new" ? <GroupForm group={null} repositories={repositories} /> : (
        <Button type="button" variant="quiet" onClick={() => setEditing("new")}>
          <Plus size={15} />
          New group
        </Button>
      ))}
    </div>
  );
}

function GroupForm({ group, repositories }: { group: RunnerGroup | null; repositories: string[] }) {
  const [reach, setReach] = useState(group && group.repositories.length > 0 ? "some" : "all");
  return (
    <Form method="post" className="mt-3 space-y-3 rounded-lg border border-line bg-bg p-3">
      <input type="hidden" name="intent" value="group" />
      {group && <input type="hidden" name="id" value={group.id} />}
      <Field label="Name">
        <Input name="name" defaultValue={group?.name ?? ""} placeholder="GPU machines" maxLength={64} required={!group} />
      </Field>
      <fieldset className="space-y-2 text-sm">
        <legend className="mb-1 text-xs text-muted">Repositories that may use its runners</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="reach" value="all" checked={reach === "all"} onChange={() => setReach("all")} />
          Every repository in the workspace
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="reach" value="some" checked={reach === "some"} onChange={() => setReach("some")} />
          Only these
        </label>
        {reach === "some" && (
          <div className="grid gap-1 pl-6 sm:grid-cols-2">
            {repositories.map((name) => (
              <label key={name} className="flex items-center gap-2 font-mono text-xs">
                <input type="checkbox" name="repository" value={name} defaultChecked={group?.repositories.includes(name)} />
                {name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <SubmitButton match={{ intent: "group", id: group?.id }} pending="Saving…">
        Save group
      </SubmitButton>
    </Form>
  );
}

export function RunnerSettingsForm({ data, manage, scope }: { data: RunnersData; manage: boolean; scope: "workspace" | "project" }) {
  const settings = data.settings;
  const [agents, setAgents] = useState(settings?.agentsOnSelfHosted ?? false);
  const [forks, setForks] = useState(settings?.forkPullRequests ?? false);
  if (!settings) return null;
  // The intent comes from the button pressed: a hidden one before it would
  // win the form's first "intent", and Follow the workspace would only save.
  return (
    <Form method="post" className="space-y-4">
      {scope === "project" && settings.inherited && (
        <p className="text-sm text-muted">These are the workspace&apos;s settings. Saving here gives this project its own.</p>
      )}
      <label className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Bot size={15} className="text-muted" />
            Run g1t's work on self-hosted runners
          </span>
          <span className="mt-1 block text-sm text-muted">
            Agent runs, checks, reviews and the merge queue run on your runners with these labels instead of g1t&apos;s sandboxes. The machine time is
            free; the model is paid as before, through g1t&apos;s model proxy, or by your own provider if you connected one. Agent work needs Docker, or a
            Linux runner.
          </span>
          <span className="mt-3 block max-w-sm">
            <Input name="agentLabels" defaultValue={settings.agentLabels.join(", ")} disabled={!manage} aria-label="Labels for agent work" />
          </span>
        </span>
        <Switch name="agents" checked={agents} onCheckedChange={setAgents} disabled={!manage} aria-label="Run g1t's work on self-hosted runners" />
      </label>
      <label className={`flex items-start justify-between gap-4 rounded-xl border p-4 ${forks ? "border-danger/50 bg-danger/5" : "border-line bg-surface"}`}>
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm font-medium">
            <ShieldAlert size={15} className={forks ? "text-danger" : "text-muted"} />
            Let pull requests from forks use self-hosted runners
          </span>
          <span className="mt-1 block text-sm text-muted">
            Off by default, and best left off. Anyone who can open a pull request could then run any code on your machines, read what they can
            reach, and leave something behind for the next job. Their jobs never get secrets either way.
          </span>
        </span>
        <Switch name="forks" checked={forks} onCheckedChange={setForks} disabled={!manage} />
      </label>
      <p className="text-xs text-faint">
        g1t&apos;s network guardrails are not enforced on your own machines: a job or an agent there reaches whatever the machine can.
      </p>
      {manage && (
        <div className="flex flex-wrap gap-3">
          <SubmitButton name="intent" value="settings" pending="Saving…">
            Save
          </SubmitButton>
          {scope === "project" && !settings.inherited && (
            <SubmitButton name="intent" value="inherit" variant="quiet" pending="Following…">
              Follow the workspace
            </SubmitButton>
          )}
        </div>
      )}
    </Form>
  );
}

/** Settings, Runners: a workspace's, or a project's own. */
export function RunnersPanel({
  data,
  action,
  scope,
  manage,
}: {
  data: RunnersData;
  action: RunnersAction | undefined;
  scope: "workspace" | "project";
  manage: boolean;
}) {
  const online = data.runners.filter((runner) => runner.status !== "offline").length;
  return (
    <div className="max-w-5xl space-y-8">
      <div className="min-h-6">
        {action?.notice && <p className="text-sm text-success">{action.notice}</p>}
        <ErrorText>{action?.error ?? data.error ?? null}</ErrorText>
      </div>
      <Section
        icon={<ServerCog size={15} className="text-muted" />}
        title="Runners"
        about={
          <>
            <p>
              Your own machines, for jobs with <code className="font-mono text-fg">runs-on: self-hosted</code>. Their time is free on every plan.
            </p>
            <p className="mt-2">
              {data.runners.length === 0 ? "None yet." : `${online} of ${data.runners.length} online.`}
            </p>
          </>
        }
      >
        {data.runners.length === 0 ? (
          <EmptyState title="No self-hosted runners">
            Add one below. It connects out to g1t; nothing needs to reach the machine.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
            {data.runners.map((runner) => (
              <RunnerRow key={runner.id} runner={runner} manage={manage && (scope === "workspace" || runner.repo !== null)} />
            ))}
          </ul>
        )}
      </Section>
      {manage && (
        <Section
          icon={<Plus size={15} className="text-muted" />}
          title="New runner"
          about="Download g1t-runner, register it with a token made here, and start it. Linux, macOS and Windows, x64 and arm64."
        >
          <NewRunner token={action?.token ?? null} groups={data.groups} repoScoped={scope === "project"} />
        </Section>
      )}
      {scope === "workspace" && (
        <Section
          icon={<Boxes size={15} className="text-muted" />}
          title="Groups"
          about="Which repositories may use which runners. A runner joins the default group, every repository, unless its token names another."
        >
          <Groups groups={data.groups} repositories={data.repositories} manage={manage} action={action} />
        </Section>
      )}
      <Section
        icon={<Cpu size={15} className="text-muted" />}
        title="Where work runs"
        about={scope === "workspace" ? "For every project in the workspace, unless a project says otherwise." : "For this project."}
      >
        {/* Keyed to what is saved, so following the workspace again shows its settings, not the switches as they were. */}
        <RunnerSettingsForm
          key={data.settings ? `${data.settings.inherited}:${data.settings.agentsOnSelfHosted}:${data.settings.forkPullRequests}:${data.settings.agentLabels.join(",")}` : "none"}
          data={data}
          manage={manage}
          scope={scope}
        />
      </Section>
    </div>
  );
}
