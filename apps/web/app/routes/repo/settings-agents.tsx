import { env } from "cloudflare:workers";
import { AtSign, Tag } from "lucide-react";
import { Form, useNavigation } from "react-router";

import { AGENT_HANDLE, mentionsClient } from "@g1t/contracts";

import type { Route } from "./+types/settings-agents";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { Button, ErrorText, Field, Input, TimeAgo } from "../../components/ui";
import { work } from "../../lib/services.server";
import { instrumented } from "../../lib/perf.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

const mentions = mentionsClient(instrumented("work", env.WORK));

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Agent settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_settings");
  const path = { namespace: params.owner, name: params.repo };
  const [rules, labels] = await Promise.all([mentions.getAgentRules(path, viewer), work.listLabels(path, viewer)]);
  return { rules: unwrap(rules), labels: labels.ok ? labels.value : [] };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const label = form.get("intent") === "off" ? null : String(form.get("label") ?? "").trim() || null;
  const saved = await mentions.setAgentRules(user, path, { label });
  if (!saved.ok) return { error: saved.error.message, notice: null };
  return {
    error: null,
    notice: saved.value.label
      ? `Issues labelled ${saved.value.label} now go to g1t.`
      : "Labels no longer put g1t to work.",
  };
}

export default function AgentSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { rules, labels } = loaderData;
  const busy = useNavigation().state === "submitting";
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <div className="min-h-6">
        {actionData?.notice && <p className="text-sm text-accent">{actionData.notice}</p>}
        <ErrorText>{actionData?.error ?? null}</ErrorText>
      </div>

      <section className="grid gap-x-10 gap-y-4 lg:grid-cols-[16rem_1fr]">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <Tag size={15} className="text-muted" />
            Label rule
          </h2>
          <p className="mt-1 text-sm text-muted">
            When a member gives an issue this label, g1t takes it, as if they had assigned it. It starts as soon as
            the project has room for another agent and nothing the issue depends on is still open.
          </p>
        </div>
        <Form method="post" className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <Field label="Label" hint="An issue that already has it is not affected; adding it again is.">
            <Input name="label" list="known-labels" defaultValue={rules.label ?? ""} placeholder="agent" maxLength={40} />
          </Field>
          <datalist id="known-labels">
            {labels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" name="intent" value="save" disabled={busy}>
              Save
            </Button>
            {rules.label && (
              <Button type="submit" variant="quiet" name="intent" value="off" disabled={busy}>
                Turn off
              </Button>
            )}
            {rules.updatedBy && rules.updatedAt && (
              <span className="text-xs text-faint">
                Changed by {rules.updatedBy} <TimeAgo at={rules.updatedAt} />
              </span>
            )}
          </div>
        </Form>
      </section>

      <section className="mt-8 grid gap-x-10 gap-y-4 border-t border-line pt-8 lg:grid-cols-[16rem_1fr]">
        <div>
          <h2 className="flex items-center gap-2 font-medium">
            <AtSign size={15} className="text-muted" />
            Mentions
          </h2>
          <p className="mt-1 text-sm text-muted">Always on, for members of the workspace.</p>
        </div>
        <ul className="space-y-2 text-sm text-muted">
          <li>
            <span className="font-mono text-fg">{AGENT_HANDLE} take this</span> on an issue assigns it to g1t. A
            question gets an answer in the thread instead.
          </li>
          <li>
            On a pull request g1t made, a request sends it back to make the change. On any pull request,{" "}
            <span className="font-mono text-fg">{AGENT_HANDLE} review</span> starts a review and a question is answered.
          </li>
          <li>
            Mentions in code, in quotes or from people outside the workspace start nothing. Each comment starts one run at
            most, and g1t replies saying what it did, or why it could not.
          </li>
        </ul>
      </section>
    </div>
  );
}
