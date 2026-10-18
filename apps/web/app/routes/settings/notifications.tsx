/**
 * Settings → Notifications: what you hear when chat moves and Do not
 * disturb (identity keeps the sounds, notify your presence), what pops up
 * and is pushed (notify), what you are also emailed for, how you watch
 * repositories you create, and the repositories you watch other than the
 * default way. The events service keeps those three (`inbox_settings`,
 * `inbox_watched`); the notifications themselves are at /notifications.
 */
import { Eye, EyeOff } from "lucide-react";
import { Form, Link, data, useNavigation } from "react-router";

import type { DigestCadence, WatchLevel } from "@g1t/contracts";

import type { Route } from "./+types/notifications";
import { ErrorText, SubmitButton } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { SwitchCard } from "../../components/ui/switch";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { EMAIL_REASONS, SECURITY_DIGEST_CHOICES, WATCH_CHOICES, WATCH_EVENT_LABEL, emailReasonsFromForm, securityDigestFromForm } from "../../lib/inbox";
import { page } from "../../lib/meta";
import { identity, inbox } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";
// Live notifications: pop-ups and browser notifications (services/notify).
import { LiveNotificationSettings } from "../../components/notifications/settings";
// Sounds, Do not disturb and desktop notifications (identity, notify).
import { SoundSettingsSection } from "../../components/notifications/sounds";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Notifications · Settings · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  // Each section stands on its own read: one that could not be read says so
  // in its place, and its form is not offered over values not known. The
  // sounds save one change at a time, so without them the section starts
  // from what the page already has (the root's read) and loses nothing.
  const [settings, watched, sounds] = await Promise.all([
    part(inbox.settings(user.username), "Notification settings"),
    part(inbox.watched(user.username), "Repositories you watch"),
    identity.soundSettings(user).catch(() => null),
  ]);
  return { settings, watched, sounds, workspaces: user.workspaces ?? [] };
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
      case "security": {
        const cadence: DigestCadence | null = securityDigestFromForm(form);
        if (!cadence) return data(answer(null, "Choose when the rest of the security alerts reach you."), { status: 400 });
        await inbox.updateSettings(user.username, { securityAlerts: form.get("security_alerts") === "on", securityDigest: cadence });
        return answer("Saved. Critical and high alerts on repositories you look after still reach you at once.");
      }
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

const LEVEL_LABEL: Record<WatchLevel, string> = Object.fromEntries(WATCH_CHOICES.map((choice) => [choice.level, choice.label])) as Record<WatchLevel, string>;

export default function NotificationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { watched, sounds, workspaces } = loaderData;
  const settings = isFailed(loaderData.settings) ? null : loaderData.settings;
  const navigation = useNavigation();
  const said = (intent: string) => (actionData?.intent === intent && navigation.state === "idle" ? actionData : null);
  return (
    <div className="space-y-10">
      <SoundSettingsSection initial={sounds} />
      <LiveNotificationSettings workspaces={workspaces} />
      <section aria-labelledby="email-heading">
        <h2 id="email-heading" className="text-sm font-semibold">
          Email
        </h2>
        <p className="mt-1 text-sm text-muted">
          Besides your{" "}
          <Link to="/notifications" className="text-fg underline underline-offset-4">
            notifications
          </Link>
          , email me at my primary address when:
        </p>
        {settings ? (
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
              <SubmitButton variant="outline" match={{ intent: "email" }} pending="Saving…">
                Save email settings
              </SubmitButton>
              {said("email")?.saved && <p className="text-xs text-success">{said("email")?.saved}</p>}
            </div>
            <ErrorText>{said("email")?.error}</ErrorText>
          </Form>
        ) : (
          <div className="mt-4">
            <Unavailable what="Your email settings" />
          </div>
        )}
        <p className="mt-3 text-xs text-faint">Email goes only to a confirmed address, and only about repositories you can still read.</p>
      </section>

      <section aria-labelledby="security-heading">
        <h2 id="security-heading" className="text-sm font-semibold">
          Security
        </h2>
        <p className="mt-1 text-sm text-muted">
          Each scan of a repository is one item, brought up to date by the next scan. Critical and high alerts, a push of yours that push protection refused and
          a vulnerability report reach you at once; the rest, as you choose here. The workspaces you own, or manage security for, tell you of their urgent
          alerts whatever you choose.
        </p>
        {settings ? (
          <Form method="post" className="mt-4 space-y-4">
            <input type="hidden" name="intent" value="security" />
            <SwitchCard name="security_alerts" title="Critical and high alerts at once" defaultChecked={settings.securityAlerts}>
              On repositories you watch for security alerts. Off, you hear of them only in the repositories you own or manage security for.
            </SwitchCard>
            <div>
              <p className="mb-2 text-sm font-medium">Medium and low alerts</p>
              <RadioGroup name="security_digest" defaultValue={settings.securityDigest}>
                {SECURITY_DIGEST_CHOICES.map((choice) => (
                  <RadioOption key={choice.cadence} value={choice.cadence} label={choice.label} description={choice.detail} />
                ))}
              </RadioGroup>
            </div>
            <div className="flex items-center gap-3">
              <SubmitButton variant="outline" match={{ intent: "security" }} pending="Saving…">
                Save security settings
              </SubmitButton>
              {said("security")?.saved && <p className="text-xs text-success">{said("security")?.saved}</p>}
            </div>
            <ErrorText>{said("security")?.error}</ErrorText>
          </Form>
        ) : (
          <div className="mt-4">
            <Unavailable what="Your security notification settings" />
          </div>
        )}
        <p className="mt-3 text-xs text-faint">Email for security alerts follows the Email section above: on by default.</p>
      </section>

      <section aria-labelledby="watching-heading">
        <h2 id="watching-heading" className="text-sm font-semibold">
          Repositories you create
        </h2>
        <p className="mt-1 text-sm text-muted">How you watch a repository when you make it. Change any one from its Watch menu.</p>
        {settings ? (
          <Form method="post" className="mt-4">
            <input type="hidden" name="intent" value="default_watch" />
            <RadioGroup name="default_watch" defaultValue={settings.defaultWatch === "participating" ? "participating" : "all"}>
              {WATCH_CHOICES.filter((choice) => choice.level === "all" || choice.level === "participating").map((choice) => (
                <RadioOption key={choice.level} value={choice.level} label={choice.label} description={choice.detail} />
              ))}
            </RadioGroup>
            <div className="mt-4 flex items-center gap-3">
              <SubmitButton variant="outline" match={{ intent: "default_watch" }} pending="Saving…">
                Save
              </SubmitButton>
              {said("default_watch")?.saved && <p className="text-xs text-success">{said("default_watch")?.saved}</p>}
            </div>
            <ErrorText>{said("default_watch")?.error}</ErrorText>
          </Form>
        ) : (
          <div className="mt-4">
            <Unavailable what="How you watch what you create" />
          </div>
        )}
      </section>

      <section aria-labelledby="watched-heading">
        <h2 id="watched-heading" className="text-sm font-semibold">
          Repositories you watch
        </h2>
        <p className="mt-1 text-sm text-muted">Those you watch other than the default way, which is only what you take part in.</p>
        {isFailed(watched) ? (
          <div className="mt-4">
            <Unavailable what="Repositories you watch" />
          </div>
        ) : watched.length === 0 ? (
          <Card asChild tone="plain" radius="lg" className="mt-4 border-dashed px-4 py-6 text-center text-sm text-muted">
            <p>You watch every repository the default way.</p>
          </Card>
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
                    variant="outline"
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
