import { data } from "react-router";

import type { SessionEntry } from "@g1t/contracts";

import type { Route } from "./+types/why";
import { showOneCommit } from "../../lib/commit-people.server";
import { pullForCommit } from "../../lib/provenance.server";
import { repos, work } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

/** How many steps of the agent's session are shown for one commit. */
const MAX_STEPS = 8;
/** Longest a step's text is shown. */
const MAX_STEP_CHARS = 600;

/**
 * The steps of a session behind `hash`: what the agent said and did
 * between the previous commit and this one. Entries carry the head commit
 * when they were recorded, so the work that produced `hash` is the run of
 * entries just before the first one recorded at it. Steps that touch
 * `file` come first.
 */
function stepsFor(session: SessionEntry[], hash: string, file: string): SessionEntry[] {
  // The sandbox notes each push: "Pushed b1c42490059b." The work behind a
  // commit runs from the push before it to the push that carried it.
  const pushed = (entry: SessionEntry) =>
    entry.kind === "note" ? /^Pushed ([0-9a-f]{7,40})/.exec(entry.text)?.[1] ?? null : null;
  const end = session.findIndex((entry) => {
    const pushedHash = pushed(entry);
    return entry.commit === hash || (pushedHash != null && hash.startsWith(pushedHash));
  });
  let window = session;
  if (end >= 0) {
    let start = end - 1;
    while (start >= 0 && pushed(session[start]!) == null) start--;
    window = session.slice(start + 1, end + 1);
  }
  const name = file.split("/").pop() ?? file;
  const useful = window.filter(
    (entry) =>
      entry.kind === "message" ||
      (entry.kind === "tool_call" && (entry.text.includes(file) || entry.text.includes(name))),
  );
  const touching = useful.filter((entry) => entry.text.includes(name));
  const chosen = (touching.length > 0 ? [...touching, ...useful.filter((e) => e.kind === "message")] : useful)
    .filter((entry, index, all) => all.findIndex((other) => other.seq === entry.seq) === index)
    .sort((a, b) => a.seq - b.seq)
    .slice(-MAX_STEPS);
  return chosen.map((entry) => ({
    ...entry,
    text: entry.text.length > MAX_STEP_CHARS ? `${entry.text.slice(0, MAX_STEP_CHARS)}…` : entry.text,
  }));
}

/**
 * Why a line is the way it is: the commit that last changed it, the pull
 * request and issue it came from, and what the agent was thinking.
 * Fetched by the blame view when a line is picked.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const file = new URL(request.url).searchParams.get("path") ?? "";
  if (!/^[0-9a-f]{40}$/i.test(params.hash)) throw data(null, { status: 404 });
  const [log, pull] = await Promise.all([
    repos.log(path, viewer, params.hash, 1),
    pullForCommit(path, viewer, params.hash),
  ]);
  const commit = await showOneCommit(log.ok ? log.value[0] : undefined);
  if (!commit) throw data(null, { status: 404 });
  if (!pull) return { commit, pull: null, issue: null, steps: [] as SessionEntry[] };
  const [detail, session] = await Promise.all([
    work.getPull(path, pull.number, viewer),
    pull.runtime === "hosted" || pull.agent ? work.readSession(path, pull.number, viewer) : null,
  ]);
  const issue = detail.ok ? detail.value.issue : null;
  return {
    commit,
    pull: {
      number: pull.number,
      title: pull.title,
      agent: pull.agent,
      runtime: pull.runtime,
      author: pull.author.username,
      requestedBy: pull.requestedBy?.username ?? null,
      mergedBy: pull.mergedBy,
      mergedAt: pull.mergedAt,
    },
    issue: issue && {
      number: issue.number,
      title: issue.title,
      body: issue.body.length > 900 ? `${issue.body.slice(0, 900)}…` : issue.body,
      author: issue.author.username,
    },
    steps: session?.ok ? stepsFor(session.value, commit.hash, file) : [],
  };
}
