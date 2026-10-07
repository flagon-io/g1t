/**
 * What a person hears of from one repository: subscribing to one of its
 * issues or pull requests (`intent` subscribe, unsubscribe, ignore or
 * default, with its `number`), and watching it (`intent` watch, with
 * `level` and, for custom, the `event` kinds). Posted by the sidebar's
 * Notifications box and the header's Watch menu (components/notifications.tsx).
 * Only someone who can read the repository may choose.
 */
import { data } from "react-router";

import type { Route } from "./+types/notifications";
import { subscriptionFromForm, watchFromForm } from "../../lib/inbox";
import { inbox, repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const repo = await repos.get({ namespace: params.owner, name: params.repo }, user);
  if (!repo.ok) return data({ error: "That repository could not be found." }, { status: 404 });
  const path = `${repo.value.namespace}/${repo.value.name}`;
  try {
    if (form.get("intent") === "watch") {
      const watch = watchFromForm(form);
      if (!watch) return data({ error: "Choose how to watch it." }, { status: 400 });
      // Participating is the default: no choice to keep.
      const level = watch.level === "participating" ? null : watch.level;
      return { error: null, watching: await inbox.watch(user.username, repo.value.id, path, level, watch.events) };
    }
    const choice = subscriptionFromForm(form);
    const number = Number(form.get("number"));
    if (!choice || !Number.isInteger(number) || number < 1) return data({ error: "Nothing to do." }, { status: 400 });
    const subscription = await inbox.subscribe(user, { repoId: repo.value.id, number }, choice.subscribed, choice.ignored);
    if (!subscription) return data({ error: "That issue or pull request could not be found." }, { status: 404 });
    return { error: null, subscription };
  } catch {
    return data({ error: "That did not save. Try again in a moment." }, { status: 503 });
  }
}
