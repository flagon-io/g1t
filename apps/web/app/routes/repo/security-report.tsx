/**
 * "Report a vulnerability": tells a repository's maintainers privately,
 * when the repository takes such reports. Anyone who can see the
 * repository may; on a public one someone signed out may too, with an
 * email address the maintainers can answer at. The front door limits how
 * fast one address can post here (lib/front-door-limits.ts), and the
 * service takes five reports a day from one reporter.
 */
import { Form, Link, data, useNavigation } from "react-router";

import type { AdvisorySeverity } from "@g1t/contracts";

import type { Route } from "./+types/security-report";
import { page } from "../../lib/meta";
import { SectionHeader } from "../../components/security-suite";
import { ButtonLink, ErrorText, Field, Input, SubmitButton, Textarea, notACredential } from "../../components/ui";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Card } from "../../components/ui/card";
import { SelectField } from "../../components/ui/select";
import { advisories } from "../../lib/services.server";
import { assertSameOrigin, getViewer } from "../../lib/session.server";
import { requireRepo } from "../../lib/access.server";
import { SEVERITIES, SEVERITY_LABEL, reportFromForm } from "../../lib/advisories";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Report a vulnerability · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  await requireRepo(context, params, "read");
  const settings = await advisories.reportSettings({ namespace: params.owner, name: params.repo }, viewer);
  return { reporting: settings.ok && settings.value.privateVulnerabilityReporting, signedIn: Boolean(viewer), username: viewer?.username ?? null };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const viewer = getViewer(context);
  await requireRepo(context, params, "read");
  const draft = reportFromForm(await request.formData(), Boolean(viewer));
  if (typeof draft === "string") return data({ error: draft, sent: null }, { status: 400 });
  const sent = await advisories.report(viewer, { namespace: params.owner, name: params.repo }, draft);
  if (!sent.ok) return data({ error: sent.error.message, sent: null }, { status: sent.error.code === "limit" ? 429 : 400 });
  return { error: null, sent: sent.value.id };
}

export default function SecurityReport({ loaderData, actionData, params }: Route.ComponentProps) {
  const { reporting, signedIn, username } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const navigation = useNavigation();
  if (actionData?.sent) {
    return (
      <div className="max-w-3xl space-y-6">
        <SectionHeader
          title="Thank you"
          about="Your report reached the maintainers, and only them. They will look into it and answer you when there is news."
        />
        <ButtonLink to={`${base}/security`} variant="outline">
          Back to Security
        </ButtonLink>
      </div>
    );
  }
  if (!reporting) {
    return (
      <div className="max-w-3xl space-y-6">
        <SectionHeader title="Report a vulnerability" about="This repository does not take private vulnerability reports here." />
        <Alert tone="info">
          <AlertTitle>Reach the maintainers another way</AlertTitle>
          <AlertDescription>
            Its{" "}
            <Link to={`${base}/security`} className="underline underline-offset-2">
              Security page
            </Link>{" "}
            shows its security policy, if it has one, which says how to report. Please do not open a public work item about a vulnerability.
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title="Report a vulnerability"
        about={`Tell the maintainers of ${params.owner}/${params.repo} privately. Only they see what you write here; nothing is published until they publish an advisory.`}
      />
      <Form method="post" className="space-y-4">
        <Card className="space-y-4 p-4">
          <Field label="Title" hint="One line: what you found.">
            <Input name="title" required maxLength={200} placeholder="Path traversal in the archive reader" {...notACredential()} />
          </Field>
          <Field label="Description" hint="What is affected, how to reproduce it, and what you think it allows. Markdown is fine.">
            <Textarea name="description" required rows={10} maxLength={20_000} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity" hint="How bad you think it is, if you have a view.">
              <SelectField
                name="severity"
                defaultValue="medium"
                options={SEVERITIES.map((severity: AdvisorySeverity) => ({ value: severity, label: SEVERITY_LABEL[severity] }))}
                aria-label="Severity"
              />
            </Field>
            {signedIn ? (
              <Field label="Reported as" hint="The maintainers answer you on g1t.">
                <Input value={username ?? ""} readOnly className="font-mono" />
              </Field>
            ) : (
              <Field label="Your email" hint="Where the maintainers can answer you. Never published.">
                <Input name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" />
              </Field>
            )}
          </div>
        </Card>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending="Sending…">Send report</SubmitButton>
          <ButtonLink to={`${base}/security`} variant="outline">
            Cancel
          </ButtonLink>
          {navigation.state === "idle" && <ErrorText>{actionData?.error}</ErrorText>}
        </div>
        {!signedIn && (
          <p className="text-xs text-faint">
            Have an account?{" "}
            <Link to={`/login?next=${encodeURIComponent(`${base}/security/report`)}`} className="underline underline-offset-2 hover:text-fg">
              Sign in
            </Link>{" "}
            to report under your name.
          </p>
        )}
      </Form>
    </div>
  );
}
