/**
 * Writing a security advisory: a new draft, or changes to one in any
 * state. Admin on the repository, or a security manager of its workspace.
 * The same route serves `advisories/new` and `advisories/:id/edit`.
 */
import { Form, data, redirect, useNavigation } from "react-router";

import type { Advisory, AdvisorySeverity } from "@g1t/contracts";

import type { Route } from "./+types/security-advisory-edit";
import { page } from "../../lib/meta";
import { SectionHeader } from "../../components/security-suite";
import { ButtonLink, ErrorText, Field, Input, SubmitButton, Textarea, notACredential } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { SelectField } from "../../components/ui/select";
import { advisories } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { SEVERITIES, SEVERITY_LABEL, advisoryFromForm } from "../../lib/advisories";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params.id ? "Edit advisory" : "New advisory"} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  await requireInsider(context, params, "manage_security");
  const path = { namespace: params.owner, name: params.repo };
  const advisory: Advisory | null = params.id ? unwrap(await advisories.get(path, params.id, viewer)) : null;
  return { advisory };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const refused = await refusal(context, params, "manage_security");
  if (refused) return data({ error: refused }, { status: 403 });
  const input = advisoryFromForm(await request.formData());
  if (typeof input === "string") return data({ error: input }, { status: 400 });
  const path = { namespace: params.owner, name: params.repo };
  const saved = params.id ? await advisories.update(user, path, params.id, input) : await advisories.create(user, path, input);
  if (!saved.ok) return data({ error: saved.error.message }, { status: 400 });
  throw redirect(`/${params.owner}/${params.repo}/security/advisories/${saved.value.g1tsaId}`);
}

export default function SecurityAdvisoryEdit({ loaderData, actionData, params }: Route.ComponentProps) {
  const { advisory } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const navigation = useNavigation();
  const back = advisory ? `${base}/security/advisories/${advisory.g1tsaId}` : `${base}/security/advisories`;
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title={advisory ? `Edit ${advisory.g1tsaId}` : "New security advisory"}
        about={
          advisory
            ? "Changes to a published advisory show at once; a draft stays yours until you publish it."
            : "Say what the vulnerability is, what it affects and what fixes it. It starts as a draft only the maintainers see."
        }
      />
      <Form method="post" className="space-y-4">
        <Card className="space-y-4 p-4">
          <Field label="Title">
            <Input name="title" defaultValue={advisory?.title ?? ""} required maxLength={200} placeholder="Path traversal in the archive reader" {...notACredential()} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity">
              <SelectField
                name="severity"
                defaultValue={advisory?.severity ?? "high"}
                options={SEVERITIES.map((severity: AdvisorySeverity) => ({ value: severity, label: SEVERITY_LABEL[severity] }))}
                aria-label="Severity"
              />
            </Field>
            <Field label="CVE id" hint="When one was issued elsewhere.">
              <Input name="cveId" defaultValue={advisory?.cveId ?? ""} placeholder="CVE-2026-12345" maxLength={32} className="font-mono" {...notACredential()} />
            </Field>
          </div>
          <Field label="Description" hint="Markdown: what it is, how it is exploited, what to do. Needed before publishing.">
            <Textarea name="description" defaultValue={advisory?.description ?? ""} rows={10} maxLength={20_000} />
          </Field>
        </Card>
        <Card className="space-y-4 p-4">
          <p className="text-sm font-medium">What is affected</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ecosystem" hint="npm, crates.io, Go, PyPI, or how the project ships.">
              <Input name="ecosystem" defaultValue={advisory?.ecosystem ?? ""} maxLength={50} {...notACredential()} />
            </Field>
            <Field label="Package">
              <Input name="package" defaultValue={advisory?.package ?? ""} maxLength={200} className="font-mono" {...notACredential()} />
            </Field>
            <Field label="Affected versions">
              <Input name="affectedVersions" defaultValue={advisory?.affectedVersions ?? ""} placeholder=">= 1.2.0, < 1.4.1" maxLength={200} className="font-mono" {...notACredential()} />
            </Field>
            <Field label="Patched versions">
              <Input name="patchedVersions" defaultValue={advisory?.patchedVersions ?? ""} placeholder=">= 1.4.1" maxLength={200} className="font-mono" {...notACredential()} />
            </Field>
          </div>
        </Card>
        <Card className="space-y-4 p-4">
          <p className="text-sm font-medium">Scoring and credits</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="CVSS vector">
              <Input name="cvssVector" defaultValue={advisory?.cvssVector ?? ""} placeholder="CVSS:3.1/AV:N/AC:L/…" maxLength={200} className="font-mono" {...notACredential()} />
            </Field>
            <Field label="CVSS score" hint="0 to 10.">
              <Input name="cvssScore" type="number" step="0.1" min="0" max="10" defaultValue={advisory?.cvssScore ?? ""} className="font-mono" />
            </Field>
          </div>
          <Field label="Credits" hint="Who found or fixed it: usernames or names, one per line or separated by commas.">
            <Textarea name="credits" defaultValue={(advisory?.credits ?? []).join("\n")} rows={2} />
          </Field>
        </Card>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending="Saving…">{advisory ? "Save" : "Create draft"}</SubmitButton>
          <ButtonLink to={back} variant="outline">
            Cancel
          </ButtonLink>
          {navigation.state === "idle" && <ErrorText>{actionData?.error}</ErrorText>}
        </div>
      </Form>
    </div>
  );
}
