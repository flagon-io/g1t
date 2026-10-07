/**
 * Settings → Notifications: what you are also emailed for, how you watch
 * repositories you create, and the repositories you watch other than the
 * default way. The events service keeps all three (`inbox_settings`,
 * `inbox_watched`); the inbox itself is at /inbox.
 */
import { Eye, EyeOff } from "lucide-react";
import { Form, Link, data, useNavigation } from "react-router";

import type { WatchLevel } from "@g1t/contracts";

import type { Route } from "./+types/notifications";
import { ErrorText, SubmitButton } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { EMAIL_REASONS, WATCH_CHOICES, WATCH_EVENT_LABEL, emailReasonsFromForm } from "../../lib/inbox";
import { page } from "../../lib/meta";
import { inbox } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Notifications · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const [settings, watched] = await Promise.all([
    inbox.settings(user.username).catch(() => null),
    inbox.watched(user.username).catch(() => null),
  ]);
  return { settings, watched };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // One shape for every answer: what was said, beside the form that asked.
  const answer = (saved: string | null, error: string | null = null) => ({ intent, saved, error });
  try {
    switch (intent) {
      case "email":
        await inbox.updateSettings(user.username, { email: emailReasonsFromForm(form) });
        return answer("Saved. You'll be emailed for what is checked.");
      case "default_watch": {
        const level = String(form.get("default_watch") ?? "");
        if (level !== "participating" && level !== "all") return data(answer(null, "Choose one."), { status: 400 });
        await inbox.updateSettings(user.username, { defaultWatch: level });
        return answer("Saved. It applies to repositories you create from now on.");
      }
      case "unwatch": {
        const repoId = String(form.get("repo_id") ?? "");
        if (!repoId) return data(answer(null, "Nothing to do."), { status: 400 });
        await inbox.watch(user.username, repoId, String(form.get("repo") ?? ""), null);
        return answer(null);
      }
      default:
        return data(answer(null, "Nothing to do."), { status: 400 });
    }
  } catch {
    return data(answer(null, "That did not save. Try again in a moment."), { status: 503 });
  }
}

const LEVEL_LABEL: Record<WatchLevel, string> = Object.fromEntries(WATCH_CHOICES.map((choice) => [choice.level, choice.label])) as Record<
  WatchLevel,
  string
>;

export default function NotificationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, watched } = loaderData;
  const navigation = useNavigation();
  const said = (intent: string) => (actionData?.intent === intent && navigation.state === "idle" ? actionData : null);
  if (!settings) {
    return <p className="rounded-lg border border-line px-4 py-6 text-sm text-muted">Your notification settings could not be loaded. Try again in a moment.</p>;
  }
  return (
    <div className="space-y-10">
      <section aria-labelledby="email-heading">
        <h2 id="email-heading" className="text-sm font-semibold">
          Email
        </h2>
        <p className="mt-1 text-sm text-muted">
          Besides your <Link to="/inbox" className="text-fg underline underline-offset-4">inbox</Link>, email me at my primary address when:
        </p>
        <Form method="post" className="mt-4 space-y-3">
          <input type="hidden" name="intent" value="email" />
          {EMAIL_REASONS.map((entry) => (
            <CheckboxOption
              key={entry.reason}
              name="email"
              value={entry.reason}
              defaultChecked={settings.email.includes(entry.reason)}
              label={entry.label}
              description={entry.detail}
            />
          ))}
          <div className="flex items-center gap-3 pt-2">
            <SubmitButton variant="quiet" match={{ intent: "email" }} pending="Saving…">
              Save email settings
            </SubmitButton>
            {said("email")?.saved && <p className="text-xs text-accent">{said("email")?.saved}</p>}
          </div>
          <ErrorText>{said("email")?.error}</ErrorText>
        </Form>
        <p className="mt-3 text-xs text-faint">Email goes only to a confirmed address, and only about repositories you can still read.</p>
      </section>

      <section aria-labelledby="watching-heading">
        <h2 id="watching-heading" className="text-sm font-semibold">
          Repositories you create
        </h2>
        <p className="mt-1 text-sm text-muted">How you watch a repository when you make it. Change any one from its Watch menu.</p>
        <Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="default_watch" />
          <RadioGroup name="default_watch" defaultValue={settings.defaultWatch === "participating" ? "participating" : "all"}>
            {WATCH_CHOICES.filter((choice) => choice.level === "all" || choice.level === "participating").map((choice) => (
              <RadioOption key={choice.level} value={choice.level} label={choice.label} description={choice.detail} />
            ))}
          </RadioGroup>
          <div className="mt-4 flex items-center gap-3">
            <SubmitButton variant="quiet" match={{ intent: "default_watch" }} pending="Saving…">
              Save
            </SubmitButton>
            {said("default_watch")?.saved && <p className="text-xs text-accent">{said("default_watch")?.saved}</p>}
          </div>
          <ErrorText>{said("default_watch")?.error}</ErrorText>
        </Form>
      </section>

      <section aria-labelledby="watched-heading">
        <h2 id="watched-heading" className="text-sm font-semibold">
          Repositories you watch
        </h2>
        <p className="mt-1 text-sm text-muted">Those you watch other than the default way, which is only what you take part in.</p>
        {watched == null ? (
          <p className="mt-4 text-sm text-muted">This list could not be loaded. Try again in a moment.</p>
        ) : watched.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            You watch every repository the default way.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-line rounded-md border border-line">
            {watched.map((watching) => (
              <li key={watching.repoId} className="flex items-center gap-3 px-4 py-3">
                {watching.level === "ignore" ? (
                  <EyeOff size={15} className="shrink-0 text-faint" aria-hidden="true" />
                ) : (
                  <Eye size={15} className="shrink-0 text-faint" aria-hidden="true" />
                )}
                <div className="min-w-0 grow">
                  {watching.repo ? (
                    <Link to={`/${watching.repo}`} className="block truncate font-mono text-sm hover:underline">
                      {watching.repo}
                    </Link>
                  ) : (
                    <span className="block truncate font-mono text-sm text-muted">{watching.repoId}</span>
                  )}
                  <p className="truncate text-xs text-muted">
                    {LEVEL_LABEL[watching.level]}
                    {watching.level === "custom" && watching.events.length > 0 && `: ${watching.events.map((kind) => WATCH_EVENT_LABEL[kind]).join(", ")}`}
                  </p>
                </div>
                <Form method="post" className="shrink-0">
                  <input type="hidden" name="intent" value="unwatch" />
                  <input type="hidden" name="repo_id" value={watching.repoId} />
                  <input type="hidden" name="repo" value={watching.repo ?? ""} />
                  <SubmitButton
                    variant="quiet"
                    match={{ intent: "unwatch", repo_id: watching.repoId }}
                    pending="…"
                    className="rounded-md border border-line px-2.5 py-1 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-60"
                  >
                    {watching.level === "ignore" ? "Stop ignoring" : "Stop watching"}
                  </SubmitButton>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
