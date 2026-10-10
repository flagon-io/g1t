import { KeyRound, LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link } from "react-router";

import { type DeployKey, MAX_DEPLOY_KEYS } from "@g1t/contracts";

import type { Route } from "./+types/settings-deploy-keys";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingsSection as Section } from "../../components/settings-section";
import { ErrorText, Field, Input, SubmitButton, Textarea, TimeAgo, usePending } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Hint } from "../../components/ui/hint";
import { page } from "../../lib/meta";
import { refusal, requireInsider } from "../../lib/access.server";
import { identity } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deploy keys · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  const { viewer } = await requireInsider(context, params, "manage_access");
  return { keys: unwrap(await identity.listDeployKeys(viewer, params.owner, params.repo)) };
}

/** What a form on this page came back with. */
type Outcome = { intent: string; ok: boolean; message: string | null; error: string | null };

export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const failed = (error: string): Outcome => ({ intent, ok: false, message: null, error });
  const refused = await refusal(context, params, "manage_access");
  if (refused) return failed(refused);
  if (intent === "add") {
    const added = await identity.addDeployKey(user, params.owner, params.repo, {
      title: String(form.get("title") ?? ""),
      key: String(form.get("key") ?? ""),
      readOnly: form.get("write") !== "on",
    });
    return added.ok
      ? { intent, ok: true, message: `Added ${added.value.title}.`, error: null }
      : failed(added.error.message);
  }
  if (intent === "delete") {
    const removed = await identity.removeDeployKey(user, params.owner, params.repo, String(form.get("id") ?? ""));
    return removed.ok ? { intent, ok: true, message: "Deleted the deploy key.", error: null } : failed(removed.error.message);
  }
  return failed("Unknown action.");
}

export default function DeployKeys({ loaderData, actionData, params }: Route.ComponentProps) {
  const { keys } = loaderData;
  const full = `${params.owner}/${params.repo}`;
  const result = actionData;
  return (
    <>
      <RepoSettingsHeading base={`/${full}`} />
      <div className="space-y-10">
        <Card asChild tone="plain" radius="lg" className="border-dashed p-3 text-xs text-muted">
          <p>
            Deploy keys are used over SSH, and git over SSH is not on yet: it is waiting on inbound TCP on Cloudflare,
            which g1t has applied for. Keys you add now will work as soon as it is. Until then, machines can clone and
            push over HTTPS with a{" "}
            <Link to={`/${params.owner}/-/tokens`} className="text-fg underline underline-offset-4">
              workspace access token
            </Link>
            .
          </p>
        </Card>

        <Section
          title="Keys"
          about={`SSH keys that reach ${full} and no other repository, for a server or a pipeline. Each is read-only unless you allowed write access.`}
        >
          {keys.length === 0 ? (
            <Card asChild tone="plain" className="border-dashed px-4 py-6 text-center text-sm text-muted">
              <p>
                No deploy keys yet.
              </p>
            </Card>
          ) : (
            <Card asChild tone="plain" divided>
              <ul>
                {keys.map((key) => (
                  <KeyRow key={key.id} deployKey={key} />
                ))}
              </ul>
            </Card>
          )}
          {result?.intent === "delete" && (
            <p className={`text-sm ${result.ok ? "text-success" : "text-danger"}`} role="status">
              {result.ok ? result.message : result.error}
            </p>
          )}
        </Section>

        <Section
          title="Add a deploy key"
          about="Paste the public key, one line such as the contents of id_ed25519.pub. A key can be registered once on g1t: give each machine its own."
        >
          {keys.length >= MAX_DEPLOY_KEYS ? (
            <p className="text-sm text-muted">
              {full} has {MAX_DEPLOY_KEYS} deploy keys, the most a repository can have. Delete one to add another.
            </p>
          ) : (
            <AddForm result={result?.intent === "add" ? result : undefined} />
          )}
        </Section>
      </div>
    </>
  );
}

function KeyRow({ deployKey }: { deployKey: DeployKey }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 sm:gap-4">
      <KeyRound size={16} className="mt-0.5 shrink-0 text-faint" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="min-w-0 break-words">{deployKey.title}</span>
          {deployKey.read_only ? (
            <Badge>Read-only</Badge>
          ) : (
            <Hint label="This key can push, workflow files included.">
              <Badge tone="warn" tabIndex={0}>
                Read and write
              </Badge>
            </Hint>
          )}
        </p>
        <p className="mt-0.5 truncate font-mono text-xs text-muted">{deployKey.fingerprint}</p>
        <p className="mt-1 text-xs text-faint">
          Added {deployKey.created_by ? `by ${deployKey.created_by} ` : ""}
          <TimeAgo at={deployKey.created_at} /> ·{" "}
          {deployKey.last_used_at ? (
            <>
              Last used <TimeAgo at={deployKey.last_used_at} />
            </>
          ) : (
            "Never used"
          )}
        </p>
      </div>
      <DeleteKey deployKey={deployKey} />
    </li>
  );
}

function DeleteKey({ deployKey }: { deployKey: DeployKey }) {
  const deleting = usePending({ intent: "delete", id: deployKey.id });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" disabled={deleting} aria-label={`Delete ${deployKey.title}`}>
          {deleting ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Trash2 size={14} />}
          <span className="hidden sm:inline">{deleting ? "Deleting…" : "Delete"}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <Form method="post" className="grid gap-4">
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={deployKey.id} />
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deployKey.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key can no longer clone{deployKey.read_only ? "" : " or push"} at once. To use it
              again, add it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <button type="submit">
                <Trash2 size={14} />
                Delete key
              </button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AddForm({ result }: { result: Outcome | undefined }) {
  const [write, setWrite] = useState(false);
  const [round, setRound] = useState(0);
  // Cleared once a key was added, ready for the next.
  useEffect(() => {
    if (result?.ok) {
      setRound((n) => n + 1);
      setWrite(false);
    }
  }, [result]);
  return (
    <Card asChild key={round} className="space-y-4 p-4">
      <Form method="post">
        <input type="hidden" name="intent" value="add" />
        <Field label="Title" hint="Such as the machine or the pipeline that uses it. Left empty, the key's comment.">
          <Input name="title" maxLength={100} placeholder="Production server" />
        </Field>
        <Field label="Key">
          <Textarea
            name="key"
            required
            rows={3}
            spellCheck={false}
            placeholder="Begins with ssh-ed25519, ecdsa-sha2-nistp256, ecdsa-sha2-nistp384, ecdsa-sha2-nistp521 or ssh-rsa"
          />
        </Field>
        <CheckboxOption
          name="write"
          checked={write}
          onCheckedChange={(checked) => setWrite(checked === true)}
          label="Allow write access"
          description="Lets this key push to the repository, workflow files included."
        />
        {write && (
          <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-sm text-fg-soft">
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
            <span>
              Anyone with the private key can push to this repository and change its workflows, which run with its
              secrets. Keep it read-only unless the machine must push.
            </span>
          </p>
        )}
        <ErrorText>{result && !result.ok ? result.error : null}</ErrorText>
        {result?.ok && (
          <p className="text-sm text-success" role="status">
            {result.message}
          </p>
        )}
        <SubmitButton pending="Adding…" match={{ intent: "add" }}>
          Add deploy key
        </SubmitButton>
      </Form>
    </Card>
  );
}
