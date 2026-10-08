import { Link, data, redirect, useLocation } from "react-router";

import type { CreditKind, CreditMonth } from "@g1t/contracts";

import type { Route } from "./+types/credits";
import { CreditList } from "~/components/billing";
import { Button, Input, Notice, PageHeader, Section, Select, Stat } from "~/components/ui";
import { monthLong } from "~/lib/chart";
import { CREDIT_KINDS, isCreditKind, kindLabel, parseMonth } from "~/lib/credits";
import { fields, parseNote, parseSlug } from "~/lib/forms";
import { parseBy } from "~/lib/ledgers";
import { usd } from "~/lib/money";
import { DONE, doneKey } from "~/lib/review";
import { admin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Credits & refunds · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind") ?? "";
  const kind: CreditKind | null = isCreditKind(kindParam) ? kindParam : null;
  const month = parseMonth(url.searchParams.get("month"));
  const by = parseBy(url.searchParams.get("by"));
  const slug = parseSlug(url.searchParams.get("workspace") ?? "");
  const workspace = slug.ok ? slug.value : null;
  const result = await settle(admin.credits({ kind, month, by, workspace }));
  const done = doneKey(request.url);
  return {
    kind,
    month,
    by,
    workspace,
    credits: result.ok ? result.value : null,
    error: result.ok ? null : result.error,
    done: done ? DONE[done] : null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const values = fields(form, "id", "reason", "workspace");
  const fail = (error: string) => data({ error, section: "credits", values }, { status: 422 });
  if (values.id === "" || form.get("intent") !== "revoke-credit") return fail("Unknown action.");
  const reason = parseNote(values.reason);
  if (!reason.ok) return fail(reason.error);
  const result = await admin.revokeCredit(values.id, reason.value, staff.email);
  if (!result.ok) return fail(result.error.message);
  const back = new URL(request.url);
  back.searchParams.set("done", "revoked");
  throw redirect(`${back.pathname}${back.search}#top`);
}

/** Each month's kinds, with a total line when there is more than one. */
function byMonth(months: CreditMonth[]): { month: string; rows: CreditMonth[]; total: CreditMonth }[] {
  const out: { month: string; rows: CreditMonth[]; total: CreditMonth }[] = [];
  for (const row of months) {
    let group = out.find((g) => g.month === row.month);
    if (!group) {
      group = { month: row.month, rows: [], total: { ...row, kind: row.kind, givenMicros: 0, grants: 0, usedMicros: 0, expiredMicros: 0, revokedMicros: 0 } };
      out.push(group);
    }
    group.rows.push(row);
    group.total.givenMicros += row.givenMicros;
    group.total.grants += row.grants;
    group.total.usedMicros += row.usedMicros;
    group.total.expiredMicros += row.expiredMicros;
    group.total.revokedMicros += row.revokedMicros;
  }
  return out;
}

export default function Credits({ loaderData, actionData }: Route.ComponentProps) {
  const { kind, month, by, workspace, credits, error, done } = loaderData;
  const { pathname, search } = useLocation();
  const failed = actionData && "error" in actionData ? { error: actionData.error, values: actionData.values } : null;
  const filtered = kind != null || month != null || by != null || workspace != null;
  const thisMonth = new Date().toISOString().slice(0, 7);
  const now = byMonth(credits?.months ?? []).find((g) => g.month === thisMonth)?.total;
  const open = (credits?.grants ?? []).filter((grant) => grant.state === "open");

  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <PageHeader
        title="Credits & refunds"
        description="Every credit staff have given: promotional and goodwill credit is given away when spent; a refund gives back money already paid. Give credit from a workspace's page, under Billing."
      />
      {done && (
        <div className="mt-6">
          <Notice tone="ok">{done}</Notice>
        </div>
      )}
      {error ? (
        <div className="mt-6">
          <Notice tone="warn">Billing did not answer for credits: {error}</Notice>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Given this month" value={usd(now?.givenMicros ?? 0, { cents: true })} hint={`${now?.grants ?? 0} credit${now?.grants === 1 ? "" : "s"}`} />
          <Stat label="Spent this month" value={usd(now?.usedMicros ?? 0, { cents: true })} hint="On usage, every kind" />
          <Stat label="Taken back this month" value={usd((now?.expiredMicros ?? 0) + (now?.revokedMicros ?? 0), { cents: true })} hint="Expired or revoked unused" />
          <Stat
            label="Left to spend"
            value={usd(open.reduce((sum, grant) => sum + grant.leftMicros, 0), { cents: true })}
            hint={`${open.length} open credit${open.length === 1 ? "" : "s"}${filtered ? ", filtered" : ""}`}
          />
        </div>
      )}

      {credits && credits.months.length > 0 && (
        <Section className="mt-6" title="By month" description="The last 12 months by kind. Spent is what credit paid for that month, whenever it was given.">
          <div className="-mx-4 -my-4 overflow-x-auto sm:-mx-5 sm:-my-5">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium sm:pl-5">Month</th>
                  <th className="px-4 py-2 font-medium">Kind</th>
                  <th className="px-4 py-2 text-right font-medium">Given</th>
                  <th className="px-4 py-2 text-right font-medium">Spent</th>
                  <th className="px-4 py-2 text-right font-medium">Expired</th>
                  <th className="px-4 py-2 text-right font-medium sm:pr-5">Revoked</th>
                </tr>
              </thead>
              <tbody>
                {byMonth(credits.months).map((group) => (
                  <MonthRows key={group.month} group={group} />
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <form method="get" action="/credits" className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Select name="kind" defaultValue={kind ?? ""} aria-label="Kind" className="sm:w-40">
          <option value="">Any kind</option>
          {CREDIT_KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.title}
            </option>
          ))}
        </Select>
        <Input type="month" name="month" defaultValue={month ?? ""} aria-label="Month given" className="sm:w-44" />
        <Select name="by" defaultValue={by ?? ""} aria-label="Given by" className="sm:w-56">
          <option value="">Anyone</option>
          {(credits?.staff ?? []).map((email) => (
            <option key={email} value={email}>
              {email}
            </option>
          ))}
        </Select>
        <Input name="workspace" defaultValue={workspace ?? ""} placeholder="Workspace" aria-label="Workspace" className="font-mono sm:w-44" />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="quiet" className="py-2">
            Apply
          </Button>
          {filtered && (
            <Link to="/credits" className="px-1 text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
              Clear
            </Link>
          )}
        </div>
      </form>

      {credits && (
        <Section
          className="mt-4"
          title={filtered ? "Credits that match" : "Every credit"}
          description={`Newest first${credits.grants.length >= 200 ? ", the newest 200" : ""}. Revoking takes back what is left; what was spent stays spent.`}
        >
          <CreditList grants={credits.grants} pathname={`${pathname}${search}`} error={failed} showWorkspace />
        </Section>
      )}
    </main>
  );
}

function MonthRows({ group }: { group: { month: string; rows: CreditMonth[]; total: CreditMonth } }) {
  const cell = "tabular px-4 py-2 text-right";
  return (
    <>
      {group.rows.map((row, index) => (
        <tr key={row.kind} className={index === 0 ? "border-t border-line" : ""}>
          <td className="px-4 py-2 sm:pl-5">{index === 0 ? monthLong(group.month) : ""}</td>
          <td className="px-4 py-2 text-fg-soft">
            {kindLabel(row.kind)}
            <span className="text-faint"> · {row.grants}</span>
          </td>
          <td className={cell}>{usd(row.givenMicros, { cents: true })}</td>
          <td className={cell}>{usd(row.usedMicros, { cents: true })}</td>
          <td className={`${cell} text-muted`}>{usd(row.expiredMicros, { cents: true })}</td>
          <td className={`${cell} text-muted sm:pr-5`}>{usd(row.revokedMicros, { cents: true })}</td>
        </tr>
      ))}
      {group.rows.length > 1 && (
        <tr className="text-muted">
          <td className="px-4 py-2 sm:pl-5" />
          <td className="px-4 py-2 text-xs">All kinds</td>
          <td className={cell}>{usd(group.total.givenMicros, { cents: true })}</td>
          <td className={cell}>{usd(group.total.usedMicros, { cents: true })}</td>
          <td className={cell}>{usd(group.total.expiredMicros, { cents: true })}</td>
          <td className={`${cell} sm:pr-5`}>{usd(group.total.revokedMicros, { cents: true })}</td>
        </tr>
      )}
    </>
  );
}
