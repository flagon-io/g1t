/**
 * Error pages a browser showed, reported to the site's own logs. Most
 * errors that end on "Something went wrong" happen in the browser, where
 * only someone with developer mode on sees them; this sends what it was
 * (its name, message, a few stack lines, the page, the tab's build and
 * whether g1t was deployed since the tab loaded) so it can be read in the
 * site's Workers logs as `client.error`. Nothing about the person: the
 * page's path, without its query.
 */

export const CLIENT_ERROR_PATH = "/__client-error";

/** The most a report may be, in bytes; anything longer is cut. */
const MAX_FIELD = 2_000;

export type ClientErrorReport = {
  name: string;
  message: string;
  stack: string;
  status: number | null;
  path: string;
  build: string;
  outdated: boolean;
};

/** What to report of `error` on page `path`. */
export function clientErrorReport(error: unknown, path: string, build: string, outdated: boolean): ClientErrorReport {
  const failure = error instanceof Error ? error : null;
  const response = error as { status?: unknown; statusText?: unknown; data?: unknown } | null;
  const status = typeof response?.status === "number" ? response.status : null;
  const message = failure?.message ?? (status != null ? `${status} ${String(response?.statusText ?? "")}`.trim() : String(error));
  return {
    name: failure?.name ?? (status != null ? "ErrorResponse" : typeof error),
    message: message.slice(0, MAX_FIELD),
    stack: (failure?.stack ?? "").split("\n").slice(0, 12).join("\n").slice(0, MAX_FIELD),
    status,
    path: path.slice(0, 500),
    build,
    outdated,
  };
}

/** Sends a report once per page and message, without holding anything up. Browser only. */
const sent = new Set<string>();
export function reportClientError(report: ClientErrorReport) {
  const key = `${report.path}\n${report.message}`;
  if (sent.has(key) || typeof navigator === "undefined") return;
  sent.add(key);
  try {
    const body = JSON.stringify(report);
    if (!navigator.sendBeacon?.(CLIENT_ERROR_PATH, new Blob([body], { type: "application/json" }))) {
      void fetch(CLIENT_ERROR_PATH, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
    }
  } catch {
    // Reporting is best effort.
  }
}

/** The site's side: logs a report, read as a bounded JSON object, and answers 204. */
export async function logClientError(request: Request): Promise<Response> {
  try {
    const text = (await request.text()).slice(0, 8_000);
    const report = JSON.parse(text) as Partial<ClientErrorReport>;
    const field = (value: unknown, max = MAX_FIELD) => (typeof value === "string" ? value.slice(0, max) : undefined);
    console.error(
      JSON.stringify({
        event: "client.error",
        name: field(report.name, 100),
        message: field(report.message),
        stack: field(report.stack),
        status: typeof report.status === "number" ? report.status : null,
        path: field(report.path, 500),
        build: field(report.build, 100),
        outdated: report.outdated === true,
        current: import.meta.env.G1T_BUILD_ID,
      }),
    );
  } catch {
    // A report that is not one is dropped.
  }
  return new Response(null, { status: 204 });
}
