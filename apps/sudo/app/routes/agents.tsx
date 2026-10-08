import { Check, RefreshCw } from "lucide-react";
import { data, redirect } from "react-router";

import type { AdminModels, CatalogueModel, DiscoveryResult, ModelStatus } from "@g1t/contracts";

import type { Route } from "./+types/agents";
import { Badge, Button, ButtonLink, EmptyState, Field, Input, Notice, PageHeader, Section, Select, When } from "~/components/ui";
import { text } from "~/lib/forms";
import {
  EFFORTS,
  JOBS,
  MAX_REASON,
  MODEL_PURPOSES,
  OVER_FIELDS,
  PRICE_FIELDS,
  TIER_LABELS,
  type DefaultChange,
  choicesFor,
  defaultsByPurpose,
  describeDefault,
  impact,
  parseApproval,
  parseDefault,
  parseReason,
  perMillion,
  pricesOf,
  purposeLabel,
  tokens,
} from "~/lib/models";
import { usd } from "~/lib/money";
import { admin, modelDiscovery } from "~/lib/services.server";
import { settle } from "~/lib/settle";
import { requireStaff } from "~/lib/staff";

export const meta: Route.MetaFunction = () => [{ title: "Agents & models · sudo" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  requireStaff(context);
  const url = new URL(request.url);
  const models = await settle(admin.models());
  const done = url.searchParams.get("done");
  const subject = url.searchParams.get("subject") ?? "";
  const message: Record<string, string> = {
    approved: `${subject} is available now: defaults can use it, and the AI Gateway offers it.`,
    retired: `${subject} is retired. Any default that chose it uses the next suitable model until you choose another.`,
    restored: `${subject} is back where it stood.`,
    default: `The default for ${subject} is saved. Runs pick it up within a minute.`,
  };
  return {
    models: models.ok ? models.value : null,
    error: models.ok ? null : models.error,
    done: done && message[done] ? message[done] : null,
  };
}

type Review = { change: DefaultChange; before: string; after: string; impact: string | null };

type ActionData =
  | { kind: "error"; error: string; target: string; values?: Record<string, string> }
  | { kind: "review"; review: Review }
  | { kind: "checked"; results: DiscoveryResult[] | null; error: string | null };

const back = (done: string, subject: string, anchor: string) =>
  redirect(`/agents?done=${done}&subject=${encodeURIComponent(subject)}#${anchor}`);

/**
 * Checking for new models, approving, retiring and restoring them, and
 * changing a default. Billing checks each again and records it in the
 * audit log with the staff member and why; a default shows what it does
 * to a typical run's cost before it is saved.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const staff = requireStaff(context);
  const form = await request.formData();
  const failed = (error: string, target: string, values?: Record<string, string>) =>
    data<ActionData>({ kind: "error", error, target, values }, { status: 422 });
  const intent = text(form, "intent");

  if (intent === "check") {
    const results = await settle(modelDiscovery.check(staff.email));
    return { kind: "checked", results: results.ok ? results.value : null, error: results.ok ? null : results.error } satisfies ActionData;
  }

  const catalogue = await admin.models().then((m) => m.catalogue);
  if (intent === "approve" || intent === "retire" || intent === "restore") {
    const id = text(form, "model");
    const model = catalogue.find((m) => m.model === id);
    if (!model) return failed(`${id} is not in the catalogue.`, `model-${id}`);
    if (intent === "approve") {
      const approval = parseApproval(form, model.kind ?? "chat");
      if (!approval.ok) return failed(approval.error, `model-${id}`, Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      const { name, tierHint, prices, reason } = approval.value;
      const result = await admin.decideModel(id, "approve", { name, tierHint: tierHint || "", prices }, reason, staff.email);
      if (!result.ok) return failed(result.error.message, `model-${id}`);
      throw back("approved", result.value.name, "catalogue");
    }
    const reason = parseReason(text(form, "reason"));
    if (!reason.ok) return failed(reason.error, `model-${id}`);
    const result = await admin.decideModel(id, intent, {}, reason.value, staff.email);
    if (!result.ok) return failed(result.error.message, `model-${id}`);
    throw back(intent === "retire" ? "retired" : "restored", result.value.name, "catalogue");
  }

  if (intent === "default") {
    const parsed = parseDefault(form, choicesFor(catalogue));
    const purpose = text(form, "purpose");
    if (!parsed.ok) return failed(parsed.error, `default-${purpose}`, { reason: text(form, "reason") });
    const change = parsed.value;
    if (text(form, "confirm") !== "yes") {
      const models = await admin.models();
      const current = defaultsByPurpose(models.defaults).get(change.purpose);
      const resolved = models.resolved.models.find((m) => m.purpose === change.purpose);
      return {
        kind: "review",
        review: {
          change,
          before: current ? describeDefault(current, catalogue) : "nothing",
          after: describeDefault(change, catalogue),
          impact: change.model ? impact(resolved, catalogue.find((m) => m.model === change.model), catalogue) : null,
        },
      } satisfies ActionData;
    }
    const result = await admin.setModelDefault(change.purpose, change, change.reason, staff.email);
    if (!result.ok) return failed(result.error.message, `default-${change.purpose}`);
    throw back("default", purposeLabel(change.purpose), "defaults");
  }
  return data<ActionData>({ kind: "error", error: "Unknown action.", target: "" }, { status: 400 });
}

const STATUS: Record<ModelStatus, { label: string; tone: "mint" | "lavender" | "warn" | "danger" }> = {
  available: { label: "Available", tone: "mint" },
  new: { label: "New", tone: "lavender" },
  deprecated: { label: "Deprecated", tone: "warn" },
  retired: { label: "Retired", tone: "danger" },
};

const PROVIDER: Record<string, string> = { anthropic: "Anthropic", "workers-ai": "Workers AI" };

/** A typical run's cost, with the cents a fast model's run is measured in. */
function runCost(micros: number): string {
  return micros > 0 ? usd(micros) : "—";
}

export default function Agents({ loaderData, actionData }: Route.ComponentProps) {
  const { models, error, done } = loaderData;
  const result = actionData as ActionData | undefined;
  const failure = result?.kind === "error" ? result : null;
  return (
    <main id="top" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-8 sm:py-10">
      <PageHeader
        title="Agents & models"
        description="Every model g1t can use, found by listing each provider daily; new ones wait here for their prices to be confirmed. Staff choose which model each tier and job uses. Customers never pick a model: Auto routes their work with these."
        actions={
          <form method="post" action="/agents#top">
            <input type="hidden" name="intent" value="check" />
            <Button type="submit" variant="lavender">
              <RefreshCw size={14} />
              Check for new models
            </Button>
          </form>
        }
      />
      <div className="mt-6 space-y-3">
        {done && <Notice tone="ok">{done}</Notice>}
        {error && <Notice tone="error">Billing did not answer: {error}</Notice>}
        {failure && !failure.target && <Notice tone="error">{failure.error}</Notice>}
        {result?.kind === "checked" && <Checked results={result.results} error={result.error} />}
      </div>
      {result?.kind === "review" && <ReviewPanel review={result.review} />}
      {models && <Page models={models} failure={failure} />}
    </main>
  );
}

function Checked({ results, error }: { results: DiscoveryResult[] | null; error: string | null }) {
  if (!results) return <Notice tone="error">The model proxy did not answer: {error}</Notice>;
  return (
    <Notice tone={results.some((r) => r.error) ? "warn" : "ok"}>
      <ul className="space-y-1">
        {results.map((r) => (
          <li key={r.provider}>
            <span className="font-medium text-fg">{PROVIDER[r.provider] ?? r.provider}</span>:{" "}
            {r.error
              ? `could not be listed (${r.error}). Nothing changed.`
              : `${r.listed} listed; ${r.added.length ? `new: ${r.added.join(", ")}` : "nothing new"}${r.deprecated.length ? `; no longer listed: ${r.deprecated.join(", ")}` : ""}${r.restored.length ? `; listed again: ${r.restored.join(", ")}` : ""}.`}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function ReviewPanel({ review }: { review: Review }) {
  const { change } = review;
  return (
    <Section id="review" className="mt-6 border-accent/40" title={`Change ${purposeLabel(change.purpose)}?`} description="Nothing is saved until you confirm.">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="text-muted">Now</dt>
        <dd>{review.before}</dd>
        <dt className="text-muted">After</dt>
        <dd className="font-medium">{review.after}</dd>
        {review.impact && (
          <>
            <dt className="text-muted">Cost</dt>
            <dd>{review.impact}</dd>
          </>
        )}
        <dt className="text-muted">Why</dt>
        <dd className="text-fg-soft">{change.reason}</dd>
      </dl>
      <form method="post" action="/agents#defaults" className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="intent" value="default" />
        <input type="hidden" name="confirm" value="yes" />
        <input type="hidden" name="purpose" value={change.purpose} />
        {change.model && <input type="hidden" name="model" value={change.model} />}
        {change.tier && <input type="hidden" name="tier" value={change.tier} />}
        <input type="hidden" name="effort" value={change.effort ?? ""} />
        <input type="hidden" name="reason" value={change.reason} />
        <Button type="submit" variant="lavender">
          <Check size={14} />
          Save
        </Button>
        <ButtonLink to="/agents#defaults" variant="quiet">
          Cancel
        </ButtonLink>
      </form>
    </Section>
  );
}

type Failure = Extract<ActionData, { kind: "error" }> | null;

function Page({ models, failure }: { models: AdminModels; failure: Failure }) {
  const waiting = models.catalogue.filter((m) => m.status === "new");
  const t = models.typical;
  return (
    <>
      <Defaults models={models} failure={failure} />
      <Section
        id="waiting"
        className="mt-6"
        title="New models"
        description="Found by a check and not used for anything yet. Confirm the name and prices (from the provider's price page) to make one available; until then nothing routes to it, offers it or charges for it."
      >
        {waiting.length === 0 ? (
          <EmptyState title="Nothing waiting">A model a provider starts listing appears here after the next check.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {waiting.map((model) => (
              <Waiting key={model.model} model={model} failure={failure?.target === `model-${model.model}` ? failure : null} />
            ))}
          </ul>
        )}
      </Section>
      <Section
        id="catalogue"
        className="mt-6"
        title="Catalogue"
        description={`Prices per million tokens. A typical run is ${t.requests} requests of ${t.input.toLocaleString("en-US")} input, ${t.output.toLocaleString("en-US")} output, ${t.cacheRead.toLocaleString("en-US")} cache-read and ${t.cacheWrite.toLocaleString("en-US")} cache-write tokens: an estimate for comparing models, never a charge.`}
      >
        <Catalogue catalogue={models.catalogue} failure={failure} />
      </Section>
      <Section id="checks" className="mt-6" title="Checks" description="Each provider is listed daily at 05:29 UTC, and whenever someone checks from here. Listing models is free; nothing calls a model.">
        {models.checks.length === 0 ? (
          <EmptyState title="No checks yet">Check for new models above, or wait for the daily check.</EmptyState>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {models.checks.map((check) => (
              <li key={check.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-4">
                <span className="w-28 shrink-0 font-medium">{PROVIDER[check.provider] ?? check.provider}</span>
                <span className="w-44 shrink-0 text-muted">
                  <When at={check.checkedAt} time />
                </span>
                <span className="min-w-0 flex-1 text-fg-soft">
                  {check.error ? (
                    <span className="text-danger">Failed: {check.error}</span>
                  ) : (
                    <>
                      {check.listed} listed
                      {check.added.length > 0 && <>; new: {check.added.join(", ")}</>}
                      {check.deprecated.length > 0 && <>; gone: {check.deprecated.join(", ")}</>}
                    </>
                  )}
                </span>
                <span className="text-xs text-faint">{check.by === "schedule" ? "Daily check" : check.by}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Defaults({ models, failure }: { models: AdminModels; failure: Failure }) {
  const choices = choicesFor(models.catalogue);
  const current = defaultsByPurpose(models.defaults);
  return (
    <Section
      id="defaults"
      className="mt-6"
      title="Defaults"
      description="What Auto runs each tier on, the harness's background model, the AI Gateway's first Claude, and where each kind of job starts and how hard it thinks. Runs read these within a minute; a model that is retired or no longer listed is never used, and the next suitable one runs instead."
    >
      <ul className="divide-y divide-line">
        {MODEL_PURPOSES.map((info) => {
          const row = current.get(info.purpose);
          const resolved = models.resolved.models.find((m) => m.purpose === info.purpose);
          const running = resolved?.model ? models.catalogue.find((m) => m.model === resolved.model!.model) : undefined;
          const error = failure?.target === `default-${info.purpose}` ? failure : null;
          return (
            <li key={info.purpose} id={`default-${info.purpose}`} className="scroll-mt-20 py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div>
                  <h3 className="text-sm font-semibold">{info.label}</h3>
                  <p className="text-xs text-muted">{info.about}</p>
                </div>
                <div className="text-right text-sm">
                  <span className="font-medium">{running?.name ?? resolved?.chosen ?? "Not set"}</span>
                  {running && running.typicalRunMicros > 0 && <span className="ml-2 text-xs text-muted">{runCost(running.typicalRunMicros)} a typical run</span>}
                </div>
              </div>
              {resolved?.note && (
                <div className="mt-2">
                  <Notice tone="warn">{resolved.note}</Notice>
                </div>
              )}
              {row && (
                <p className="mt-1 text-xs text-faint">
                  Set by {row.updatedBy} <When at={row.updatedAt} />
                  {row.reason ? `: ${row.reason}` : ""}
                </p>
              )}
              <form method="post" action={`/agents#review`} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
                <input type="hidden" name="intent" value="default" />
                <input type="hidden" name="purpose" value={info.purpose} />
                <Select name="model" defaultValue={row?.model ?? ""} aria-label={`Model for ${info.label}`}>
                  {choices.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.name} · {runCost(m.typicalRunMicros)}
                    </option>
                  ))}
                </Select>
                <Input name="reason" required maxLength={MAX_REASON} placeholder="Why" aria-label={`Why change ${info.label}`} defaultValue={error?.values?.reason} />
                <Button type="submit" variant="quiet">
                  Review
                </Button>
              </form>
              {error && (
                <div className="mt-2">
                  <Notice tone="error">{error.error}</Notice>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <h3 className="mt-6 border-t border-line pt-4 text-sm font-semibold">Jobs</h3>
      <p className="text-xs text-muted">
        Where each kind of job starts. Failures, labels and the repository's own history still move it up or down. Effort applies on models that take
        it; on one that does not, the harness's own.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {JOBS.map((job) => {
          const purpose = `job_${job.kind}`;
          const row = current.get(purpose);
          const error = failure?.target === `default-${purpose}` ? failure : null;
          const tiers = job.kind === "review" ? ["small", "large", "frontier", "change"] : ["small", "large", "frontier"];
          return (
            <li key={job.kind} id={`default-${purpose}`} className="scroll-mt-20 py-3 first:pt-0 last:pb-0">
              <form method="post" action="/agents#review" className="grid gap-2 sm:grid-cols-[10rem_minmax(0,11rem)_minmax(0,9rem)_minmax(0,1fr)_auto] sm:items-center">
                <input type="hidden" name="intent" value="default" />
                <input type="hidden" name="purpose" value={purpose} />
                <div>
                  <span className="text-sm font-medium">{job.label}</span>
                  {row && (
                    <span className="block text-xs text-faint">
                      {row.updatedBy} <When at={row.updatedAt} />
                    </span>
                  )}
                </div>
                <Select name="tier" defaultValue={row?.tier ?? "large"} aria-label={`Starting tier for ${job.label}`}>
                  {tiers.map((tier) => (
                    <option key={tier} value={tier}>
                      {TIER_LABELS[tier]}
                    </option>
                  ))}
                </Select>
                <Select name="effort" defaultValue={row?.effort ?? ""} aria-label={`Effort for ${job.label}`}>
                  <option value="">Harness's own</option>
                  {EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort} effort
                    </option>
                  ))}
                </Select>
                <Input name="reason" required maxLength={MAX_REASON} placeholder="Why" aria-label={`Why change ${job.label}`} />
                <Button type="submit" variant="quiet">
                  Review
                </Button>
              </form>
              {error && (
                <div className="mt-2">
                  <Notice tone="error">{error.error}</Notice>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Waiting({ model, failure }: { model: CatalogueModel; failure: Failure }) {
  const prices = pricesOf(model);
  const value = (name: string, fallback: string) => failure?.values?.[name] ?? fallback;
  return (
    <li id={`model-${model.model}`} className="scroll-mt-20 rounded-lg border border-line bg-bg p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{model.name}</span>
        <code className="text-xs text-muted">{model.model}</code>
        <Badge>{PROVIDER[model.provider] ?? model.provider}</Badge>
        {!model.priced && <Badge tone="warn">No price known</Badge>}
      </div>
      <p className="mt-1 text-xs text-muted">
        Found <When at={model.firstSeenAt} /> · {model.kind === "embeddings" ? "Embeddings" : "Chat"} · context {tokens(model.contextWindow)}
        {model.capabilities.length > 0 && <> · {model.capabilities.join(", ")}</>}
        {model.priced && " · prices filled from the provider; check them"}
      </p>
      <form method="post" action={`/agents#model-${model.model}`} className="mt-4 space-y-3">
        <input type="hidden" name="intent" value="approve" />
        <input type="hidden" name="model" value={model.model} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
          <Field label="Name people see">
            <Input name="name" required maxLength={120} defaultValue={value("name", model.name)} />
          </Field>
          <Field label="Suits the tier">
            <Select name="tier_hint" defaultValue={value("tier_hint", model.tierHint)}>
              <option value="">None</option>
              <option value="small">Fast</option>
              <option value="large">Standard</option>
              <option value="frontier">Most capable</option>
            </Select>
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-muted">Dollars per million tokens</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {PRICE_FIELDS.map((field) => (
              <Field key={field.name} label={field.label}>
                <Input name={field.name} inputMode="decimal" className="font-mono" defaultValue={value(field.name, model.priced ? perMillion(prices[field.key]) : "")} />
              </Field>
            ))}
          </div>
        </fieldset>
        <details className="rounded-md border border-line px-3 py-2" open={prices.threshold > 0}>
          <summary className="cursor-pointer text-sm text-muted">Priced by prompt length</summary>
          <div className="mt-3 space-y-3">
            <Field label="Above this many prompt tokens" hint="The whole request is charged at the prices below once its prompt (input and cache tokens) is longer.">
              <Input name="threshold" inputMode="numeric" className="font-mono" defaultValue={value("threshold", prices.threshold ? String(prices.threshold) : "")} />
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {OVER_FIELDS.map((field) => (
                <Field key={field.name} label={field.label}>
                  <Input name={field.name} inputMode="decimal" className="font-mono" defaultValue={value(field.name, prices[field.key] ? perMillion(prices[field.key]) : "")} />
                </Field>
              ))}
            </div>
          </div>
        </details>
        <Field label="Why" hint="Kept with the model, and in the audit log.">
          <Input name="reason" required maxLength={MAX_REASON} placeholder="e.g. Prices from the provider's price page, 2026-10-08." defaultValue={value("reason", "")} />
        </Field>
        {failure && <Notice tone="error">{failure.error}</Notice>}
        <div className="flex justify-end">
          <Button type="submit" variant="lavender">
            <Check size={14} />
            Approve
          </Button>
        </div>
      </form>
      <Decide model={model} intent="retire" label="Retire instead" />
    </li>
  );
}

/** A retire or restore form, folded away until opened. */
function Decide({ model, intent, label }: { model: CatalogueModel; intent: "retire" | "restore"; label: string }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-muted hover:text-fg">{label}</summary>
      <form method="post" action={`/agents#model-${model.model}`} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input type="hidden" name="intent" value={intent} />
        <input type="hidden" name="model" value={model.model} />
        <Input name="reason" required maxLength={MAX_REASON} placeholder="Why" aria-label={`Why ${intent} ${model.name}`} />
        <Button type="submit" variant={intent === "retire" ? "danger" : "quiet"}>
          {intent === "retire" ? "Retire" : "Restore"}
        </Button>
      </form>
    </details>
  );
}

function Catalogue({ catalogue, failure }: { catalogue: CatalogueModel[]; failure: Failure }) {
  const listed = catalogue.filter((m) => m.status !== "new");
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-[56rem] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium sm:px-5">Model</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Suits</th>
            <th className="px-4 py-2 text-right font-medium">Context</th>
            <th className="px-4 py-2 text-right font-medium">In / out</th>
            <th className="px-4 py-2 text-right font-medium">Cache read</th>
            <th className="px-4 py-2 text-right font-medium">Typical run</th>
            <th className="px-4 py-2 font-medium sm:pr-5">Listed</th>
          </tr>
        </thead>
        <tbody>
          {listed.map((model) => {
            const status = STATUS[model.status] ?? STATUS.available;
            const error = failure?.target === `model-${model.model}` ? failure : null;
            return (
              <tr key={model.model} id={`model-${model.model}`} className="scroll-mt-20 border-b border-line align-top last:border-0">
                <td className="px-4 py-2.5 sm:px-5">
                  <span className="font-medium">{model.name}</span>
                  <code className="block text-xs text-muted">{model.model}</code>
                  {model.aliases.length > 0 && <span className="block text-xs text-faint">also {model.aliases.join(", ")}</span>}
                  <span className="block text-xs text-faint">{PROVIDER[model.provider] ?? model.provider}</span>
                  {error && <span className="mt-1 block text-xs text-danger">{error.error}</span>}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {!model.priced && (
                    <span className="mt-1 block">
                      <Badge tone="warn">Unpriced</Badge>
                    </span>
                  )}
                  {model.status === "available" ? (
                    <Decide model={model} intent="retire" label="Retire" />
                  ) : (
                    <Decide model={model} intent="restore" label="Restore" />
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{model.kind === "embeddings" ? `Embeddings${model.dimensions ? `, ${model.dimensions}` : ""}` : TIER_LABELS[model.tierHint] ?? "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{tokens(model.contextWindow)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                  ${perMillion(model.inputMicros)}
                  {model.kind !== "embeddings" && <> / ${perMillion(model.outputMicros)}</>}
                  {model.threshold ? <span className="block text-xs text-faint">over {tokens(model.threshold)}: ${perMillion(model.overInputMicros)} / ${perMillion(model.overOutputMicros)}</span> : null}
                </td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{model.kind === "embeddings" ? "—" : `$${perMillion(model.cacheReadMicros)}`}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums">{runCost(model.typicalRunMicros)}</td>
                <td className="px-4 py-2.5 text-xs text-muted sm:pr-5">
                  {model.missingSince ? (
                    <span className="text-warn">
                      Not since <When at={model.missingSince} />
                    </span>
                  ) : model.lastSeenAt ? (
                    <When at={model.lastSeenAt} />
                  ) : (
                    "Not checked yet"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
