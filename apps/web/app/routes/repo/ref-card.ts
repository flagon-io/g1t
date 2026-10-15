/**
 * `/<owner>/<repo>/ref/<number>`: the card that opens over a `#12` in a
 * commit message or on a timeline (components/commit-message.tsx), for
 * anyone who may read the repository, signed in or not. Issues and pull
 * requests share numbers: the issue if there is one, else the pull
 * request; anything the viewer may not read is not found. Kept a minute
 * by the browser, and out of indexes (lib/robots.ts).
 */
import type { Route } from "./+types/ref-card";
import type { RefCard } from "../workspace/chat/ref";
import { work } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

const HEADERS = {
  "cache-control": "private, max-age=60",
  vary: "Cookie",
  "x-robots-tag": "noindex, nofollow",
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const repo = { namespace: params.owner.toLowerCase(), name: params.repo };
  const number = Number(params.number);
  if (!Number.isInteger(number) || number < 1) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
  const slug = `${repo.namespace}/${repo.name}`;
  const issue = await work.getIssue(repo, number, viewer).catch(() => null);
  let card: RefCard | null = issue?.ok
    ? { kind: "issue", repo: slug, number, title: issue.value.issue.title, state: String(issue.value.issue.state) }
    : null;
  if (!card) {
    const pull = await work.getPull(repo, number, viewer).catch(() => null);
    if (pull?.ok) card = { kind: "pull", repo: slug, number, title: pull.value.pull.title, state: pull.value.pull.status };
  }
  if (!card) return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
  return Response.json(card, { headers: HEADERS });
}
