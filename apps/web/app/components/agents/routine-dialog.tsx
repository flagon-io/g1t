import { type ReactNode, useId, useState } from "react";

import { type NewRoutine, ROUTINE_EVENTS, type RoutineEvent, type RoutineSchedule } from "@g1t/contracts";

import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { CheckboxOption } from "../ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { SelectField } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useDialogFetcher } from "./dialogs";
import { timeField, weekdayName } from "./format";

/** A conversation a routine can post in. */
export type RoutineChannel = { id: string; label: string };

/** What the dialog starts from: a routine to change, a suggestion to add, or nothing. */
export type RoutineDraft = Partial<Omit<NewRoutine, "schedule">> & { id?: string | null; schedule?: RoutineSchedule | null };

const EVERY = [
  { value: "hour", label: "Every hour" },
  { value: "day", label: "Every day" },
  { value: "weekday", label: "Every weekday" },
  { value: "week", label: "Every week" },
];

const DEFAULT_SCHEDULE: RoutineSchedule = { every: "weekday", hour: 9, minute: 0, weekday: 1 };

/**
 * A routine, made or changed, for owners: its name and instructions, when it
 * runs (a schedule, things that happen, or both), and where it posts.
 * Whoever saves it becomes its sponsor: it runs with their access.
 */
export function RoutineDialog({
  agentName,
  draft,
  channels,
  trigger,
  title,
}: {
  agentName: string;
  draft: RoutineDraft;
  channels: RoutineChannel[];
  trigger: ReactNode;
  title: string;
}) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(`routine-${draft.id ?? draft.name ?? "new"}`);
  const id = useId();
  const [scheduled, setScheduled] = useState(draft.schedule != null || (draft.events ?? []).length === 0);
  const [schedule, setSchedule] = useState<RoutineSchedule>(draft.schedule ?? DEFAULT_SCHEDULE);
  const [events, setEvents] = useState<RoutineEvent[]>(draft.events ?? []);
  const known = draft.channel_id && !channels.some((c) => c.id === draft.channel_id) ? [{ id: draft.channel_id, label: "Its current channel" }, ...channels] : channels;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Each run is a session {agentName} posts in the channel you choose, paid from its budget. It runs with your access, never more: saving makes you its sponsor.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" className="grid gap-5">
          <input type="hidden" name="intent" value="save" />
          {draft.id && <input type="hidden" name="id" value={draft.id} />}
          <input type="hidden" name="enabled" value={draft.enabled === false ? "false" : "true"} />
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} name="name" defaultValue={draft.name ?? ""} maxLength={80} required placeholder="Monday support digest" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-instructions`}>Instructions</FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              name="instructions"
              defaultValue={draft.instructions ?? ""}
              rows={4}
              maxLength={8000}
              required
              placeholder="Read last week's #support threads and post the top themes, with links, and what's still open."
            />
          </Field>

          <Card asChild tone="plain" radius="lg" className="grid gap-4 p-4">
            <fieldset>
              <legend className="px-1 text-sm font-medium">When</legend>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  On a schedule
                  <span className="block text-xs text-faint">In UTC.</span>
                </span>
                <Switch checked={scheduled} onCheckedChange={setScheduled} aria-label="On a schedule" />
              </label>
              {scheduled && (
                <div className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="every" value={schedule.every} />
                  <input type="hidden" name="weekday" value={schedule.weekday} />
                  <div className="w-40">
                    <SelectField
                      value={schedule.every}
                      onValueChange={(every) => setSchedule({ ...schedule, every: every as RoutineSchedule["every"] })}
                      options={EVERY}
                      size="sm"
                      aria-label="How often"
                    />
                  </div>
                  {schedule.every === "week" && (
                    <div className="w-36">
                      <SelectField
                        value={String(schedule.weekday)}
                        onValueChange={(day) => setSchedule({ ...schedule, weekday: Number(day) })}
                        options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: `on ${weekdayName(d)}` }))}
                        size="sm"
                        aria-label="Day of the week"
                      />
                    </div>
                  )}
                  {schedule.every === "hour" ? (
                    <label className="flex items-center gap-2 text-sm text-muted">
                      at minute
                      <Input
                        name="minute"
                        type="number"
                        min={0}
                        max={59}
                        value={schedule.minute}
                        onChange={(e) => setSchedule({ ...schedule, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                        className="h-8 w-20"
                      />
                    </label>
                  ) : (
                    <label className="flex items-center gap-2 text-sm text-muted">
                      at
                      <Input
                        name="time"
                        type="time"
                        value={timeField(schedule)}
                        onChange={(e) => {
                          const [h, m] = e.target.value.split(":").map(Number);
                          setSchedule({ ...schedule, hour: h || 0, minute: m || 0 });
                        }}
                        className="h-8 w-28"
                      />
                      UTC
                    </label>
                  )}
                </div>
              )}
              <div className="border-t border-line pt-4">
                <p className="text-sm">When something happens</p>
                <p className="text-xs text-faint">Each run is about the one thing that happened, in a repository you can read.</p>
                <div className="mt-3 grid gap-2.5">
                  {ROUTINE_EVENTS.map((event) => (
                    <CheckboxOption
                      key={event.key}
                      name="events"
                      value={event.key}
                      checked={events.includes(event.key)}
                      onCheckedChange={(on) => setEvents(on ? [...events, event.key] : events.filter((e) => e !== event.key))}
                      label={event.label}
                      description={event.hint}
                    />
                  ))}
                </div>
                {events.length > 0 && (
                  <Field className="mt-4">
                    <FieldLabel htmlFor={`${id}-repos`}>Repositories</FieldLabel>
                    <Input id={`${id}-repos`} name="repos" defaultValue={(draft.repos ?? []).join(", ")} placeholder="acme/web, acme/api" autoComplete="off" />
                    <FieldDescription>Empty: every repository you can read.</FieldDescription>
                  </Field>
                )}
              </div>
              {!scheduled && events.length === 0 && <p className="text-xs text-warn">Choose a schedule, something that happens, or both.</p>}
            </fieldset>
          </Card>
          {scheduled ? null : <input type="hidden" name="every" value="none" />}

          <Field>
            <FieldLabel htmlFor={`${id}-channel`}>Posts in</FieldLabel>
            {known.length > 0 ? (
              <SelectField
                id={`${id}-channel`}
                name="channel"
                defaultValue={draft.channel_id ?? undefined}
                options={known.map((c) => ({ value: c.id, label: c.label }))}
                placeholder="Choose a conversation"
                required
              />
            ) : (
              <p className="text-sm text-muted">You&apos;re in no channel yet. Join one in Chat, with {agentName} in it, first.</p>
            )}
            <FieldDescription>A channel you and {agentName} are both in.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy || (!scheduled && events.length === 0)}>
              {busy ? "Saving…" : draft.id ? "Save routine" : "Add routine"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
