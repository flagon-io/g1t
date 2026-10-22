import { HardDrive, Lock, Search, Unlock } from "lucide-react";
import { Link, data, redirect } from "react-router";

import type { StorageDrift, StorageHold, StorageHoldInspection, StorageHoldRepo, StorageRecovery, UpstreamState } from "@g1t/contracts";

import type { Route } from "./+types/storage";
import { Badge, Button, EmptyState, Field, Input, Notice, PageHeader, Section, Stat, Textarea, When } from "~/components/ui";
import { text } from "~/lib/forms";
import { admin, reposAdmin } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";
import {
  MAX_REASON,
  type BlockedSource,
  auditState,
  blockedSources,
  blockedSummary,
  formatAge,
  formatBytes,
  holdKey,
  kindLabel,
  operationLabel,
  parseHoldKey,
  parseRelease,
  parseSample,
  releaseHold,
  releasedNotice,
} from "~/lib/storage-holds";

export const meta: Route.MetaFunction = () => [{ title: "Storage holds · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const picked = parseHoldKey(url.searchParams.get("hold"));
  const [holds, recoveries, inspection] = await Promise.all([
    settle(reposAdmin.holds(200)),
    settle(reposAdmin.recoveries(50)),
    picked ? settle(reposAdmin.inspect(picked.kind, picked.id)) : Promise.resolve(null),
  ]);
  const released = releasedNotice(url.searchParams);
  return {
    holds: holds.ok ? holds.value : null,
    recoveries: recoveries.ok ? recoveries.value : [],
    error: !holds.ok ? holds.error : !recoveries.ok ? recoveries.error : null,
    picked: picked ? holdKey(picked.kind, picked.id) : null,
    inspection: inspection && inspection.ok && inspection.value.ok ? inspection.value.value : null,
    inspectionError: !inspection ? null : !inspection.ok ? inspection.error : !inspection.value.ok ? inspection.value.error.message : null,
    done: released?.done ?? null,
    auditNotice: released?.audit ?? null,
  };
}

type ActionData = { error?: string; key?: string; drift?: StorageDrift };

/**
 * Releasing a hold, and measuring drift. The repos service inspects the
 * hold again and refuses unless it is provably abandoned; the release, its
 * `storage_recoveries` row and its line for sudo's audit log are one batch
 * there, and the repos service sends the line to billing until billing
 * confirms it. The page says when it is not confirmed yet.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  switch (text(form, "intent")) {
    case "release": {
      const key = text(form, "hold");
      const parsed = parseRelease(key, text(form, "reason"));
      if (!parsed.ok) return data<ActionData>({ error: parsed.error, key }, { status: 422 });
      const { kind, id, reason } = parsed.value;
      const result = await releaseHold({ release: reposAdmin.release, log: admin.log }, { kind, id, reason }, staff.email);
      if (!result.ok) return data<ActionData>({ error: result.error, key }, { status: result.status });
      const what = `${kindLabel(kind).toLowerCase()} ${result.recovery.bytes ? `of ${formatBytes(result.recovery.bytes)} ` : ""}on ${id}`;
      const params = new URLSearchParams({ done: "released", what });
      if (result.audit === "queued") params.set("queued", result.recovery.id);
      if (result.audit === "missed") params.set("unaudited", result.recovery.id);
      throw redirect(`/storage?${params}`);
    }
    case "drift": {
      const result = await settle(reposAdmin.drift({ sample: parseSample(text(form, "sample")) }));
      if (!result.ok) return data<ActionData>({ error: `The repos service did not answer: ${result.error}` }, { status: 502 });
      return data<ActionData>({ drift: result.value });
    }
  }
  return data<ActionData>({ error: "Unknown action." }, { status: 400 });
}

export default function Storage({ loaderData, actionData }: Route.ComponentProps) {
  const { holds, recoveries, error, picked, inspection, inspectionError, done, auditNotice } = loaderData;
  const list = holds?.holds ?? [];
  const held = list.reduce((sum, hold) => sum + hold.bytes, 0);
  const abandoned = list.filter((hold) => hold.abandoned);
  const locks = list.filter((hold) => hold.kind === "copy_lock").length;
  // Sources a copy lock keeps from taking writes: one held past a copy's
  // usual time, or kept after its fork's call failed, stands out.
  const blocked = holds ? blockedSources(list, holds.now, holds.more) : [];
  const summary = blockedSummary(blocked);
  const stalled = blocked.filter((source) => source.stalled).length;
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:py-10">
      <PageHeader
        title="Storage holds"
        description="Public storage a write reserved before it reached the git store, and the locks native forks put on their source. A write that was interrupted keeps its hold, which counts against the workspace's 5 GB and, for a copy lock, refuses pushes to the source. A hold is released here only when it is provably abandoned: the write recorded that it stopped, or its lease and grace have passed, so it can no longer send anything. Never by age alone."
      />
      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {auditNotice && <Notice tone={auditNotice.tone}>{auditNotice.text}</Notice>}
        {error && <Notice tone="error">The repos service did not answer: {error}</Notice>}
        {actionData?.error && !actionData.key && <Notice tone="error">{actionData.error}</Notice>}
        {summary && <Notice tone={stalled ? "error" : "warn"}>{summary}</Notice>}
      </div>
      {holds && (
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Holds" value={list.length + holds.more} hint={holds.more ? `${holds.more} not listed` : undefined} />
          <Stat label="Capacity held" value={formatBytes(held)} />
          <Stat
            label="Provably abandoned"
            value={abandoned.length}
            tone={abandoned.length ? "warn" : undefined}
            hint={formatBytes(abandoned.reduce((sum, hold) => sum + hold.bytes, 0))}
          />
          <Stat
            label="Copy locks"
            value={locks}
            tone={stalled ? "danger" : locks ? "warn" : undefined}
            hint={
              stalled ? (
                `${stalled} did not finish cleanly`
              ) : holds.ledgerSince ? (
                <>
                  Ledger since <When at={holds.ledgerSince} />
                </>
              ) : (
                "No ledger yet"
              )
            }
          />
        </div>
      )}
      {picked && (
        <Inspection
          picked={picked}
          inspection={inspection}
          error={inspectionError}
          actionError={actionData?.key === picked ? (actionData.error ?? null) : null}
        />
      )}
      {blocked.length > 0 && <Blocked blocked={blocked} picked={picked} />}
      <Section title="Holds" description="Oldest first. Inspect one to see the git store's state and release it." className="mt-6">
        {list.length === 0 ? (
          <EmptyState title={holds ? "Nothing is held" : "Nothing to show"}>
            {holds ? "Every write has settled its reservation, and no fork is copying." : null}
          </EmptyState>
        ) : (
          <ul className="-mx-4 -my-4 divide-y divide-line sm:-mx-5 sm:-my-5">
            {list.map((hold) => (
              <HoldRow key={holdKey(hold.kind, hold.id)} hold={hold} current={picked === holdKey(hold.kind, hold.id)} />
            ))}
          </ul>
        )}
      </Section>
      <Section title="Released" description="Every hold staff released, newest first, with who, why and what the inspection found." className="mt-6">
        {recoveries.length === 0 ? <EmptyState title="Nothing released yet" /> : <Recoveries recoveries={recoveries} />}
      </Section>
      <Drift drift={actionData?.drift ?? null} />
    </main>
  );
}

function RepoName({ repo }: { repo: StorageHoldRepo | null }) {
  if (!repo) return <span className="text-faint">—</span>;
  if (!repo.path) return <span className="font-mono text-faint">{repo.id} (gone)</span>;
  const workspace = repo.path.split("/")[0] ?? "";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Link to={`/workspaces/${encodeURIComponent(workspace)}`} className="font-mono text-fg hover:underline">
        {repo.path}
      </Link>
      {repo.private ? <Badge>private</Badge> : <Badge tone="info">public</Badge>}
      {repo.deleted && <Badge tone="danger">deleted</Badge>}
    </span>
  );
}

/**
 * The repositories a copy lock keeps from taking writes. Their writers are
 * told so (public_storage.rs `Refusal`): "a few minutes" while the copy
 * runs, "a few hours" once it did not finish cleanly, when the lock stays
 * until it is released here.
 */
function Blocked({ blocked, picked }: { blocked: BlockedSource[]; picked: string | null }) {
  return (
    <Section
      title="Writes blocked"
      description="Repositories being copied into a fork take no pushes, commits from the site, merges or pull request updates until the copy ends. A copy ordinarily ends within a few minutes; one that did not finish cleanly keeps its lock until it is released here."
      className="mt-6"
    >
      <ul className="-mx-4 -my-4 divide-y divide-line sm:-mx-5 sm:-my-5">
        {blocked.map(({ lock, fork, stalled, attention }) => {
          const key = holdKey(lock.kind, lock.id);
          return (
            <li key={key} className={`flex flex-col gap-1.5 px-4 py-3 sm:px-5 ${picked === key ? "bg-accent/5" : ""}`}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Lock size={14} className={stalled ? "text-danger" : attention ? "text-warn" : "text-faint"} />
                <RepoName repo={lock.repo} />
                <span className="text-xs text-muted">into</span>
                <RepoName repo={lock.target} />
                {stalled ? (
                  <Badge tone="danger">did not finish cleanly</Badge>
                ) : attention ? (
                  <Badge tone="warn">slow</Badge>
                ) : (
                  <Badge tone="mint">copying</Badge>
                )}
                <span className="ml-auto text-xs text-faint">blocked for {formatAge(lock.ageSeconds)}</span>
              </p>
              {fork?.state === "ended" && <p className="text-xs text-muted">The fork's call to the store ended: {fork.outcome ?? "with no answer"}</p>}
              <p className="text-xs text-fg-soft">
                {lock.abandoned ? (
                  "Provably abandoned: it can be released now."
                ) : lock.releasableAt ? (
                  <>
                    Releasable from <When at={lock.releasableAt} time />, if the copy has not ended by then.
                  </>
                ) : (
                  lock.why
                )}
              </p>
              <p>
                <Link to={`/storage?hold=${encodeURIComponent(key)}#inspection`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  <Search size={12} />
                  Inspect
                </Link>
              </p>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Verdict({ hold }: { hold: StorageHold }) {
  return hold.abandoned ? <Badge tone="warn">provably abandoned</Badge> : <Badge tone="mint">may be in flight</Badge>;
}

function HoldRow({ hold, current }: { hold: StorageHold; current: boolean }) {
  const key = holdKey(hold.kind, hold.id);
  return (
    <li className={`flex flex-col gap-1.5 px-4 py-3 sm:px-5 ${current ? "bg-accent/5" : ""}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="lavender">{kindLabel(hold.kind)}</Badge>
        <RepoName repo={hold.repo} />
        {hold.kind !== "copy_lock" && <span className="tabular font-medium">{formatBytes(hold.bytes)}</span>}
        <Verdict hold={hold} />
        {hold.state === "ended" && <Badge tone="danger">ended</Badge>}
        <span className="ml-auto text-xs text-faint">{formatAge(hold.ageSeconds)}</span>
      </p>
      <p className="text-xs text-muted">
        {operationLabel(hold.operation, hold.kind)}
        {hold.target && hold.target.id !== hold.repo.id && (
          <>
            {" "}
            into <RepoName repo={hold.target} />
          </>
        )}
        {hold.actor && <span className="font-mono"> · by {hold.actor}</span>}
        {hold.since && (
          <>
            {" "}
            · since <When at={hold.since} time />
          </>
        )}
      </p>
      <p className="text-xs text-fg-soft">{hold.why}</p>
      <p>
        <Link to={`/storage?hold=${encodeURIComponent(key)}#inspection`} className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
          <Search size={12} />
          Inspect
        </Link>
      </p>
    </li>
  );
}

function Inspection({
  picked,
  inspection,
  error,
  actionError,
}: {
  picked: string;
  inspection: StorageHoldInspection | null;
  error: string | null;
  actionError: string | null;
}) {
  return (
    <Section id="inspection" title="Inspection" description={<span className="font-mono">{picked}</span>} className="mt-6">
      {error && <Notice tone="error">{error}</Notice>}
      {inspection && (
        <div className="space-y-4">
          <div className="space-y-1 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="lavender">{kindLabel(inspection.hold.kind)}</Badge>
              <RepoName repo={inspection.hold.repo} />
              <Verdict hold={inspection.hold} />
            </p>
            <p className="text-fg-soft">{inspection.hold.why}</p>
            {inspection.hold.outcome && <p className="text-muted">How it ended: {inspection.hold.outcome}</p>}
            {inspection.hold.leaseUntil && (
              <p className="text-muted">
                Lease until <When at={inspection.hold.leaseUntil} time />
                {inspection.hold.releasableAt && (
                  <>
                    ; provably abandoned from <When at={inspection.hold.releasableAt} time /> if nothing changes
                  </>
                )}
              </p>
            )}
          </div>
          <div className="space-y-3">
            {inspection.upstream.map((state) => (
              <Upstream key={`${state.role}-${state.repo.id}`} state={state} />
            ))}
          </div>
          {actionError && <Notice tone="error">{actionError}</Notice>}
          {inspection.releasable ? (
            <form method="post" action={`/storage?hold=${encodeURIComponent(picked)}#inspection`} className="space-y-3 border-t border-line pt-4">
              <input type="hidden" name="intent" value="release" />
              <input type="hidden" name="hold" value={picked} />
              <Field label="Why release it" hint="Kept in the audit row with this inspection. Releasing never changes what the workspace is billed.">
                <Textarea
                  name="reason"
                  rows={2}
                  required
                  maxLength={MAX_REASON}
                  placeholder="e.g. The push ended with a 500; the refs it asked for are not in the store."
                />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" variant="danger">
                  <Unlock size={14} />
                  Release
                </Button>
              </div>
            </form>
          ) : (
            <Notice tone="info">{inspection.refusal ?? "Not provably abandoned yet."} It stays until then.</Notice>
          )}
        </div>
      )}
    </Section>
  );
}

const ROLE: Record<UpstreamState["role"], string> = {
  charged: "Charged",
  written: "Written",
  source: "Source",
};

function Upstream({ state }: { state: UpstreamState }) {
  return (
    <div className="rounded-md border border-line px-3.5 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">{ROLE[state.role] ?? state.role}</span>
        <RepoName repo={state.repo} />
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-faint">In the store</dt>
          <dd>{state.read ? `${state.refs} refs` : <span className="text-warn">{state.error ?? "not read"}</span>}</dd>
        </div>
        <div>
          <dt className="text-faint">Default branch</dt>
          <dd className="font-mono">{state.head ? state.head.slice(0, 12) : "—"}</dd>
        </div>
        <div>
          <dt className="text-faint">Stored (billed)</dt>
          <dd className="tabular">{state.storedBytes == null ? "—" : formatBytes(state.storedBytes)}</dd>
        </div>
        <div>
          <dt className="text-faint">Reserved · in the ledger</dt>
          <dd className="tabular">{state.reservedBytes == null ? "—" : `${formatBytes(state.reservedBytes)} · ${formatBytes(state.ledgerBytes ?? 0)}`}</dd>
        </div>
      </dl>
      {state.asked.length > 0 && (
        <ul className="mt-2 space-y-0.5 font-mono text-xs">
          {state.asked.map((asked) => (
            <li key={asked.name} className="wrap-break-word">
              {asked.name}: asked {asked.asked.slice(0, 12)}, the store has {asked.now ? asked.now.slice(0, 12) : "nothing"}{" "}
              {asked.now === asked.asked ? <Badge tone="warn">landed</Badge> : <Badge>not there</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Recoveries({ recoveries }: { recoveries: StorageRecovery[] }) {
  return (
    <ul className="-mx-4 -my-4 divide-y divide-line sm:-mx-5 sm:-my-5">
      {recoveries.map((recovery) => (
        <li key={recovery.id} className="flex flex-col gap-1 px-4 py-3 text-sm sm:px-5">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="lavender">{kindLabel(recovery.kind)}</Badge>
            <RepoName repo={recovery.evidence?.hold.repo ?? { id: recovery.repoId, path: null, private: false, deleted: false }} />
            {recovery.kind !== "copy_lock" && <span className="tabular">{formatBytes(recovery.bytes)}</span>}
            <span className="ml-auto text-xs text-faint">
              <When at={recovery.releasedAt} time />
            </span>
          </p>
          <p className="text-xs text-muted">
            {operationLabel(recovery.operation, recovery.kind)} · released by {recovery.staff}: {recovery.reason}
          </p>
          {recovery.evidence?.hold.why && <p className="text-xs text-faint">{recovery.evidence.hold.why}</p>}
          {auditState(recovery) && <p className="text-xs text-muted">{auditState(recovery)}</p>}
        </li>
      ))}
    </ul>
  );
}

function Drift({ drift }: { drift: StorageDrift | null }) {
  return (
    <Section
      title="Drift"
      description="What the git store sends for every ref of a random sample of repositories, against what g1t counts (stored_bytes, which private storage is billed from). Reads only: nothing found here is written. Each repository is streamed in full, so keep the sample small."
      className="mt-6"
    >
      <form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <input type="hidden" name="intent" value="drift" />
        <Field label="Repositories" hint="1 to 20; those over 200 MB are passed over.">
          <Input name="sample" type="number" min={1} max={20} defaultValue={5} className="w-28" />
        </Field>
        <Button type="submit" variant="quiet">
          <HardDrive size={14} />
          Measure
        </Button>
      </form>
      {drift && (
        <div className="mt-4 overflow-x-auto">
          <p className="mb-2 text-xs text-muted">
            Measured <When at={drift.measuredAt} time />: the store holds {formatBytes(drift.storeBytes)} where g1t counts {formatBytes(drift.storedBytes)}.
          </p>
          <table className="w-full min-w-xl text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1.5 font-medium">Repository</th>
                <th className="py-1.5 text-right font-medium">g1t counts</th>
                <th className="py-1.5 text-right font-medium">The store holds</th>
                <th className="py-1.5 text-right font-medium">Drift</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {drift.repos.map((repo) => (
                <tr key={repo.repo.id}>
                  <td className="py-1.5">
                    <RepoName repo={repo.repo} />
                    {repo.workingCopies > 0 && <span className="ml-1 text-xs text-faint">+{repo.workingCopies} working copies</span>}
                    {repo.note && <p className="text-xs text-faint">{repo.note}</p>}
                  </td>
                  <td className="tabular py-1.5 text-right">{formatBytes(repo.storedBytes)}</td>
                  <td className="tabular py-1.5 text-right">{repo.storeBytes == null ? "—" : formatBytes(repo.storeBytes)}</td>
                  <td className={`tabular py-1.5 text-right ${(repo.driftBytes ?? 0) > 0 ? "text-warn" : ""}`}>
                    {repo.driftBytes == null ? "—" : formatBytes(repo.driftBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
