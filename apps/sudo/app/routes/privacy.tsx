import { Form, Link, data } from "react-router";
import type { Route } from "./+types/privacy";
import { Button, Input, Notice, PageHeader, Textarea, When } from "~/components/ui";
import { privacy } from "~/lib/services.server";
import { requireStaff } from "~/lib/staff";

const evidenceFields = ["identity", "downstream", "shared_content", "processors", "backups", "response", "retention"] as const;

export async function loader({ context }: Route.LoaderArgs) {
  requireStaff(context);
  const [requests, pending] = await Promise.all([privacy.requests(), privacy.pending()]);
  return { requests, pending, now: new Date().toISOString() };
}

export async function action({ request, context }: Route.ActionArgs) {
  // The worker refuses a post from anywhere but sudo's own pages (lib/access.ts isSameOrigin).
  const staff = requireStaff(context);
  const form = await request.formData();
  const status = String(form.get("status") ?? "");
  if (status === "intake") {
    const result = await privacy.intake(String(form.get("username") ?? ""), String(form.get("received_at") ?? ""), staff.email, String(form.get("notes") ?? ""));
    return result.ok ? { saved: true } : data({ error: result.error.message }, { status: 422 });
  }
  const evidence = status === "completed"
    ? JSON.stringify(Object.fromEntries(evidenceFields.map(key => [key, String(form.get(key) ?? "")])))
    : String(form.get("notes") ?? "");
  const result = await privacy.review(String(form.get("id") ?? ""), staff.email, status, evidence);
  return result.ok ? { saved: true } : data({ error: result.error.message }, { status: 422 });
}

export default function Privacy({ loaderData, actionData }: Route.ComponentProps) {
  return <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
    <PageHeader title="Privacy requests" description="Respond without undue delay, by the recorded deadline. Automatic cleanup is only part of fulfilling an erasure request." />
    {actionData && "error" in actionData && <Notice tone="error">{actionData.error}</Notice>}
    {actionData && "saved" in actionData && <Notice tone="ok">Review recorded.</Notice>}
    <p className="text-sm text-muted">Verify the request and assess shared content and lawful retention before using <Link to="/users/deleted" className="underline">account purge</Link>. A completed event publication still needs downstream verification. Follow <code>docs/operations/privacy-erasure.md</code>.</p>
    <details><summary className="cursor-pointer">Record a request received elsewhere</summary><Form method="post" className="my-3 space-y-3">
      <label className="block text-sm">Username<Input name="username" required /></label>
      <label className="block text-sm">Original receipt time (UTC)<Input name="received_at" required placeholder="2026-10-14T15:30:00.000Z" /></label>
      <label className="block text-sm">Source and verification notes<Textarea name="notes" required rows={3} maxLength={16000} /></label>
      <Button name="status" value="intake">Record request</Button>
    </Form></details>
    {loaderData.requests.length === 0 && <p>No erasure requests recorded.</p>}
    {loaderData.requests.map(request => <section key={request.id} className="space-y-3 rounded-lg border border-line p-4">
      <h2 className="font-medium"><Link to={`/users/${request.username}`} className="underline">{request.username}</Link> — {request.status}</h2>
      <p className="text-sm">{request.id}. Received <When at={request.requested_at} />. Response due <When at={request.due_at} />{!request.closed_at && request.due_at < loaderData.now && <strong className="text-danger"> — overdue</strong>}.</p>
      <p className="text-sm text-muted">{request.scope}</p>
      {request.reviews.length > 0 && <details><summary className="cursor-pointer text-sm">Case trail ({request.reviews.length})</summary>
        <ol className="my-2 space-y-2">{request.reviews.map((review, i) => <li key={i} className="text-sm">
          <When at={review.at} time /> · {review.status} · {review.staff}
          <pre className="whitespace-pre-wrap break-words text-xs">{review.evidence}</pre>
        </li>)}</ol>
      </details>}
      {!request.closed_at && <Form method="post" className="space-y-3">
        <input type="hidden" name="id" value={request.id} />
        <label className="block text-sm">Review notes or refusal grounds, response and appeal information<Textarea name="notes" rows={3} maxLength={16000} /></label>
        <div className="flex gap-2"><Button name="status" value="reviewing">Save review</Button><Button name="status" value="refused" variant="quiet">Record refusal</Button></div>
        <details><summary className="cursor-pointer text-sm">Completion evidence</summary>
          <p className="my-3 text-sm text-muted">Record the actual outcome for each area, including evidence references, retained records and their reason and review date. Never paste credentials or unnecessary personal content. The response must already have been sent.</p>
          {evidenceFields.map(key => <label key={key} className="my-3 block text-sm">{key.replaceAll("_", " ")}<Textarea name={key} rows={2} maxLength={2000} /></label>)}
          <Button name="status" value="completed">Record completion</Button>
        </details>
      </Form>}
    </section>)}
    <section className="space-y-3"><h2 className="font-medium">Pending cleanup</h2>
      <p className="text-sm text-muted">Retries run every 15 minutes with backoff, up to 16 hours. Failed work remains here until it succeeds. This list does not prove that downstream event consumers have finished.</p>
      {loaderData.pending.length === 0 ? <p className="text-sm">No pending jobs.</p> : <ul className="space-y-2">{loaderData.pending.map(job => <li key={`${job.subject_id}:${job.target}`} className="text-sm">
        <code>{job.subject_id}</code> · {job.target} · {job.attempts} attempts · retry <When at={job.retry_at} time />{job.last_error && ` · ${job.last_error}`}
      </li>)}</ul>}
    </section>
  </main>;
}
