import { Check, Clock, X } from "lucide-react";
import { Link, data, redirect, useLocation } from "react-router";

import type { LimitRequestReview } from "@g1t/contracts";

import type { Route } from "./+types/requests";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Textarea, When } from "~/components/ui";
import { fields, parseDecision } from "~/lib/forms";
import { usd } from "~/lib/money";
import { REQUEST_STATUSES, type RequestStatus, age, parseRequestStatus, requestsHref, waiting } from "~/lib/pricing";
import { DONE, doneKey } from "~/lib/review";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Requests · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const status = parseRequestStatus(url.searchParams.get("status"));
  const [rows, open] = await Promise.all([
    settle(admin.limitRequests(status)),
    status === "open" ? Promise.resolve(null) : settle(admin.limitRequests("open")),
  ]);
  const done = doneKey(request.url);
  return {
    status,
    rows: rows.ok ? rows.value : [],
    openCount: status === "open" ? (rows.ok ? rows.value.length : 0) : open?.ok ? open.value.length : null,
    error: rows.ok ? null : rows.error,
    done: done ? DONE[done] : null,
    now: new Date().toISOString(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const values = fields(form, "id", "amount", "note");
  const decision = parseDecision(form);
  if (!decision.ok) return data({ error: decision.error, id: values.id, values }, { status: 422 });
  const { id, amountMicros, note } = decision.value;
  const result = await admin.decideLimitRequest(id, decision.value.decision, amountMicros, note, staff.email);
  if (!result.ok) return data({ error: result.error.message, id, values }, { status: 422 });
  const back = new URL(request.url);
  back.searchParams.set("done", decision.value.decision === "approve" ? "approved" : "declined");
  throw redirect(`${back.pathname}${back.search}`);
}

const STATUS_LABEL: Record<RequestStatus, string> = { open: "Open", approved: "Approved", declined: "Declined", all: "All" };

export default function Requests({ loaderData, actionData }: Route.ComponentProps) {
  const { status, rows, openCount, error, done, now } = loaderData;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Requests"
        description="Owners asking for a higher limit, or for help with a month that went past what they meant. g1t answers within one business day; the owner is told in the app and by email."
      />
      <nav aria-label="Status" className="mt-5 flex flex-wrap gap-2">
        {REQUEST_STATUSES.map((value) => (
          <Link
            key={value}
            to={requestsHref(value)}
            aria-current={value === status ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs whitespace-nowrap transition-colors ${
              value === status ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            {STATUS_LABEL[value]}
            {value === "open" && openCount != null && <span className="tabular text-faint">{openCount}</span>}
          </Link>
        ))}
      </nav>
      <div className="mt-5 space-y-3 empty:hidden">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="warn">Billing did not answer for requests: {error}</Notice>}
      </div>
      <div className="mt-5 space-y-4">
        {rows.length === 0 && !error ? (
          <EmptyState title={status === "open" ? "Nothing waiting" : `No ${STATUS_LABEL[status].toLowerCase()} requests`}>
            Requests show up here when an owner uses Raise my limit, or tells g1t a month went past what they meant.
          </EmptyState>
        ) : (
          rows.map((row) => (
            <RequestCard
              key={row.request.id}
              row={row}
              now={now}
              error={actionData && "id" in actionData && actionData.id === row.request.id ? actionData : null}
            />
          ))
        )}
      </div>
    </main>
  );
}

function RequestCard({
  row,
  now,
  error,
}: {
  row: LimitRequestReview;
  now: string;
  error: { error: string; values?: Record<string, string> } | null;
}) {
  const { request, history } = row;
  const { pathname, search } = useLocation();
  const wait = waiting(request.createdAt, new Date(now));
  const open = request.status === "open";
  const overage = request.kind === "overage";
  const workspaceAge = age(history.firstSeen, new Date(now));
  const facts: [string, string][] = [
    ["Plan", history.plan ?? "—"],
    ["Seen for", workspaceAge ?? "—"],
    ["Paid, cleared", `${usd(history.paidClearedMicros)} in ${history.payments} payment${history.payments === 1 ? "" : "s"}`],
    ["Disputes · declines", `${history.disputes} · ${history.declines}`],
    ["Ceiling now", usd(history.ceilingMicros)],
    ["Highest ceiling", usd(history.maxCeilingMicros)],
    ["Owners' spend limit", history.spendLimitMicros == null ? "Automatic or none" : usd(history.spendLimitMicros)],
    ["Last hour · usual hour", `${usd(history.lastHourMicros)} · ${usd(history.averageHourMicros)}`],
    ["Last day", usd(history.lastDayMicros)],
  ];
  return (
    <section
      id={request.id}
      className={`scroll-mt-20 rounded-lg border bg-surface ${open && wait.overdue ? "border-danger/40" : "border-line"}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <Link to={`/workspaces/${encodeURIComponent(request.workspace)}#billing`} className="font-mono font-medium text-fg hover:underline">
              {request.workspace}
            </Link>
            <Badge tone={overage ? "warn" : "lavender"}>{overage ? "Spent more than meant" : "Raise my limit"}</Badge>
            {request.status === "approved" && <Badge tone="mint">Approved{request.decidedMicros != null ? ` at ${usd(request.decidedMicros)}` : ""}</Badge>}
            {request.status === "declined" && <Badge tone="danger">Declined</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            By <span className="font-mono">{request.createdBy}</span> · <When at={request.createdAt} time />
          </p>
        </div>
        {open && (
          <p className={`flex items-center gap-1.5 text-xs ${wait.overdue ? "text-danger" : "text-muted"}`}>
            <Clock size={13} />
            Waiting {wait.label}
            {wait.overdue ? " · past one business day" : ""}
          </p>
        )}
      </header>
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-4">
          {!overage && (
            <dl className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-xs text-muted">Asked for</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold">{usd(request.amountMicros)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Expects to spend a month</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold">{usd(request.expectedMonthlyMicros)}</dd>
              </div>
            </dl>
          )}
          <blockquote className="border-l-2 border-line-strong pl-3 text-sm break-words whitespace-pre-line text-fg-soft">{request.reason}</blockquote>
          {request.answer && (
            <p className="text-sm text-muted">
              Answer{request.decidedBy ? <> by <span className="font-mono">{request.decidedBy}</span></> : null}: {request.answer}
            </p>
          )}
          {history.months.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-faint">
                    <th className="py-1 pr-3 font-medium">Month</th>
                    <th className="py-1 pr-3 text-right font-medium">Charged</th>
                    <th className="py-1 pr-3 text-right font-medium">Cost</th>
                    <th className="py-1 text-right font-medium">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {history.months.map((month) => (
                    <tr key={month.month} className="border-t border-line">
                      <td className="py-1 pr-3 font-mono text-muted">{month.month}</td>
                      <td className="tabular py-1 pr-3 text-right">{usd(month.chargedMicros)}</td>
                      <td className="tabular py-1 pr-3 text-right text-muted">{usd(month.costMicros)}</td>
                      <td className="tabular py-1 text-right">{usd(month.paidMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {open && (
            <form method="post" action={`${pathname}${search}#${request.id}`} className="space-y-3 border-t border-line pt-4">
              <input type="hidden" name="id" value={request.id} />
              {error && <Notice tone="error">{error.error}</Notice>}
              {overage ? (
                <p className="text-sm text-muted">
                  Usually answered with a goodwill credit on{" "}
                  <Link to={`/overages#${encodeURIComponent(request.workspace)}`} className="text-accent hover:underline">
                    Overages
                  </Link>
                  , which also closes this request. Or answer it here.
                </p>
              ) : (
                <Field label="Approve at $" hint={`Blank: the ${usd(request.amountMicros)} asked for. Or type a different amount.`}>
                  <Input name="amount" inputMode="decimal" placeholder={String(request.amountMicros / 1_000_000)} defaultValue={error?.values?.amount ?? ""} />
                </Field>
              )}
              <Field label="Note for the owner" hint="Required to decline: they read it in the app and by email.">
                <Textarea name="note" rows={2} maxLength={500} defaultValue={error?.values?.note ?? ""} placeholder="e.g. Approved for the launch; it grows with your payments from here." />
              </Field>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="submit" name="decision" value="decline" variant="danger">
                  <X size={14} />
                  Decline
                </Button>
                <Button type="submit" name="decision" value="approve" variant="lavender">
                  <Check size={14} />
                  Approve
                </Button>
              </div>
            </form>
          )}
        </div>
        <dl className="space-y-1.5 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2">
              <dt className="text-faint">{label}</dt>
              <dd className="tabular text-fg-soft">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
