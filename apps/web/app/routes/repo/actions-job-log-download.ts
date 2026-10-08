/**
 * One job's whole log as plain text (`actions/jobs/:job/log.txt`), any
 * attempt's, by the id the run page gives the job. For anyone who can see
 * the run.
 */
import type { Route } from "./+types/actions-job-log-download";
import { fileName, jobText } from "../../lib/log-lines";
import { attachment, refused } from "../../lib/log-download.server";
import { actions } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const repo = { namespace: params.owner, name: params.repo };
  const log = await actions.jobLogText(repo, getViewer(context), params.job);
  if (!log.ok) return refused(log.error.code === "not_found" ? 404 : 400, log.error.message);
  return attachment(jobText(log.value), "text/plain; charset=utf-8", `${fileName(log.value.name)}.txt`);
}
