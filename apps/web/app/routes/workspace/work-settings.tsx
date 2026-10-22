import { Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { CycleSettings, Cycles, SpendVisibility } from "@g1t/contracts";

import type { Route } from "./+types/work-settings";
import { ErrorText } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { SelectField } from "../../components/ui/select";
import { SwitchCard } from "../../components/ui/switch";
import { cycleDays, cycleName, cyclePath, daysLeftText, firstCycle, utcToday, weekdayName } from "../../lib/cycles";
import { page } from "../../lib/meta";
import { SPEND_VISIBILITY } from "../../lib/spend";
import { work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, roleIn } from "../../lib/session.server";
import { canItem } from "../../lib/work-access";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Work settings · ${params.owner} · g1t` });
}

/**
 * Settings, Work: the workspace's cycles, and who sees each person's
 * spend. Every member can read them; whoever may manage milestones (the
 * Write role) changes the cycles, as with the plan's own settings, and
 * only owners the spend. The work service checks both again.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const today = utcToday(Date.now());
  // There is no read of the setting alone: the viewer's own spend for today carries it.
  const [found, spend] = await Promise.all([
    work.listCycles(slug, viewer, 0).catch(() => null),
    work.getSpend(slug, viewer, { since: today, until: today }).catch(() => null),
  ]);
  const canEdit = canItem(viewer, slug, null, "manage_labels");
  const spendSettings = { visibility: spend?.ok ? spend.value.visibility : null, canEdit: role === "owner" };
  if (!found?.ok)
    return { slug, cycles: null, canEdit, today, spend: spendSettings, error: found ? found.error.message : "Work didn't answer. Try again in a moment." };
  return { slug, cycles: found.value, canEdit, today, spend: spendSettings, error: null };
}

const VISIBILITIES: SpendVisibility[] = ["owners", "members", "nobody"];

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  // The Spend section's own form.
  if (form.get("intent") === "spend") {
    const visibility = VISIBILITIES.find((value) => value === form.get("visibility"));
    if (!visibility) return { intent: "spend" as const, ok: false as const, error: "Choose who sees each person's spend." };
    try {
      const saved = await work.configureSpend(viewer, slug, visibility);
      return saved.ok
        ? { intent: "spend" as const, ok: true as const, visibility: saved.value.visibility }
        : { intent: "spend" as const, ok: false as const, error: saved.error.message };
    } catch (error) {
      console.error("work settings: the work service did not answer", error);
      return { intent: "spend" as const, ok: false as const, error: "Work didn't answer. Try again in a moment." };
    }
  }
  const cooldown = Number(form.get("cooldown_days"));
  if (!Number.isInteger(cooldown) || cooldown < 0 || cooldown > 14) return { ok: false as const, error: "A cooldown is a whole number of days, 0 to 14." };
  try {
    const saved = await work.configureCycles(viewer, slug, {
      enabled: form.get("enabled") === "on",
      lengthDays: form.get("length_days") === "7" ? 7 : 14,
      startsWeekday: Math.min(7, Math.max(1, Number(form.get("starts_weekday")) || 1)),
      cooldownDays: cooldown,
    });
    return saved.ok ? { ok: true as const, cycles: saved.value } : { ok: false as const, error: saved.error.message };
  } catch (error) {
    console.error("work settings: the work service did not answer", error);
    return { ok: false as const, error: "Work didn't answer. Try again in a moment." };
  }
}

const SECTION = "border-t border-line pt-8 first:border-t-0 first:pt-0";

type Draft = Pick<CycleSettings, "enabled" | "lengthDays" | "startsWeekday" | "cooldownDays">;

const draftOf = (settings: CycleSettings): Draft => ({
  enabled: settings.enabled,
  lengthDays: settings.lengthDays,
  startsWeekday: settings.startsWeekday,
  cooldownDays: settings.cooldownDays,
});

export default function WorkSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { slug, canEdit, today } = loaderData;
  const navigation = useNavigation();
  const sending = navigation.state !== "idle" && navigation.formMethod === "POST";
  const spendSending = sending && navigation.formData?.get("intent") === "spend";
  const saving = sending && !spendSending;
  // What the cycles' form sent back; the Spend section's form answers it alone.
  const cyclesData = actionData?.intent === "spend" ? undefined : actionData;
  const spendData = actionData?.intent === "spend" ? actionData : undefined;
  const cycles: Cycles | null = cyclesData?.ok ? cyclesData.cycles : loaderData.cycles;
  const [draft, setDraft] = useState<Draft | null>(cycles ? draftOf(cycles.settings) : null);
  useEffect(() => {
    if (cyclesData?.ok) setDraft(draftOf(cyclesData.cycles.settings));
  }, [cyclesData]);
  const spend = <SpendSection settings={loaderData.spend} saved={spendData} saving={spendSending} />;
  if (!cycles || !draft) {
    return (
      <div className="max-w-2xl">
        <Header />
        <ErrorText>{loaderData.error}</ErrorText>
        <div className="mt-8 border-t border-line pt-8">{spend}</div>
      </div>
    );
  }
  const saved = draftOf(cycles.settings);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((now) => (now ? { ...now, [key]: value } : now));
  const current = cycles.current;
  // What turning them on would open, from the choices as they stand.
  const first = firstCycle(today, draft.startsWeekday, draft.lengthDays);
  return (
    <div className="max-w-2xl">
      <Header />
      {!canEdit && (
        <Card asChild radius="lg" className="mb-8 px-4 py-3 text-sm text-muted">
          <p>Only people who can manage the workspace&apos;s milestones can change these. They are shown so you know how Work runs here.</p>
        </Card>
      )}
      <Form method="post" className="space-y-8">
        <fieldset disabled={!canEdit} className="space-y-8">
          <section className={SECTION}>
            <h2 className="font-medium">Cycles</h2>
            <p className="mt-1.5 text-xs text-faint">
              A cycle is a time box. While cycles are on, the plan&apos;s Now is the current cycle: putting work in Now puts it in the cycle. When a cycle ends,
              whatever is still open in it stays in Now and carries into the next, and the cycle&apos;s report says what was finished, carried and added.
            </p>
            <div className="mt-5">
              {draft.enabled && <input type="hidden" name="enabled" value="on" />}
              <SwitchCard title="Run the workspace in cycles" checked={draft.enabled} onCheckedChange={(on) => set("enabled", on)} disabled={!canEdit}>
                {current ? (
                  <>
                    <Link to={cyclePath(slug)} className="text-fg underline decoration-line-strong underline-offset-2 hover:text-accent">
                      {cycleName(current)}
                    </Link>{" "}
                    runs {cycleDays(current)}: {daysLeftText(current, today).toLowerCase()}.
                    {!draft.enabled && " Turning cycles off closes it now, without carrying anything; the plan works as it did."}
                  </>
                ) : draft.enabled ? (
                  <>Saving opens the first cycle at once, {cycleDays(first)}, with everything in Now in it.</>
                ) : (
                  "Off: Work runs on Now, Next and Later alone."
                )}
              </SwitchCard>
            </div>
          </section>

          <section className={SECTION}>
            <h2 className="font-medium">Length</h2>
            <p className="mt-1.5 text-xs text-faint">A change applies from the next cycle; the current one keeps its days.</p>
            <RadioGroup
              name="length_days"
              value={String(draft.lengthDays)}
              onValueChange={(value) => set("lengthDays", value === "7" ? 7 : 14)}
              className="mt-5"
            >
              <RadioOption value="14" label="Two weeks" description="The default: room for a few pieces of work to land." />
              <RadioOption value="7" label="One week" description="Shorter loops, for a small team or a busy stretch." />
            </RadioGroup>
          </section>

          <section className={SECTION}>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <h2 id="starts-weekday" className="font-medium">
                  Starts on
                </h2>
                <p className="mt-1.5 text-xs text-faint">The day of the week each cycle begins, in UTC.</p>
                <div className="mt-4">
                  <SelectField
                    name="starts_weekday"
                    aria-labelledby="starts-weekday"
                    value={String(draft.startsWeekday)}
                    onValueChange={(value) => set("startsWeekday", Number(value))}
                    disabled={!canEdit}
                    options={[1, 2, 3, 4, 5, 6, 7].map((day) => ({ value: String(day), label: weekdayName(day) }))}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="cooldown-days" className="font-medium">
                  Cooldown
                </label>
                <p className="mt-1.5 text-xs text-faint">Days between one cycle&apos;s end and the next one&apos;s start, 0 to 14.</p>
                <div className="mt-4 flex items-center gap-2">
                  <Input
                    id="cooldown-days"
                    name="cooldown_days"
                    type="number"
                    min={0}
                    max={14}
                    inputMode="numeric"
                    value={draft.cooldownDays}
                    onChange={(event) => set("cooldownDays", Math.max(0, Math.min(14, Number(event.target.value) || 0)))}
                    className="w-24"
                  />
                  <span className="text-sm text-muted">{draft.cooldownDays === 1 ? "day" : "days"}</span>
                </div>
              </div>
            </div>
            {cycles.next && current && (
              <p className="mt-5 flex items-center gap-1.5 text-xs text-muted">
                <Timer size={13} className="shrink-0 text-faint" />
                As saved, {cycleName(cycles.next)} runs {cycleDays(cycles.next)}.
              </p>
            )}
          </section>
        </fieldset>

        {canEdit && (
          <div className="flex items-center gap-3 border-t border-line pt-6">
            <Button type="submit" variant="accent" disabled={saving || !changed}>
              {saving ? "Saving…" : "Save"}
            </Button>
            {cyclesData && !cyclesData.ok && <ErrorText>{cyclesData.error}</ErrorText>}
            {cyclesData?.ok && !changed && (
              <p role="status" className="text-xs text-muted">
                Saved.
              </p>
            )}
          </div>
        )}
      </Form>
      <div className="mt-8 border-t border-line pt-8">{spend}</div>
    </div>
  );
}

/**
 * Spend: who sees each person's spend (routes/workspace/spend.tsx),
 * besides that person. Owners change it; everyone else sees how it is.
 */
function SpendSection({
  settings,
  saved,
  saving,
}: {
  settings: { visibility: SpendVisibility | null; canEdit: boolean };
  saved: { ok: true; visibility: SpendVisibility } | { ok: false; error: string } | undefined;
  saving: boolean;
}) {
  const current = saved?.ok ? saved.visibility : settings.visibility;
  const [choice, setChoice] = useState<SpendVisibility | null>(current);
  useEffect(() => {
    if (saved?.ok) setChoice(saved.visibility);
  }, [saved]);
  return (
    <section>
      <h2 className="font-medium">Spend</h2>
      <p className="mt-1.5 text-xs text-faint">
        What each person&apos;s agent sessions cost is for budgets and plan fit. Everyone always sees their own, and people are listed by name, never ranked by
        what they spent.
      </p>
      {!current || !choice ? (
        <div className="mt-5">
          <ErrorText>Work didn&apos;t answer, so this setting can&apos;t be shown. Try again in a moment.</ErrorText>
        </div>
      ) : (
        <Form method="post" className="mt-5">
          <input type="hidden" name="intent" value="spend" />
          {!settings.canEdit && (
            <Card asChild radius="lg" className="mb-5 px-4 py-3 text-sm text-muted">
              <p>Only the workspace&apos;s owners can change who sees each person&apos;s spend. It is shown so you know who sees yours.</p>
            </Card>
          )}
          <fieldset disabled={!settings.canEdit}>
            <legend id="spend-visibility" className="text-sm font-medium">
              Who sees each person&apos;s spend
            </legend>
            <RadioGroup
              name="visibility"
              aria-labelledby="spend-visibility"
              value={choice}
              onValueChange={(value) => setChoice(value as SpendVisibility)}
              disabled={!settings.canEdit}
              className="mt-3"
            >
              <RadioOption
                value="owners"
                label={SPEND_VISIBILITY.owners.label}
                description="The default: whoever looks after the workspace's budget and plan."
              />
              <RadioOption value="members" label={SPEND_VISIBILITY.members.label} description="Every member sees each person's spend, listed by name." />
              <RadioOption
                value="nobody"
                label={SPEND_VISIBILITY.nobody.label}
                description="Each person sees only their own; a total over everyone shows once it covers 3 people or more."
              />
            </RadioGroup>
          </fieldset>
          {settings.canEdit && (
            <div className="mt-6 flex items-center gap-3">
              <Button type="submit" variant="accent" disabled={saving || choice === current}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {saved && !saved.ok && <ErrorText>{saved.error}</ErrorText>}
              {saved?.ok && choice === current && (
                <p role="status" className="text-xs text-muted">
                  Saved.
                </p>
              )}
            </div>
          )}
        </Form>
      )}
    </section>
  );
}

function Header() {
  return (
    <header className="mb-8 border-b border-line pb-6">
      <h1 className="text-2xl font-semibold tracking-tight">Work</h1>
      <p className="mt-1.5 text-sm text-muted">
        How the workspace plans its work, in cycles or on Now, Next and Later alone, and who sees what each person&apos;s agent sessions cost.
      </p>
    </header>
  );
}
