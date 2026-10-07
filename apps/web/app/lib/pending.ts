/**
 * Whether a button's submission is still working: posted and not yet
 * answered, or answered and the page still loading what it changed. A
 * button that only waits for "submitting" turns back on while the page
 * still shows the old figures, so it looks as if nothing happened.
 *
 * `fields` names the submission, such as `{ intent: "delete", id }`: every
 * one must match what was posted, so one row's button does not say
 * "Deleting…" while another row's is the one going. With no `fields`, any
 * submission that writes counts. A GET form (a search, a filter) is never
 * pending here: it only reads.
 */
export type Submission = {
  state: "idle" | "submitting" | "loading";
  formMethod?: string | null;
  formData?: FormData | null;
};

export function isPending(submission: Submission, fields?: Record<string, string | null | undefined>): boolean {
  if (submission.state === "idle" || !submission.formData) return false;
  if (!submission.formMethod || submission.formMethod.toUpperCase() === "GET") return false;
  const posted = submission.formData;
  return Object.entries(fields ?? {}).every(([name, value]) => value == null || posted.get(name) === value);
}
