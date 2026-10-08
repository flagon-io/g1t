/**
 * Every job's log of a run's attempt as one zip
 * (`actions/runs/:id/logs.zip?attempt=`), laid out as the API's archive is:
 * `{n}_{job}.txt` whole, and `{job}/{step}_{step name}.txt`. For anyone who
 * can see the run.
 */
import type { Route } from "./+types/actions-logs-download";
import { archiveFiles } from "../../lib/log-lines";
import { attachment, refused } from "../../lib/log-download.server";
import { actions } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { zip } from "../../lib/zip";

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const repo = { namespace: params.owner, name: params.repo };
  const asked = Number(new URL(request.url).searchParams.get("attempt") ?? "");
  const attempt = Number.isInteger(asked) && asked > 0 ? asked : undefined;
  const logs = await actions.runLogs(repo, getViewer(context), params.id, attempt);
  if (!logs.ok) return refused(logs.error.code === "not_found" ? 404 : 400, logs.error.message);
  const encoder = new TextEncoder();
  const archive = await zip(archiveFiles(logs.value).map((file) => ({ path: file.path, data: encoder.encode(file.text) })));
  return attachment(archive, "application/zip", attempt ? `logs_${params.id}_attempt_${attempt}.zip` : `logs_${params.id}.zip`);
}
