import { CheckCircle2, ChevronRight, CircleSlash, FileCode2, Play, XCircle, Zap } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type { Automation, AutomationRun } from "@g1t/contracts";

import type { Route } from "./+types/automations";
import { Button, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { automations } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Automations · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner, name: params.repo };
  const [list, runs] = await Promise.all([automations.list(repo, viewer), automations.runs(repo, viewer)]);
  return {
    automations: unwrap(list),
    runs: runs.ok ? runs.value : [],
    member: roleIn(viewer, params.owner) != null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  if (form.get("intent") === "toggle") {
    const changed = await automations.setEnabled(user, repo, id, form.get("enabled") === "true");
    return changed.ok ? {} : { error: changed.error.message };
  }
  const number = Number(form.get("number"));
  const ran = await automations.run(user, repo, id, Number.isInteger(number) && number > 0 ? number : undefined);
  return ran.ok ? { ran: ran.value } : { error: ran.error.message };
}

/** Ready-made automations to start from. */
const TEMPLATES: { file: string; title: string; about: string; yaml: string }[] = [
  {
    file: "bugs.yml",
    title: "Put an agent on every bug",
    about: "A new issue labelled bug gets a g1t agent at once, and a note saying so.",
    yaml: `name: Put an agent on every bug
on: issue.opened
if:
  labels: bug
do:
  - comment: "Thanks, {{actor}}. A g1t agent is on it."
  - assign_agent`,
  },
  {
    file: "failed-checks.yml",
    title: "Tell the agent when checks fail",
    about: "When a pull request's checks fail, the agent working on it hears at once.",
    yaml: `name: Tell the agent when checks fail
on: checks.completed
if:
  status: failed
do:
  - message_agent: "The acceptance checks failed. Read their output on #{{number}} and fix the cause."`,
  },
  {
    file: "announce-merges.yml",
    title: "Announce merges in chat",
    about: "Every merge posts to a Slack or Discord channel through its incoming webhook.",
    yaml: `name: Announce merges
on: pull.merged
do:
  - notify:
      url: https://hooks.slack.com/services/...
      text: "Merged into {{repo}}: {{title}} {{url}}"`,
  },
  {
    file: "weekly-tidy.yml",
    title: "A weekly tidy-up",
    about: "Every Monday morning an issue opens and an agent takes it.",
    yaml: `name: Weekly tidy-up
on:
  schedule: "0 9 * * mon"
do:
  - open_issue:
      title: Weekly tidy-up
      body: Update dependencies that have new patch releases, and fix any new warnings.
      labels: chore
      assign_agent: true`,
  },
];

function RunStatus({ run }: { run: AutomationRun }) {
  if (run.status === "succeeded") return <CheckCircle2 size={15} className="shrink-0 text-accent" />;
  if (run.status === "failed") return <XCircle size={15} className="shrink-0 text-danger" />;
  return <CircleSlash size={15} className="shrink-0 text-faint" />;
}

function RunRow({ run, base }: { run: AutomationRun; base: string }) {
  return (
    <details className="group border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised/40">
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <RunStatus run={run} />
        <span className="min-w-0 truncate font-medium">{run.name}</span>
        <span className="shrink-0 font-mono text-xs text-muted">{run.event}</span>
        {run.number != null && (
          <Link to={`${base}/issues/${run.number}`} className="shrink-0 font-mono text-xs text-muted hover:text-fg">
            #{run.number}
          </Link>
        )}
        <span className="ml-auto shrink-0 text-xs text-faint">
          {run.actor && `${run.actor} · `}
          <TimeAgo at={run.startedAt} />
        </span>
      </summary>
      <div className="border-t border-line bg-bg/40 px-4 py-3 text-sm">
        {run.reason && <p className="text-muted">{run.reason}</p>}
        {run.steps.length > 0 && (
          <ol className="space-y-1.5">
            {run.steps.map((step, index) => (
              <li key={index} className="flex items-start gap-2">
                {step.ok ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0 text-danger" />
                )}
                <span>
                  <span className="font-medium">{step.step}</span>
                  <span className="text-muted"> · {step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

function AutomationCard({ automation, base, member }: { automation: Automation; base: string; member: boolean }) {
  const busy = useNavigation().state === "submitting";
  return (
    <li className="border-t border-line p-4 first:border-t-0">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={`mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg ring-1 ${
            automation.error
              ? "bg-danger/10 text-danger ring-danger/30"
              : automation.enabled
                ? "bg-accent/10 text-accent ring-accent/30"
                : "bg-surface text-faint ring-line"
          }`}
        >
          <Zap size={15} />
        </span>
        <div className="min-w-0 grow">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{automation.name}</span>
            {!automation.enabled && !automation.error && (
              <span className="rounded-full px-2 py-px text-xs text-muted ring-1 ring-line">Off</span>
            )}
          </p>
          <Link
            to={`${base}/blob/HEAD/${automation.path}`}
            className="inline-flex items-center gap-1 font-mono text-xs text-faint hover:text-fg"
          >
            <FileCode2 size={12} />
            {automation.path}
          </Link>
          {automation.error ? (
            <p className="mt-2 text-sm text-danger">{automation.error}</p>
          ) : (
            <p className="mt-2 text-sm text-muted">
              <span className="text-fg">On</span> {automation.trigger}
              {automation.conditions.length > 0 && (
                <>
                  , <span className="text-fg">if</span> {automation.conditions.join(" and ")}
                </>
              )}
              : {automation.steps.join(", then ")}.
            </p>
          )}
          {automation.lastRun && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
              <RunStatus run={automation.lastRun} />
              Last run {automation.lastRun.status} <TimeAgo at={automation.lastRun.startedAt} />
              {automation.lastRun.reason && ` · ${automation.lastRun.reason}`}
            </p>
          )}
        </div>
        {member && !automation.error && (
          <div className="flex shrink-0 items-center gap-2">
            <Form method="post" className="flex items-center gap-1.5">
              <input type="hidden" name="id" value={automation.id} />
              <input
                name="number"
                inputMode="numeric"
                placeholder="#"
                aria-label="Issue or pull request to run it on"
                className="w-14 rounded-md border border-line bg-bg px-2 py-1.5 text-center font-mono text-xs outline-none focus:border-accent-dim"
              />
              <Button type="submit" variant="quiet" disabled={busy} name="intent" value="run">
                <Play size={13} />
                Run now
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={automation.id} />
              <input type="hidden" name="enabled" value={automation.enabled ? "false" : "true"} />
              <Button type="submit" variant="quiet" disabled={busy}>
                {automation.enabled ? "Turn off" : "Turn on"}
              </Button>
            </Form>
          </div>
        )}
      </div>
    </li>
  );
}

function Templates({ repo }: { repo: string }) {
  return (
    <section>
      <h3 className="text-sm font-medium">Start from one of these</h3>
      <p className="mt-1 text-sm text-muted">
        Add the file to <code className="text-fg">.g1t/automations/</code> on {repo}'s default branch. It is read the moment
        you push.
      </p>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {TEMPLATES.map((template) => (
          <div key={template.file} className="rounded-xl border border-line bg-surface p-4">
            <p className="font-medium">{template.title}</p>
            <p className="mt-1 text-xs text-muted">{template.about}</p>
            <p className="mt-3 font-mono text-xs text-faint">.g1t/automations/{template.file}</p>
            <pre className="mt-1.5 overflow-x-auto rounded-lg bg-bg p-3 font-mono text-xs leading-relaxed ring-1 ring-line">
              <code>{template.yaml}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Automations({ loaderData, actionData, params }: Route.ComponentProps) {
  const { automations: list, runs, member } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const ran = actionData && "ran" in actionData ? actionData.ran : null;
  return (
    <div className="max-w-5xl space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Zap size={18} className="text-accent" />
            Automations
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Rules in <code className="text-fg">.g1t/automations</code> that act when something happens: comment, label,
            put an agent on it, tell the agent working on it, open or close issues, post to chat.
          </p>
        </div>
        <a href="https://docs.g1t.sh/guides/automations/" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
          How automations work
        </a>
      </header>

      {ran && (
        <p className="text-sm text-muted">
          Ran <span className="text-fg">{ran.name}</span>: {ran.status}
          {ran.reason ? `. ${ran.reason}` : "."}
        </p>
      )}
      <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>

      {list.length === 0 ? (
        <EmptyState title="No automations yet">
          Commit a file to <code>.g1t/automations/</code> and it shows up here.
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {list.map((automation) => (
            <AutomationCard key={automation.id} automation={automation} base={base} member={member} />
          ))}
        </ul>
      )}

      {runs.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-medium">Recent runs</h3>
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {runs.map((run) => (
              <RunRow key={run.id} run={run} base={base} />
            ))}
          </div>
        </section>
      )}

      <Templates repo={`${params.owner}/${params.repo}`} />
    </div>
  );
}
