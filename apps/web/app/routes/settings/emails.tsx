import type { Route } from "./+types/emails";
import { page } from "../../lib/meta";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { EmailsSection } from "../../components/emails-section";
import { EMAIL_INTENTS, emailAction, loadEmails } from "../../lib/emails.server";
import { githubSignIn } from "../../lib/github.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Emails · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [emails, github] = await Promise.all([loadEmails(user), githubSignIn.account(user).catch(() => null)]);
  // Whether a sensitive change can be confirmed with a password.
  return { emails: emails.emails, hasPassword: github?.hasPassword ?? true };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  // Sensitive changes may first ask for the password (lib/emails.server.ts).
  if ((EMAIL_INTENTS as readonly string[]).includes(String(form.get("intent")))) {
    // Which form posted, so its answer shows beside it.
    return { emailAction: await emailAction(user, form, request), emailIntent: String(form.get("intent")) };
  }
  return null;
}

export default function EmailSettings({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <EmailsSection
      data={loaderData.emails}
      actionData={actionData?.emailAction}
      intent={actionData?.emailIntent}
      hasPassword={loaderData.hasPassword}
    />
  );
}
