import { data } from "react-router";

import type { Route } from "./+types/ref";
import { work } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

/** What a reference chip's card shows (components/chat/ref-chip.tsx): an issue or pull request, as the viewer may see it. */
export type RefCard = { kind: "issue" | "pull"; repo: string; number: number; title: string; state: string };

/**
 * `-/chat/ref?repo=<namespace>/<name>&number=<n>`: the card that opens over
 * an `owner/repo#12` chip in chat and in g1t's answers. Issues and pull
 * requests share numbers: the issue if there is one, else the pull
 * request. Only what the viewer may read; anything else is not found.
 * Kept a minute by the browser.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const [namespace, name] = (url.searchParams.get("repo") ?? "").split("/");
  const number = Number(url.searchParams.get("number"));
  const headers = { "cache-control": "private, max-age=60", vary: "Cookie" };
  if (!namespace || !name || !Number.isInteger(number) || number < 1) return Response.json({ error: "not_found" }, { status: 404, headers });
  const repo = { namespace: namespace.toLowerCase(), name };
  const issue = await work.getIssue(repo, number, viewer).catch(() => null);
  let card: RefCard | null = issue?.ok
    ? { kind: "issue", repo: `${repo.namespace}/${repo.name}`, number, title: issue.value.issue.title, state: String(issue.value.issue.state) }
    : null;
  if (!card) {
    const pull = await work.getPull(repo, number, viewer).catch(() => null);
    if (pull?.ok) card = { kind: "pull", repo: `${repo.namespace}/${repo.name}`, number, title: pull.value.pull.title, state: pull.value.pull.status };
  }
  if (!card) return Response.json({ error: "not_found" }, { status: 404, headers });
  return Response.json(card, { headers });
}
