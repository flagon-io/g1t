import { KeyRound, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, useFetcher, useSubmit } from "react-router";

import { RETENTION_CHOICES, TELEMETRY_OTLP_ENDPOINT, type TelemetryExport } from "@g1t/contracts/telemetry";

import type { Route } from "./+types/observability-settings";
import { ObservabilityHeader } from "../../components/observability";
import { CopyLine, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { SelectField } from "../../components/ui/select";
import { SwitchCard } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { page } from "../../lib/meta";
import { bytes, count, otelEnv } from "../../lib/observability";
import { observed, soft } from "../../lib/observability.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Observability settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const { projectId, service, project } = await observed(context, params, request, "manage_integrations");
  // The workspace goes along, so the project's store knows whose free cap applies.
  const ref = { project_id: projectId, workspace: (params.owner ?? "").toLowerCase() };
  const [settings, tokens, exports, usage] = await Promise.all([
    soft(service.settings(ref), "settings"),
    soft(service.tokens(ref), "tokens"),
    soft(service.exports(ref), "exports"),
    soft(service.usage(ref), "usage"),
  ]);
  return { settings, tokens, exports, usage, slug: project.slug };
}

/** `Name: value` lines, as an export's headers are written in its form. */
function headersOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    if (/^[a-z0-9-]{1,64}$/.test(name)) out[name] = line.slice(at + 1).trim();
  }
  return out;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const { projectId, service } = await observed(context, params, request, "manage_integrations");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const ref = { project_id: projectId, workspace: (params.owner ?? "").toLowerCase() };
  try {
    switch (intent) {
      case "retention":
        await service.setSettings({ ...ref, retention_days: Number(form.get("retention_days")) });
        return { notice: "Retention saved. What is past it goes within the hour." };
      case "deployments":
        await service.setSettings({ ...ref, deployments: form.get("deployments") === "on" });
        return { notice: form.get("deployments") === "on" ? "Apps on g1t.page report here." : "Apps on g1t.page no longer report here." };
      case "create-token": {
        const made = await service.createToken({ ...ref, name: String(form.get("name") ?? ""), created_by: user.id });
        return { secret: made.secret, name: made.token.name };
      }
      case "revoke-token":
        await service.revokeToken({ ...ref, id: String(form.get("id")) });
        return { notice: "Token revoked. Anything sending with it is refused from now on." };
      case "put-export": {
        const signals = form.getAll("signal").map(String) as TelemetryExport["signals"];
        const headers = headersOf(String(form.get("headers") ?? ""));
        await service.putExport({
          ...ref,
          id: form.get("id") ? String(form.get("id")) : null,
          name: String(form.get("name") ?? ""),
          endpoint: String(form.get("endpoint") ?? ""),
          signals,
          headers,
          enabled: form.get("enabled") === "on",
        });
        return { notice: "Export saved. Telemetry is sent there as it arrives." };
      }
      case "delete-export":
        await service.deleteExport({ ...ref, id: String(form.get("id")) });
        return { notice: "Export removed." };
    }
  } catch (error) {
    return { error: String(error).replace(/^Error: (telemetry \w+ failed with status \d+: )?/, "") };
  }
  return { error: "Unknown request." };
}

export default function ObservabilitySettings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, tokens, exports, usage, slug } = loaderData;
  const submit = useSubmit();

  return (
    <div className="max-w-4xl">
      <ObservabilityHeader title="Observability settings" about="Where the project's telemetry comes from, how long it is kept, and where else it goes." />
      <div className="mt-4 min-h-5">
        {actionData && "notice" in actionData && <p className="text-sm text-success">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      <section className="mt-4" aria-labelledby="send-title">
        <h2 id="send-title" className="text-sm font-semibold">
          Sending here
        </h2>
        <p className="mt-1 text-sm text-muted">
          Any OpenTelemetry SDK or collector sends traces, logs and metrics over OTLP/HTTP (JSON or protobuf) to this endpoint, with an ingest
          token below. Most SDKs read these variables:
        </p>
        <div className="mt-3 space-y-2">
          <CopyLine text={TELEMETRY_OTLP_ENDPOINT} />
          <pre className="overflow-x-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs">{otelEnv(TELEMETRY_OTLP_ENDPOINT, slug, "g1to_…")}</pre>
        </div>
        {settings && (
          <Form method="post" className="mt-4">
            <SwitchCard
              title="Apps on g1t.page report here"
              defaultChecked={settings.deployments}
              onCheckedChange={(on) => submit({ intent: "deployments", deployments: on ? "on" : "" }, { method: "post", preventScrollReset: true })}
            >
              Each request the project's apps answer, with their logs and exceptions, arrives on its own; their OpenTelemetry SDKs are given the
              endpoint and the project's deployments token. Off keeps what is here and stops what is new.
            </SwitchCard>
          </Form>
        )}
      </section>

      <section className="mt-10" aria-labelledby="tokens-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="tokens-title" className="text-sm font-semibold">
            Ingest tokens
          </h2>
          <NewToken />
        </div>
        <p className="mt-1 text-sm text-muted">
          For software running anywhere other than g1t.page: a token lets it send to this project and do nothing else. Each is shown once, when
          it is made. Apps on g1t.page need none; g1t gives them their own.
        </p>
        {!tokens ? (
          <Card className="mt-3 p-4 text-sm text-muted">Tokens could not be loaded just now.</Card>
        ) : tokens.length === 0 ? (
          <Card className="mt-3 p-4 text-sm text-muted">None yet.</Card>
        ) : (
          <Card className="mt-3 divide-y divide-line">
            {tokens.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <KeyRound size={14} className="text-faint" />
                    {t.name}
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    <span className="font-mono">{t.hint}</span> · made <TimeAgo at={t.created_us / 1000} /> ·{" "}
                    {t.last_used_us ? (
                      <>
                        used <TimeAgo at={t.last_used_us / 1000} />
                      </>
                    ) : (
                      "never used"
                    )}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" aria-label={`Revoke ${t.name}`}>
                      <Trash2 size={14} />
                      Revoke
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <Form method="post" className="grid gap-4">
                      <input type="hidden" name="intent" value="revoke-token" />
                      <input type="hidden" name="id" value={t.id} />
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke {t.name}?</AlertDialogTitle>
                        <AlertDialogDescription>Anything sending with it is refused at once. What it already sent stays.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction asChild>
                          <button type="submit">Revoke token</button>
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </Form>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mt-10" aria-labelledby="exports-title">
        <div className="flex items-center justify-between gap-3">
          <h2 id="exports-title" className="text-sm font-semibold">
            Exports
          </h2>
          <ExportDialog />
        </div>
        <p className="mt-1 text-sm text-muted">
          Send everything that arrives on to any OTLP/HTTP endpoint as well: a collector of your own, or any tool that takes OpenTelemetry.
          Requests on g1t.page go as server spans, their logs as log records.
        </p>
        {exports && exports.length > 0 && (
          <Card className="mt-3 divide-y divide-line">
            {exports.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Send size={14} className="text-faint" />
                    {e.name}
                    {!e.enabled && <Badge tone="neutral">Off</Badge>}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted">{e.endpoint}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    {e.signals.join(", ")}
                    {e.header_names.length > 0 && ` · headers: ${e.header_names.join(", ")}`}
                    {e.last_sent_us && (
                      <>
                        {" "}
                        · last sent <TimeAgo at={e.last_sent_us / 1000} />
                      </>
                    )}
                  </p>
                  {e.last_error && <p className="mt-1 text-xs text-danger">{e.last_error}</p>}
                </div>
                <div className="flex gap-2">
                  <ExportDialog existing={e} />
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" aria-label={`Remove ${e.name}`}>
                        <Trash2 size={14} />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <Form method="post" className="grid gap-4">
                        <input type="hidden" name="intent" value="delete-export" />
                        <input type="hidden" name="id" value={e.id} />
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove {e.name}?</AlertDialogTitle>
                          <AlertDialogDescription>Nothing more is sent there. What was sent stays there.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction asChild>
                            <button type="submit">Remove export</button>
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </Form>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      {settings && (
        <section className="mt-10" aria-labelledby="retention-title">
          <h2 id="retention-title" className="text-sm font-semibold">
            Retention
          </h2>
          <p className="mt-1 text-sm text-muted">
            How long requests, logs, spans and metric points are kept. The Overview's per-minute numbers are kept for 90 days whatever this is.
          </p>
          <Form method="post" className="mt-3 flex items-center gap-2">
            <input type="hidden" name="intent" value="retention" />
            <SelectField
              name="retention_days"
              aria-label="Retention"
              className="w-36"
              defaultValue={String(settings.retention_days)}
              options={RETENTION_CHOICES.map((d) => ({ value: String(d), label: `${d} day${d === 1 ? "" : "s"}` }))}
            />
            <SubmitButton variant="outline" match={{ intent: "retention" }}>
              Save
            </SubmitButton>
          </Form>
        </section>
      )}

      {usage && (
        <section className="mt-10" aria-labelledby="usage-title">
          <h2 id="usage-title" className="text-sm font-semibold">
            This month
          </h2>
          <Card className="mt-3 grid grid-cols-2 gap-4 p-4 sm:grid-cols-3">
            {(
              [
                ["Received", bytes(usage.ingested_bytes)],
                ["Received today", bytes(usage.today_bytes ?? 0)],
                ["Requests", count(usage.requests)],
                ["Log lines", count(usage.logs)],
                ["Spans", count(usage.spans)],
                ["Metric points", count(usage.metric_points)],
                ["Kept now", bytes(usage.stored_bytes)],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <p className="text-xs text-muted">{label}</p>
                <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}

/** A new token, made in a dialog that then shows it, once. */
function NewToken() {
  const [open, setOpen] = useState(false);
  // Each opening is a fresh form: a token shown once is not shown again.
  const [round, setRound] = useState(0);
  const fetcher = useFetcher<typeof action>({ key: `new-token-${round}` });
  const made = fetcher.data && "secret" in fetcher.data && typeof fetcher.data.secret === "string" ? { name: String(fetcher.data.name ?? ""), secret: fetcher.data.secret } : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setRound((n) => n + 1);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          New token
        </Button>
      </DialogTrigger>
      <DialogContent>
        {made ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>{made.name}</DialogTitle>
              <DialogDescription>Copy it now: it is not shown again. Send it as <code>authorization: Bearer …</code>.</DialogDescription>
            </DialogHeader>
            <CopyLine text={made.secret} />
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <fetcher.Form method="post" className="grid gap-4">
            <input type="hidden" name="intent" value="create-token" />
            <DialogHeader>
              <DialogTitle>New ingest token</DialogTitle>
              <DialogDescription>For one piece of software, so it can be revoked on its own.</DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="token-name">Name</FieldLabel>
              <Input id="token-name" name="name" required maxLength={80} placeholder="api on fly.io" autoComplete="off" />
            </Field>
            {fetcher.data && "error" in fetcher.data && <ErrorText>{fetcher.data.error}</ErrorText>}
            <DialogFooter>
              <SubmitButton fetcher={fetcher}>Make token</SubmitButton>
            </DialogFooter>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({ existing }: { existing?: TelemetryExport }) {
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "notice" in fetcher.data) setOpen(false);
  }, [fetcher.state, fetcher.data]);
  const signals: TelemetryExport["signals"] = existing?.signals ?? ["traces", "logs", "metrics"];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {existing ? (
          <Button variant="outline" size="sm">
            Edit
          </Button>
        ) : (
          <Button variant="outline" size="sm">
            <Plus size={14} />
            New export
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <fetcher.Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="put-export" />
          {existing && <input type="hidden" name="id" value={existing.id} />}
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "New export"}</DialogTitle>
            <DialogDescription>An OTLP/HTTP endpoint: g1t adds /v1/traces, /v1/logs and /v1/metrics to it.</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="export-name">Name</FieldLabel>
            <Input id="export-name" name="name" required maxLength={80} defaultValue={existing?.name} placeholder="Our collector" />
          </Field>
          <Field>
            <FieldLabel htmlFor="export-endpoint">Endpoint</FieldLabel>
            <Input id="export-endpoint" name="endpoint" required type="url" defaultValue={existing?.endpoint} placeholder="https://otel.example.com" className="font-mono" />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Send</legend>
            {(["traces", "logs", "metrics"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm capitalize">
                <Checkbox name="signal" value={s} defaultChecked={signals.includes(s)} />
                {s}
              </label>
            ))}
          </fieldset>
          <Field>
            <FieldLabel htmlFor="export-headers">Headers</FieldLabel>
            <Textarea id="export-headers" name="headers" rows={3} className="font-mono text-xs" placeholder={"authorization: Bearer …\nx-api-key: …"} />
            <FieldDescription>
              One <code>name: value</code> a line, kept as secrets and never shown again.
              {existing?.header_names.length ? ` Kept now: ${existing.header_names.join(", ")}. Give one again to change it, or with nothing after the colon to remove it.` : ""}
            </FieldDescription>
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="enabled" defaultChecked={existing?.enabled ?? true} />
            Sending
          </label>
          {fetcher.data && "error" in fetcher.data && <ErrorText>{fetcher.data.error}</ErrorText>}
          <DialogFooter>
            <SubmitButton fetcher={fetcher}>{existing ? "Save" : "Add export"}</SubmitButton>
          </DialogFooter>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}
