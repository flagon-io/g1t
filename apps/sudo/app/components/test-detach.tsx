/**
 * Moving workspaces off Stripe's test mode before the live key, history
 * kept: one workspace on its page, every workspace on the Stripe page. A
 * preview (dry run) lists what will change; the change itself needs the
 * slug, or "detach", typed. sudo ships no JavaScript: the apply buttons say
 * they are running with app.css's run-button rules.
 */
import { Eye, Unplug } from "lucide-react";

import type { TestStripeDetach, WorkspaceDetach } from "@g1t/contracts";

import { Badge, Button, EmptyState, Field, Input, Notice, Section } from "~/components/ui";
import { usd } from "~/lib/money";
import type { SectionError } from "~/lib/review";
import { CONFIRM_ALL, DEFAULT_EXCLUDED, detachChanges } from "~/lib/test-detach";

const WHAT =
  "Plans canceled; the Stripe customer, cached card and card checks forgotten (the trial grant stays); open checkouts removed; AI auto-reload and a declined autopay cleared; open invoices void; past months closed as skipped; AI credit closed; test payments reversed and what is owed written off as goodwill. The ledger, statements and audit log keep every line.";

/** The busy-aware submit for a detach: "Detaching…" while the page waits. */
function ApplyButton({ label }: { label: string }) {
  return (
    <Button type="submit" variant="danger" className="run-button">
      <span className="run-idle inline-flex items-center gap-2">
        <Unplug size={14} />
        {label}
      </span>
      <span className="run-busy">
        <span className="run-spinner" aria-hidden="true" />
        Detaching…
      </span>
    </Button>
  );
}

function CancelAtStripe({ defaultChecked = false }: { defaultChecked?: boolean }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name="cancelAtStripe" defaultChecked={defaultChecked} className="mt-0.5 accent-(--g1t-accent)" />
      <span>
        <span className="block font-medium">Also cancel the subscriptions at Stripe</span>
        <span className="block text-xs text-muted">Test key only. Without it, they are canceled here and left in Stripe's test mode.</span>
      </span>
    </label>
  );
}

/** One workspace's changes, with its balance before and after. */
function Changes({ row }: { row: WorkspaceDetach }) {
  return (
    <ul className="list-disc space-y-0.5 pl-4 text-sm text-fg-soft">
      {detachChanges(row).map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** Every workspace a detach reaches, as a table. */
export function DetachTable({ rows }: { rows: WorkspaceDetach[] }) {
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-xl text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium sm:pl-5">Workspace</th>
            <th className="px-4 py-2 font-medium">What changes</th>
            <th className="px-4 py-2 text-right font-medium sm:pr-5">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.workspace} className="border-b border-line align-top last:border-0">
              <td className="px-4 py-2.5 sm:pl-5">
                <a href={`/workspaces/${encodeURIComponent(row.workspace)}`} className="font-mono text-xs hover:underline">
                  {row.workspace}
                </a>
                {row.done && (
                  <span className="mt-1 block">
                    <Badge tone="mint">Detached</Badge>
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5">
                <Changes row={row} />
              </td>
              <td className="tabular px-4 py-2.5 text-right whitespace-nowrap sm:pr-5">
                <span className="text-faint">{usd(row.balance_before_micros, { cents: true })}</span>
                {" → "}
                <span className="font-medium">{usd(row.balance_after_micros, { cents: true })}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The workspace page's section: preview, then confirm with the slug. */
export function WorkspaceTestDetachSection({
  workspace,
  pathname,
  preview,
  error,
}: {
  workspace: string;
  pathname: string;
  preview: TestStripeDetach | null;
  error: SectionError;
}) {
  const row = preview?.workspaces.find((w) => w.workspace === workspace) ?? null;
  return (
    <Section
      id="test-detach"
      title="Detach from Stripe test mode"
      description={`Before billing takes a live Stripe key. ${WHAT} Refused once the key is live.`}
    >
      <div className="space-y-4">
        {error && <Notice tone="error">{error.error}</Notice>}
        {!preview ? (
          <form method="post" action={`${pathname}#test-detach`}>
            <input type="hidden" name="intent" value="test-detach" />
            <Button type="submit" variant="quiet">
              <Eye size={14} />
              Preview what changes
            </Button>
          </form>
        ) : !row ? (
          <Notice tone="ok">Nothing from Stripe's test mode is left on {workspace}: a detach would change nothing.</Notice>
        ) : (
          <>
            <Changes row={row} />
            <p className="tabular text-sm text-muted">
              Balance {usd(row.balance_before_micros, { cents: true })} → {usd(row.balance_after_micros, { cents: true })}.
            </p>
            <form method="post" action={`${pathname}#test-detach`} className="space-y-4">
              <input type="hidden" name="intent" value="test-detach" />
              <input type="hidden" name="confirm" value="yes" />
              {row.subscriptions > 0 && <CancelAtStripe defaultChecked={error?.values?.cancelAtStripe === "on"} />}
              <Field
                label="Confirm"
                hint={
                  <>
                    Type the workspace's slug (<span className="font-mono text-muted">{workspace}</span>) to detach it. Kept in the audit log.
                  </>
                }
              >
                <Input name="confirmation" required placeholder={workspace} className="font-mono" />
              </Field>
              <div className="flex justify-end">
                <ApplyButton label="Detach from test mode" />
              </div>
            </form>
          </>
        )}
      </div>
    </Section>
  );
}

/** The Stripe page's section: every workspace, previewed, then confirmed. */
export function EveryWorkspaceDetachSection({
  live,
  result,
  error,
  exclude,
}: {
  live: boolean;
  result: TestStripeDetach | null;
  error: string | null;
  exclude: string | null;
}) {
  const excludeValue = exclude ?? DEFAULT_EXCLUDED.join(", ");
  const preview = result?.dry_run ? result : null;
  const applied = result && !result.dry_run ? result : null;
  return (
    <Section
      id="test-detach"
      title="Detach every workspace from test mode"
      description={`Run before switching billing to the live key. ${WHAT} Comped and enterprise workspaces are skipped, and so is anything excluded below.`}
      className="mt-6"
    >
      {live ? (
        <Notice tone="info">Billing is on the live key: test-mode data can no longer be detached.</Notice>
      ) : (
        <div className="space-y-4">
          {error && <Notice tone="error">{error}</Notice>}
          <form method="post" action="/stripe#test-detach" className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="intent" value="test-detach-preview" />
            <Field label="Leave alone" hint="Slugs, separated by commas. Blank leaves nothing out." className="grow">
              <Input name="exclude" defaultValue={excludeValue} className="font-mono" />
            </Field>
            <Button type="submit" variant="quiet" className="shrink-0">
              <Eye size={14} />
              Preview
            </Button>
          </form>

          {applied && (
            <>
              <Notice tone={applied.remaining > 0 ? "warn" : "ok"}>
                Detached {applied.workspaces.length} workspace{applied.workspaces.length === 1 ? "" : "s"}.
                {applied.remaining > 0 ? ` ${applied.remaining} more to go: preview and detach again.` : " Each is in its audit log."}
              </Notice>
              {applied.workspaces.length > 0 && <DetachTable rows={applied.workspaces} />}
            </>
          )}

          {preview &&
            (preview.workspaces.length === 0 ? (
              <EmptyState title="Nothing to detach">No workspace outside the exclusions holds anything from Stripe's test mode.</EmptyState>
            ) : (
              <>
                <p className="text-sm text-muted">
                  {preview.workspaces.length} workspace{preview.workspaces.length === 1 ? "" : "s"} will change
                  {preview.workspaces.length > 25 ? ", 25 a run" : ""}:
                </p>
                <DetachTable rows={preview.workspaces} />
                <form method="post" action="/stripe#test-detach" className="space-y-4 border-t border-line pt-4">
                  <input type="hidden" name="intent" value="test-detach-all" />
                  <input type="hidden" name="exclude" value={excludeValue} />
                  {preview.workspaces.some((w) => w.subscriptions > 0) && <CancelAtStripe />}
                  <Field label="Confirm" hint={<>Type <span className="font-mono text-muted">{CONFIRM_ALL}</span> to detach every workspace listed. Each is kept in its audit log.</>}>
                    <Input name="confirmation" required placeholder={CONFIRM_ALL} className="font-mono" />
                  </Field>
                  <div className="flex justify-end">
                    <ApplyButton label={`Detach ${Math.min(preview.workspaces.length, 25)} workspace${preview.workspaces.length === 1 ? "" : "s"}`} />
                  </div>
                </form>
              </>
            ))}

          {result && result.skipped.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs text-faint">Left alone, though they hold test-mode data</p>
              <ul className="space-y-0.5 text-sm">
                {result.skipped.map((s) => (
                  <li key={s.workspace}>
                    <span className="font-mono text-xs">{s.workspace}</span> <span className="text-muted">— {s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
