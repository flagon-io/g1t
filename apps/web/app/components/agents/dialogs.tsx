import { type ReactNode, useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";

import type { AgentPolicy, AgentSession } from "@g1t/contracts";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field";
import { Input, InputAddon, InputGroup } from "../ui/input";
import { dollarsField } from "../../lib/agent-form";
import { money } from "../../lib/usage";
import { PrivateTitle, SpendOfCap } from "./parts";

/** What Agents mode's actions answer. */
export type ActionResult = { ok: true; intent?: string } | { ok: false; error: string; field?: string; intent?: string };

/** A fetcher whose dialog closes once what it sent has worked. */
export function useDialogFetcher(key?: string) {
  const fetcher = useFetcher<ActionResult>(key ? { key } : undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  const error = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? fetcher.data.error : null;
  return { fetcher, open, setOpen, error, busy: fetcher.state !== "idle" };
}


/** A dollars field: `$` before it, posted as dollars. */
export function DollarsInput({ id, name, defaultValue, placeholder, required }: { id: string; name: string; defaultValue: string; placeholder?: string; required?: boolean }) {
  return (
    <InputGroup>
      <InputAddon>$</InputAddon>
      <Input id={id} name={name} inputMode="decimal" defaultValue={defaultValue} placeholder={placeholder} required={required} autoComplete="off" />
    </InputGroup>
  );
}

/**
 * The workspace's agent budget, for owners: one monthly budget across every
 * agent, the budget a new agent starts with, and the cap a session starts with.
 */
export function BudgetDialog({ policy, action, trigger }: { policy: AgentPolicy; action: string; trigger: ReactNode }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher("agents-budget");
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent budget</DialogTitle>
          <DialogDescription>
            What every agent may spend together each month, and what new agents and sessions start with. The workspace&apos;s spend limit still sits above all of it.
          </DialogDescription>
        </DialogHeader>
        <fetcher.Form method="post" action={action} className="grid gap-5">
          <input type="hidden" name="intent" value="policy" />
          <Field>
            <FieldLabel htmlFor={`${id}-monthly`}>Monthly budget for all agents</FieldLabel>
            <DollarsInput id={`${id}-monthly`} name="monthly" defaultValue={dollarsField(policy.monthly_micros)} placeholder="No budget of its own" />
            <FieldDescription>Every agent&apos;s replies and sessions together, reset on the 1st (UTC). The Agents page warns at 75% and 90%; at 100% agents take no new work. Empty: only the workspace&apos;s spend limit.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-agent`}>Monthly budget for a new agent</FieldLabel>
            <DollarsInput id={`${id}-agent`} name="default_agent" defaultValue={dollarsField(policy.default_agent_monthly_micros)} placeholder="None" />
            <FieldDescription>Filled in when an agent is hired; change each one on its profile.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-session`}>Cap for a session</FieldLabel>
            <DollarsInput id={`${id}-session`} name="default_session" defaultValue={dollarsField(policy.default_session_micros)} required />
            <FieldDescription>A session stops here and asks an owner before spending more, unless its agent&apos;s per-task cap is lower.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Saving…" : "Save budget"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/** A suggested new cap: double the old one, and always above what it has spent. */
export function suggestedCap(session: Pick<AgentSession, "charged_micros" | "cap_micros">): number {
  const base = Math.max(session.cap_micros ?? 0, session.charged_micros);
  const doubled = Math.max(base * 2, session.charged_micros + 1_000_000);
  return Math.ceil(doubled / 10_000) * 10_000;
}

/** Owners let a session that stopped at its cap go on, with a new cap. */
export function ApproveDialog({ slug, session, trigger }: { slug: string; session: AgentSession; trigger: ReactNode }) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(`approve-${session.id}`);
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve more spend</DialogTitle>
          <DialogDescription>
            {session.visible ? <>&ldquo;{session.title}&rdquo;</> : <PrivateTitle />} stopped at its cap. A new cap lets it go on; it stops again there.
          </DialogDescription>
        </DialogHeader>
        <Card asChild tone="plain" radius="lg" className="bg-bg/50 px-3 py-2 text-sm text-muted">
          <p>
            {session.agent_name} has spent <SpendOfCap spent={session.charged_micros} cap={session.cap_micros} /> on it so far.
          </p>
        </Card>
        <fetcher.Form method="post" action={`/${slug}/-/agents/${session.agent_handle}/sessions/${session.id}`} className="grid gap-5">
          <input type="hidden" name="intent" value="approve" />
          <Field>
            <FieldLabel htmlFor={`${id}-cap`}>New cap</FieldLabel>
            <DollarsInput id={`${id}-cap`} name="cap" defaultValue={dollarsField(suggestedCap(session))} required />
            <FieldDescription>More than the {money(session.charged_micros)} it has spent. Charged to {session.agent_name}&apos;s budget.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" disabled={busy}>
              {busy ? "Approving…" : "Approve and go on"}
            </Button>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A choice that is asked twice: the trigger opens a question, and only its
 * confirm button posts `fields` to `action`.
 */
export function Confirm({
  trigger,
  title,
  children,
  confirm,
  action,
  fields,
  fetcherKey,
}: {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  confirm: string;
  action?: string;
  fields: Record<string, string>;
  fetcherKey?: string;
}) {
  const { fetcher, open, setOpen, error, busy } = useDialogFetcher(fetcherKey);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-sm text-danger">{error}</p>}
        <fetcher.Form method="post" action={action}>
          {Object.entries(fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button
              type="submit"
              disabled={busy} className="bg-danger hover:bg-danger/90">
              {busy ? "Working…" : confirm}
            </Button>
          </AlertDialogFooter>
        </fetcher.Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

