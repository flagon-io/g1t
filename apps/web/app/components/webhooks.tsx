/**
 * A repository's or a workspace's webhooks: the addresses events are sent
 * to, adding one, and every delivery with what was sent and what came back.
 */
import { ChevronRight, Pause, Play, RotateCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Form, Link } from "react-router";

import { EVENT_TYPES, type Hook, type HookDelivery } from "@g1t/contracts";

import type { WebhooksAction, WebhooksData } from "../lib/webhooks.server";
import { CopyLine, EmptyState, ErrorText, Field, Input, SubmitButton, TimeAgo } from "./ui";
import { CheckboxOption } from "./ui/checkbox";
import { Hint } from "./ui/hint";
import { RadioGroup, RadioOption } from "./ui/radio-group";

/** The events, in groups people recognise. */
const GROUPS: { title: string; events: string[] }[] = [
  { title: "Code", events: ["git.push", "repo.created", "repo.forked"] },
  {
    title: "Issues",
    events: ["issue.opened", "issue.updated", "issue.assigned", "issue.closed", "issue.reopened", "comment.created"],
  },
  {
    title: "Pull requests",
    events: ["pull.opened", "pull.ready", "pull.updated", "pull.merge_requested", "pull.merged", "pull.closed"],
  },
  { title: "Checks, reviews and the queue", events: ["checks.completed", "workflow.completed", "review.completed", "queue.changed"] },
  {
    title: "Statuses and check runs",
    events: [
      "status.created",
      "check_run.created",
      "check_run.completed",
      "check_run.rerequested",
      "check_run.requested_action",
      "check_suite.completed",
      "check_suite.rerequested",
    ],
  },
  { title: "Agents", events: ["session.appended", "agent.asked"] },
  { title: "Access", events: ["repo.collaborator_added", "repo.collaborator_removed", "repo.collaborator_role_changed"] },
  {
    title: "Teams",
    events: [
      "team.created",
      "team.edited",
      "team.deleted",
      "team.member_added",
      "team.member_role_changed",
      "team.member_removed",
      "team.repo_added",
      "team.repo_role_changed",
      "team.repo_removed",
    ],
  },
];

function StatusDot({ status }: { status: string | null }) {
  const color =
    status === "delivered" ? "bg-success" : status === "failed" ? "bg-danger" : status === "pending" ? "bg-warn" : "bg-faint";
  return <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color}`} />;
}

function describeEvents(events: string[]): string {
  if (events.includes("*")) return "Every event";
  return events.length === 1 ? events[0] : `${events.length} events`;
}

/** JSON, indented for reading, or the text as it is. */
function pretty(text: string | null): string {
  if (!text) return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function DeliveryRow({ delivery, manage }: { delivery: HookDelivery; manage: boolean }) {
  return (
    <details className="group border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised/40">
        <ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
        <StatusDot status={delivery.status} />
        <span className="font-mono text-[0.8125rem]">{delivery.event}</span>
        <span className="min-w-0 truncate text-xs text-muted">
          {delivery.responseStatus != null
            ? `${delivery.responseStatus}`
            : delivery.error
              ? delivery.error
              : "Not yet sent"}
          {delivery.attempts > 1 && ` · ${delivery.attempts} attempts`}
          {delivery.status === "pending" && delivery.nextAttemptAt && " · will try again"}
        </span>
        <span className="ml-auto shrink-0 font-mono text-xs text-faint">
          {delivery.durationMs != null && `${delivery.durationMs}ms · `}
          <TimeAgo at={delivery.createdAt} />
        </span>
      </summary>
      <div className="grid gap-4 border-t border-line bg-bg/40 p-4 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted">Request</p>
          <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs ring-1 ring-line">
            <code>{pretty(delivery.payload)}</code>
          </pre>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-muted">
            Response{delivery.responseStatus != null && ` · ${delivery.responseStatus}`}
          </p>
          <pre className="max-h-80 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs ring-1 ring-line">
            <code>{delivery.error ?? (pretty(delivery.responseBody) || "No body.")}</code>
          </pre>
          {manage && (
            <Form method="post" className="mt-3">
              <input type="hidden" name="intent" value="redeliver" />
              <input type="hidden" name="delivery" value={delivery.id} />
              <SubmitButton
                variant="quiet"
                match={{ intent: "redeliver", delivery: delivery.id }}
                pending="Redelivering…"
              >
                <RotateCw size={14} />
                Redeliver
              </SubmitButton>
            </Form>
          )}
        </div>
      </div>
    </details>
  );
}

function HookRow({ hook, open, deliveries, manage }: { hook: Hook; open: boolean; deliveries: HookDelivery[]; manage: boolean }) {
  return (
    <li className="border-t border-line first:border-t-0">
      <div className="flex items-center gap-3 px-4 py-3">
        <StatusDot status={hook.active ? hook.lastStatus : null} />
        <div className="min-w-0 grow">
          <p className="truncate font-mono text-[0.8125rem]">{hook.url}</p>
          <p className="truncate text-xs text-muted">
            {describeEvents(hook.events)}
            {!hook.active && " · paused"}
            {hook.lastDeliveredAt && (
              <>
                {" · last sent "}
                <TimeAgo at={hook.lastDeliveredAt} />
              </>
            )}
            {` · secret ${hook.secretHint}`}
          </p>
        </div>
        <Link
          to={open ? "?" : `?hook=${hook.id}`}
          preventScrollReset
          className="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          {open ? "Hide deliveries" : "Deliveries"}
        </Link>
        {manage && (
          <Form method="post" className="flex shrink-0 gap-1">
            <input type="hidden" name="id" value={hook.id} />
            <IconButton intent="ping" id={hook.id} label="Send a ping">
              <Send size={14} />
            </IconButton>
            <input type="hidden" name="active" value={hook.active ? "false" : "true"} />
            <IconButton intent="toggle" id={hook.id} label={hook.active ? "Pause" : "Resume"}>
              {hook.active ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
            <IconButton intent="delete" id={hook.id} label="Delete">
              <Trash2 size={14} />
            </IconButton>
          </Form>
        )}
      </div>
      {open && (
        <div className="mx-4 mb-4 overflow-hidden rounded-lg border border-line">
          {deliveries.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Nothing sent yet.</p>
          ) : (
            deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} manage={manage} />)
          )}
        </div>
      )}
    </li>
  );
}

/** One webhook's action, as an icon: a spinner in its place while that action goes. */
function IconButton({ intent, id, label, children }: { intent: string; id: string; label: string; children: React.ReactNode }) {
  return (
    <Hint label={label}>
      <SubmitButton
        icon
        name="intent"
        value={intent}
        match={{ id }}
        aria-label={label}
        className="rounded-md p-2 text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-50"
      >
        {children}
      </SubmitButton>
    </Hint>
  );
}

function AddWebhook() {
  const [which, setWhich] = useState<"all" | "some">("all");
  return (
    <Form method="post" className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <input type="hidden" name="intent" value="create" />
      <p className="font-medium">Add a webhook</p>
      <Field label="Payload URL" hint="An HTTPS address on the public internet. g1t sends it a ping as soon as you add it.">
        <Input name="url" type="url" required placeholder="https://example.com/g1t/events" />
      </Field>
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-muted">Which events</legend>
        <RadioGroup
          name="which"
          value={which}
          onValueChange={(value) => setWhich(value as typeof which)}
          aria-label="Which events"
          className="flex flex-wrap gap-x-6 gap-y-2"
        >
          <RadioOption value="all" label="Everything, including events added later" />
          <RadioOption value="some" label="Let me choose" />
        </RadioGroup>
        {which === "some" && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GROUPS.map((group) => (
              <div key={group.title}>
                <p className="mb-1.5 text-xs font-medium text-faint">{group.title}</p>
                <div className="space-y-1">
                  {group.events
                    .filter((event) => (EVENT_TYPES as readonly string[]).includes(event))
                    .map((event) => (
                      <CheckboxOption
                        key={event}
                        name="event"
                        value={event}
                        label={event}
                        className="items-center"
                        labelClassName="font-mono text-[0.8125rem]"
                      />
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </fieldset>
      <Field label="Secret" hint="Optional. Deliveries are signed with it. Leave it empty and g1t makes one, shown once.">
        <Input name="secret" type="password" autoComplete="off" />
      </Field>
      <SubmitButton match={{ intent: "create" }} pending="Adding…">
        Add webhook
      </SubmitButton>
    </Form>
  );
}

export function WebhooksPanel({
  data,
  action,
  manage,
  scope,
}: {
  data: WebhooksData;
  action: WebhooksAction | undefined;
  manage: boolean;
  /** Says whose events these are. */
  scope: string;
}) {
  const created = action?.created;
  return (
    <div className="max-w-4xl space-y-6">
      {created && (
        <div className="space-y-3 rounded-xl border border-success-dim/60 bg-success/5 p-5 text-sm">
          <p className="font-medium">Added. g1t sent it a ping.</p>
          {created.secret ? (
            <>
              <p className="text-muted">
                Every delivery is signed with this secret in <code>X-G1t-Signature-256</code>. It is shown this once.
              </p>
              <CopyLine text={created.secret} />
            </>
          ) : (
            <p className="text-muted">Deliveries are signed with the secret you gave.</p>
          )}
        </div>
      )}
      {action?.sent && (
        <p className="text-sm text-muted">
          Sent {action.sent.event}:{" "}
          {action.sent.status === "delivered" ? (
            <span className="text-success">delivered, {action.sent.responseStatus}</span>
          ) : (
            <span className="text-danger">{action.sent.error ?? `answered ${action.sent.responseStatus}`}</span>
          )}
          .
        </p>
      )}
      <ErrorText>{action?.error}</ErrorText>

      {data.hooks.length === 0 ? (
        <EmptyState title="No webhooks yet">
          Add one and {scope} sends its events to your address as they happen, signed, and retried until it answers.
        </EmptyState>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-surface">
          {data.hooks.map((hook) => (
            <HookRow
              key={hook.id}
              hook={hook}
              open={data.open === hook.id}
              deliveries={data.open === hook.id ? data.deliveries : []}
              manage={manage}
            />
          ))}
        </ul>
      )}

      {/* Keyed to the webhook just added, so the form starts empty for the next. */}
      {manage && <AddWebhook key={created?.hook.id ?? "new"} />}
      <p className="text-xs text-faint">
        Each delivery is an HTTPS POST of JSON with <code>X-G1t-Event</code>, <code>X-G1t-Delivery</code> and{" "}
        <code>X-G1t-Signature-256</code>. One that is not answered with a 2xx is tried again after 1 minute, 5 minutes,
        30 minutes, 2 hours and 5 hours.{" "}
        <a href="https://docs.g1t.sh/guides/webhooks/" className="text-muted underline underline-offset-4">
          How to check the signature
        </a>
        .
      </p>
    </div>
  );
}
