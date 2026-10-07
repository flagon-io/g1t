import { useEffect, useState } from "react";
import { Form, data, redirect, useFetcher, useNavigation } from "react-router";

import {
  RENAME_COOLDOWN_HOURS,
  SLUG_HOLD_DAYS,
  WORKSPACE_RESTORE_DAYS,
  type Workspace,
  type WorkspaceDeletion,
  isValidNamespace,
} from "@g1t/contracts";

import type { Route } from "./+types/settings";
import { page } from "../../lib/meta";
import { useAddresses } from "../../lib/addresses";
import { AvatarField } from "../../components/avatar-field";
import { DangerAction, DangerZone } from "../../components/danger-zone";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { FieldDescription, FieldLabel, Field as FormField } from "../../components/ui/field";
import { InputAddon, InputGroup, Input as TextInput } from "../../components/ui/input";
import { readAvatarUpload } from "../../lib/avatar-upload";
import { deployments, identity } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { forgetWorkspace } from "../../lib/workspace-choice";
import { confirmsSlug, deletionRefusal, whatGoes } from "../../lib/workspace-deletion";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${params.owner} · g1t` });
}

/** What the address field shows about a new slug, asked for with `?check=`. */
type Check = { slug: string; available: boolean; message: string | null };

export async function loader({ params, context, request }: Route.LoaderArgs) {
  // Owners only; to anyone else the page does not exist.
  const viewer = getViewer(context);
  if (roleIn(viewer, params.owner) !== "owner") {
    throw data(null, { status: 404 });
  }
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  // The address field asks whether a new slug is free as the owner types.
  // It is a read, so a GET: nothing else on the page reloads for it.
  const wanted = new URL(request.url).searchParams.get("check");
  let check: Check | null = null;
  if (wanted != null && viewer) {
    const slug = wanted.trim().toLowerCase();
    const result = await identity.checkWorkspaceRename(viewer, params.owner, slug);
    check = result.ok
      ? { slug, available: result.value, message: result.value ? null : "That address is not available." }
      : { slug, available: false, message: result.error.message };
  }
  // What deleting it would take with it, and anything in the way, shown
  // before anyone types. Its apps are counted by deployments.
  let deletion: WorkspaceDeletion | null = null;
  let apps: number | null = null;
  if (viewer) {
    const [found, usage] = await Promise.all([
      identity.checkWorkspaceDeletion(viewer, params.owner).catch(() => null),
      deployments.usage(params.owner, viewer).catch(() => null),
    ]);
    deletion = found?.ok ? found.value : null;
    apps = usage?.ok ? usage.value.apps : null;
  }
  return { workspace, check, deletion, apps };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  // The icon: identity checks the owner and the image's bytes again.
  if (intent === "avatar" || intent === "remove-avatar") {
    let image: string | null = null;
    if (intent === "avatar") {
      const upload = await readAvatarUpload(form);
      if ("error" in upload) return { avatarError: upload.error };
      image = upload.image;
    }
    const result = await identity.setWorkspaceAvatar(user, params.owner, image);
    if (!result.ok) return { avatarError: result.error.message };
    return { saved: "avatar" as const };
  }
  // A new address: identity checks the owner, the name and the cooldown,
  // and keeps the old one as a redirect.
  // Deletion: identity checks the owner, the typed name, that it is not
  // protected and that billing has settled it. Everything in it goes with
  // it; the owner goes back to their own home, where it is no longer listed.
  if (intent === "delete") {
    const result = await identity.deleteWorkspace(user, params.owner, String(form.get("confirm") ?? ""));
    if (!result.ok) return { deleteError: result.error.message };
    const secure = new URL(request.url).protocol === "https:";
    throw redirect("/", { headers: { "Set-Cookie": forgetWorkspace(secure) } });
  }
  if (intent === "rename") {
    const newSlug = String(form.get("newSlug") ?? "").trim().toLowerCase();
    const result = await identity.renameWorkspace(user, params.owner, newSlug);
    if (!result.ok) return { renameError: result.error.message };
    throw redirect(`/${result.value.slug}/-/settings`);
  }
  const result = await identity.updateWorkspace(user, params.owner, {
    name: String(form.get("displayName") ?? ""),
    description: String(form.get("description") ?? ""),
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.slug}`);
}

export default function WorkspaceSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  return (
    <div className="max-w-lg space-y-10">
      <section>
        <h2 className="font-medium">Icon</h2>
        <div className="mt-4">
          <AvatarField
            name={workspace.slug}
            image={workspace.avatar}
            square
            error={actionData && "avatarError" in actionData ? actionData.avatarError : undefined}
            about="Shown beside the workspace's name everywhere on g1t, and on its link previews. Without one, g1t draws its first letter."
          />
        </div>
      </section>

      <section>
        <h2 className="font-medium">Workspace details</h2>
        <Form method="post" className="mt-5 space-y-4">
          <Field
            label="Display name"
            hint="How people see the workspace: in the sidebar, at the top of its page and in link previews. Up to 80 characters; spaces and capitals are fine."
          >
            <Input name="displayName" maxLength={80} defaultValue={workspace.name} placeholder={workspace.slug} />
          </Field>
          <Field label="Description" hint="One line, shown at the top of the workspace's page.">
            <Input name="description" maxLength={160} defaultValue={workspace.description ?? ""} />
          </Field>
          <ErrorText>{actionData && "error" in actionData ? actionData.error : undefined}</ErrorText>
          <Button type="submit">Save</Button>
        </Form>
      </section>

      <AddressSection
        workspace={workspace}
        error={actionData && "renameError" in actionData ? actionData.renameError : undefined}
      />

      <DangerZone>
        <DeleteAction
          workspace={workspace}
          deletion={loaderData.deletion}
          apps={loaderData.apps}
          error={actionData && "deleteError" in actionData ? actionData.deleteError : undefined}
        />
      </DangerZone>
    </div>
  );
}

/**
 * Deleting the workspace, with everything in it, in one step. Owners only,
 * as the whole page is; typed out to confirm. It is kept for
 * `WORKSPACE_RESTORE_DAYS`, when support can restore it. A protected
 * workspace says so instead of offering the button.
 */
function DeleteAction({
  workspace,
  deletion,
  apps,
  error,
}: {
  workspace: Workspace;
  deletion: WorkspaceDeletion | null;
  apps: number | null;
  error?: string;
}) {
  const [open, setOpen] = useState(Boolean(error));
  const [confirm, setConfirm] = useState("");
  const navigation = useNavigation();
  const deleting = navigation.state !== "idle" && navigation.formData?.get("intent") === "delete";
  const refusal = deletionRefusal(workspace.slug, deletion);
  const goes = deletion ? whatGoes(deletion, apps) : [];
  if (deletion?.protected) {
    return (
      <DangerAction title="Delete this workspace" action={null}>
        <span role="status">{refusal}</span>
      </DangerAction>
    );
  }
  return (
    <DangerAction
      title="Delete this workspace"
      action={
        <Button type="button" variant="danger" disabled={Boolean(refusal)} onClick={() => setOpen(true)}>
          Delete workspace
        </Button>
      }
    >
      {refusal ? (
        <span role="status">{refusal}</span>
      ) : (
        <>
          Everything in it goes with it: repositories, projects, apps, members' access and tokens. It is kept for{" "}
          {WORKSPACE_RESTORE_DAYS} days, and support can restore it until then.
        </>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setConfirm("");
        }}
      >
        <AlertDialogContent>
          <Form method="post" className="grid gap-4">
            <input type="hidden" name="intent" value="delete" />
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {workspace.slug}?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything in it goes now. For {WORKSPACE_RESTORE_DAYS} days, support can restore all of it; after
                that it is gone for good.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {goes.length > 0 ? (
              <div className="grid gap-1.5">
                <p className="text-sm font-medium">What goes with it</p>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                  {goes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
              <li>Everyone loses access to it at once, and its access tokens stop working.</li>
              <li>Its pages, repositories and apps are no longer found, and nothing builds or runs for it.</li>
              <li>
                Anything it owes is charged to its card now, and its plan ends today. Its statements, invoices and
                audit log are kept.
              </li>
              <li>
                To get it back within {WORKSPACE_RESTORE_DAYS} days, an owner writes to support. After that its
                repositories, projects, apps, webhooks, integrations, secrets and memory are removed for good.
              </li>
              <li>
                The name <span className="font-mono text-fg">{workspace.slug}</span> is never given to another
                workspace. Repositories that were transferred out keep redirecting from it.
              </li>
              <li>Members keep their own accounts.</li>
            </ul>
            <FormField>
              <FieldLabel htmlFor="confirm-delete">
                Type <span className="font-mono text-fg">{workspace.slug}</span> to confirm
              </FieldLabel>
              <TextInput
                id="confirm-delete"
                name="confirm"
                value={confirm}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(event) => setConfirm(event.target.value)}
                className="font-mono"
              />
            </FormField>
            <ErrorText>{error}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant="danger" disabled={!confirmsSlug(workspace.slug, confirm) || deleting}>
                {deleting ? "Deleting…" : "Delete workspace"}
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </DangerAction>
  );
}

/**
 * The workspace's slug, the first part of every address under it. Owners
 * change it here, apart from the display name; the old one redirects for
 * `SLUG_HOLD_DAYS`.
 */
function AddressSection({ workspace, error }: { workspace: Workspace; error?: string }) {
  const [slug, setSlug] = useState(workspace.slug);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const checker = useFetcher<typeof loader>();
  const { site } = useAddresses();
  const navigation = useNavigation();
  const renaming = navigation.state !== "idle" && navigation.formData?.get("intent") === "rename";

  const wanted = slug.trim().toLowerCase();
  const unchanged = wanted === workspace.slug;
  const wellFormed = isValidNamespace(wanted);

  // The shape is checked here; whether the name is free, once the owner
  // stops typing.
  const load = checker.load;
  useEffect(() => {
    if (unchanged || !wellFormed) return;
    const timer = setTimeout(() => {
      load(`/${workspace.slug}/-/settings?check=${encodeURIComponent(wanted)}`);
    }, 400);
    return () => clearTimeout(timer);
  }, [load, wanted, unchanged, wellFormed, workspace.slug]);

  // An answer only counts for what is in the field now.
  const answer = checker.data?.check?.slug === wanted ? checker.data.check : null;
  const available = !unchanged && wellFormed && answer?.available === true;

  let status: { text: string; tone: "muted" | "ok" | "bad" } | null = null;
  if (!wanted) {
    status = { text: "Enter the new address.", tone: "muted" };
  } else if (unchanged) {
    status = null;
  } else if (!wellFormed) {
    status = {
      text: "Use lowercase letters, numbers and single hyphens, up to 39 characters, starting and ending with a letter or number. Some words, such as new and settings, are reserved.",
      tone: "bad",
    };
  } else if (!answer) {
    status = { text: "Checking…", tone: "muted" };
  } else if (answer.available) {
    status = { text: "Available.", tone: "ok" };
  } else {
    status = { text: answer.message ?? "That address is not available.", tone: "bad" };
  }

  return (
    <section>
      <h2 className="font-medium">Address</h2>
      <p className="mt-1.5 text-xs text-faint">
        The workspace's slug: the first part of every page, clone URL and API path under it. Changing it does
        not change the display name. The old address redirects for {SLUG_HOLD_DAYS} days.
      </p>
      <div className="mt-5 space-y-4">
        <FormField>
          <FieldLabel htmlFor="workspace-slug">Slug</FieldLabel>
          <InputGroup>
            <InputAddon className="border-r border-line bg-surface font-mono">g1t.sh/</InputAddon>
            <TextInput
              id="workspace-slug"
              value={slug}
              maxLength={39}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
              aria-invalid={status?.tone === "bad" || undefined}
              className="pl-2 font-mono"
            />
          </InputGroup>
          <FieldDescription>
            <span className="font-mono text-muted">
              g1t.sh/<span className={unchanged ? undefined : "text-fg"}>{wanted || workspace.slug}</span>
            </span>
            {status && (
              <span
                role="status"
                className={`mt-1 block ${
                  status.tone === "ok" ? "text-accent" : status.tone === "bad" ? "text-danger" : ""
                }`}
              >
                {status.text}
              </span>
            )}
          </FieldDescription>
        </FormField>
        {!open && <ErrorText>{error}</ErrorText>}
        <AlertDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            setConfirm("");
          }}
        >
          <Button type="button" variant="quiet" disabled={!available} onClick={() => setOpen(true)}>
            Change address
          </Button>
          <AlertDialogContent>
            {/* The dialog stays open while the form posts: success leaves
                the page for the new address, and a failure shows here. */}
            <Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="rename" />
              <input type="hidden" name="newSlug" value={wanted} />
              <AlertDialogHeader>
                <AlertDialogTitle>Change the address to g1t.sh/{wanted}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Every page, repository and API path under g1t.sh/{workspace.slug} moves to g1t.sh/{wanted}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
                <li>Old links and git remotes redirect to the new address for {SLUG_HOLD_DAYS} days.</li>
                <li>
                  Deployed apps move to <span className="font-mono">*.g1t.page</span> addresses with the new
                  name. The old addresses redirect for {SLUG_HOLD_DAYS} days.
                </li>
                <li>
                  Update your git remotes, for example{" "}
                  <code className="font-mono text-xs break-all text-fg">
                    git remote set-url origin {site}/{wanted}/&lt;repo&gt;.git
                  </code>
                  , and any URLs written into code, API clients and MCP clients.
                </li>
                <li>After {SLUG_HOLD_DAYS} days, anyone can take the name {workspace.slug}.</li>
                <li>You can change the address again after {RENAME_COOLDOWN_HOURS} hours.</li>
              </ul>
              <FormField>
                <FieldLabel htmlFor="confirm-slug">
                  Type <span className="font-mono text-fg">{wanted}</span> to confirm
                </FieldLabel>
                <TextInput
                  id="confirm-slug"
                  value={confirm}
                  spellCheck={false}
                  autoCapitalize="off"
                  onChange={(event) => setConfirm(event.target.value)}
                  className="font-mono"
                />
              </FormField>
              <ErrorText>{error}</ErrorText>
              <AlertDialogFooter>
                <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
                <Button type="submit" disabled={confirm.trim().toLowerCase() !== wanted || renaming}>
                  {renaming ? "Changing…" : "Change address"}
                </Button>
              </AlertDialogFooter>
            </Form>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
