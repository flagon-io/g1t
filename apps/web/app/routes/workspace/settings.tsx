import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, data, redirect, useFetcher, useNavigation } from "react-router";

import {
  type DataResidency,
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
import { GettingStartedButton } from "../../components/onboarding";
import { ConfirmName } from "../../components/confirm-name";
import { DangerAction, DangerZone } from "../../components/danger-zone";
import { ErrorText, SubmitButton, usePending } from "../../components/ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { FieldDescription, FieldError, FieldLabel, Field as FormField } from "../../components/ui/field";
import { InputAddon, InputGroup, Input as TextInput } from "../../components/ui/input";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { Textarea } from "../../components/ui/textarea";
import { readAvatarUpload } from "../../lib/avatar-upload";
import { billing, deployments, identity, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";
import { forgetWorkspace } from "../../lib/workspace-choice";
import { settingsPath } from "../../lib/workspace-nav";
import { confirmsSlug, deletionRefusal, whatGoes } from "../../lib/workspace-deletion";
import { Unavailable } from "../../components/boundary";
import { isFailed, part, type Failed } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Profile · Settings · ${params.owner} · g1t` });
}

/** How many social accounts a workspace lists, as GitHub's organizations do. */
const SOCIAL_ACCOUNTS = 4;

/** What the address field shows about a new slug, asked for with `?check=`. */
type Check = { slug: string; available: boolean; message: string | null };

/**
 * The workspace's Profile, where its settings open, as GitHub's
 * organization settings open on General: who the workspace is (its name,
 * picture, description, links, location, a public email) and, for owners,
 * where its invoices go, its address, where its data lives and deleting
 * it. Every member reads it; only owners change it.
 */
export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!viewer || !role) throw data(null, { status: 404 });
  const workspace = await identity.getWorkspace(params.owner);
  if (!workspace) throw data(null, { status: 404 });
  if (role !== "owner") return { workspace, owner: false as const };
  // The address field asks whether a new slug is free as the owner types.
  // It is a read, so a GET: nothing else on the page reloads for it.
  const wanted = new URL(request.url).searchParams.get("check");
  let check: Check | null = null;
  if (wanted != null) {
    const slug = wanted.trim().toLowerCase();
    const result = await identity.checkWorkspaceRename(viewer, params.owner, slug);
    check = result.ok
      ? { slug, available: result.value, message: result.value ? null : "That address is not available." }
      : { slug, available: false, message: result.error.message };
  }
  // What deleting it would take with it, and anything in the way, shown
  // before anyone types. Its apps are counted by deployments.
  // When that cannot be read, Delete says so in its place rather than
  // offering itself without saying what would go. How many apps go is only
  // a count in that list, which reads without it.
  // Where its repositories are kept: offered once g1t can keep them in the
  // EU, and shown to a workspace that chose it whatever happens since.
  // Each of these is a section's: one that cannot be read says so in its
  // place, rather than show a choice that saving would put over the real one.
  const [found, usage, storage, residency, billingEmail] = await Promise.all([
    part(identity.checkWorkspaceDeletion(viewer, params.owner), "What deleting it would take with it"),
    deployments.usage(params.owner, viewer).catch(() => null),
    // Whether the EU is offered: without it, only a workspace that chose it sees the choice.
    repos.storageOptions().catch(() => ({ euAvailable: false })),
    part(identity.workspaceResidency(params.owner), "Data residency"),
    part(identity.workspaceBillingEmail(viewer, params.owner), "The billing email"),
  ]);
  const deletion: WorkspaceDeletion | Failed | null = isFailed(found) ? found : found.ok ? found.value : null;
  return {
    workspace,
    owner: true as const,
    check,
    deletion,
    apps: usage?.ok ? usage.value.apps : null,
    euAvailable: storage.euAvailable,
    residency: isFailed(residency) ? residency : (residency ?? "anywhere"),
    billingEmail: isFailed(billingEmail) ? billingEmail : billingEmail.ok ? billingEmail.value : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  // The picture: identity checks the owner and the image's bytes again.
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
  // Deletion: identity checks the owner, the typed name, that it is not
  // protected and that billing has settled it. Everything in it goes with
  // it; the owner goes back to their own home, where it is no longer listed.
  if (intent === "delete") {
    const result = await identity.deleteWorkspace(user, params.owner, String(form.get("confirm") ?? ""));
    if (!result.ok) return { deleteError: result.error.message };
    const secure = new URL(request.url).protocol === "https:";
    throw redirect("/", { headers: { "Set-Cookie": forgetWorkspace(secure) } });
  }
  // Where new repositories keep their data: identity checks the owner.
  if (intent === "residency") {
    const wanted = form.get("residency") === "eu" ? "eu" : "anywhere";
    const result = await identity.setWorkspaceResidency(user, params.owner, wanted);
    if (!result.ok) return { residencyError: result.error.message };
    return { saved: "residency" as const };
  }
  // A new address: identity checks the owner, the name and the cooldown,
  // and keeps the old one as a redirect.
  if (intent === "rename") {
    const newSlug = String(form.get("newSlug") ?? "")
      .trim()
      .toLowerCase();
    const result = await identity.renameWorkspace(user, params.owner, newSlug);
    if (!result.ok) return { renameError: result.error.message };
    throw redirect(settingsPath(result.value.slug));
  }
  // Where invoices go: kept by identity, and handed to Stripe's customer
  // when the workspace has one (a new one is made with it).
  if (intent === "billing-email") {
    const email = String(form.get("billingEmail") ?? "").trim();
    const result = await identity.updateWorkspace(user, params.owner, { ...detailsOf(form), billingEmail: email });
    if (!result.ok) return { billingError: result.error.message };
    if (email) {
      const told = await billing.setCustomerEmail(user, params.owner, email).catch(() => null);
      if (told && !told.ok) return { billingError: told.error.message };
    }
    return { saved: "billing-email" as const };
  }
  // The profile: identity checks every field again, the links most of all.
  const text = (name: string) => String(form.get(name) ?? "");
  const result = await identity.updateWorkspace(user, params.owner, {
    name: text("displayName"),
    description: text("description"),
    website: text("website"),
    email: text("email"),
    location: text("location"),
    socialAccounts: form
      .getAll("social")
      .map((value) => String(value).trim())
      .filter(Boolean),
  });
  if (!result.ok) return { error: result.error.message };
  return { saved: "profile" as const };
}

/** The name and description as they are, sent beside a change that only touches one other field. */
function detailsOf(form: FormData): { name: string; description: string } {
  return { name: String(form.get("displayName") ?? ""), description: String(form.get("description") ?? "") };
}

export default function WorkspaceProfile({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  const saved = actionData && "saved" in actionData ? actionData.saved : null;
  return (
    <div className="max-w-4xl space-y-12">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <ProfileForm
          // Keyed on what was saved, so the fields show identity's copy once it answers.
          key={JSON.stringify([workspace.name, workspace.description, workspace.website, workspace.email, workspace.location, workspace.socialAccounts])}
          workspace={workspace}
          owner={loaderData.owner}
          saved={saved === "profile"}
          error={actionData && "error" in actionData ? actionData.error : undefined}
        />
        <section className="lg:order-last">
          <h2 className="font-medium">Profile picture</h2>
          <div className="mt-4">
            {loaderData.owner ? (
              <AvatarField
                name={workspace.slug}
                image={workspace.avatar}
                square
                error={actionData && "avatarError" in actionData ? actionData.avatarError : undefined}
                about="Shown beside the workspace's name everywhere on g1t, and on its link previews. Without one, g1t draws its first letter."
              />
            ) : (
              <p className="text-sm text-muted">Only owners change it.</p>
            )}
          </div>
        </section>
      </div>

      {loaderData.owner && (
        <div className="max-w-2xl space-y-12">
          {isFailed(loaderData.billingEmail) ? (
            <section>
              <h2 className="font-medium">Billing email</h2>
              <div className="mt-5">
                <Unavailable what={loaderData.billingEmail.what} />
              </div>
            </section>
          ) : (
            <BillingEmailSection
              key={loaderData.billingEmail ?? ""}
              workspace={workspace}
              email={loaderData.billingEmail}
              saved={saved === "billing-email"}
              error={actionData && "billingError" in actionData ? actionData.billingError : undefined}
            />
          )}

          <section>
            <h2 className="font-medium">Getting started</h2>
            <p className="mt-1.5 text-sm text-muted">
              The setup guide that opened on Home: an AI provider, Ask&apos;s model, your code, your coding agent, your team and a runner, each ticked off as
              the workspace has it. Open it again any time.
            </p>
            <div className="mt-3">
              <GettingStartedButton slug={workspace.slug} />
            </div>
          </section>

          <AddressSection
            // A new address starts it again, so the dialog is closed on the renamed page.
            key={workspace.slug}
            workspace={workspace}
            error={actionData && "renameError" in actionData ? actionData.renameError : undefined}
          />

          {isFailed(loaderData.residency) ? (
            <section>
              <h2 className="font-medium">Data residency</h2>
              <div className="mt-5">
                <Unavailable what={loaderData.residency.what} />
              </div>
            </section>
          ) : (
            (loaderData.euAvailable || loaderData.residency === "eu") && (
              <ResidencySection
                // Starts from the saved choice whenever it changes.
                key={loaderData.residency}
                residency={loaderData.residency}
                euAvailable={loaderData.euAvailable}
                saved={saved === "residency"}
                error={actionData && "residencyError" in actionData ? actionData.residencyError : undefined}
              />
            )
          )}

          <DangerZone>
            {isFailed(loaderData.deletion) ? (
              <div className="p-4">
                <Unavailable what={loaderData.deletion.what} compact />
              </div>
            ) : (
              <DeleteAction
                workspace={workspace}
                deletion={loaderData.deletion}
                apps={loaderData.apps}
                error={actionData && "deleteError" in actionData ? actionData.deleteError : undefined}
              />
            )}
          </DangerZone>
        </div>
      )}
    </div>
  );
}

/**
 * Who the workspace is, as everyone sees it on its page: its name,
 * description, links, location and public email. Members read it; the
 * fields are an owner's to change.
 */
function ProfileForm({ workspace, owner, saved, error }: { workspace: Workspace; owner: boolean; saved: boolean; error?: string }) {
  const busy = usePending({ intent: "profile" });
  const [description, setDescription] = useState(workspace.description ?? "");
  const social = Array.from({ length: SOCIAL_ACCOUNTS }, (_, index) => workspace.socialAccounts?.[index] ?? "");
  return (
    <section>
      <h2 className="font-medium">Public profile</h2>
      <p className="mt-1 text-sm text-muted">
        Shown on the workspace&apos;s page and in its link previews. All of it but the name is optional.
        {!owner && " Only owners change it."}
      </p>
      <Form method="post" className="mt-5">
        <input type="hidden" name="intent" value="profile" />
        <fieldset disabled={!owner} className="grid gap-4 sm:grid-cols-2">
          <FormField className="sm:col-span-2">
            <FieldLabel htmlFor="workspace-name">Display name</FieldLabel>
            <TextInput id="workspace-name" name="displayName" maxLength={80} defaultValue={workspace.name} placeholder={workspace.slug} />
            <FieldDescription>How people see the workspace: in the sidebar, at the top of its page and in link previews. Up to 80 characters.</FieldDescription>
          </FormField>
          <FormField className="sm:col-span-2">
            <FieldLabel htmlFor="workspace-description">Description</FieldLabel>
            <Textarea
              id="workspace-description"
              name="description"
              rows={2}
              maxLength={160}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="What the workspace makes, in a line."
            />
            <FieldDescription>{description.length}/160 characters, shown at the top of the workspace&apos;s page.</FieldDescription>
          </FormField>
          <FormField>
            <FieldLabel htmlFor="workspace-website">URL</FieldLabel>
            <TextInput id="workspace-website" name="website" inputMode="url" defaultValue={workspace.website ?? ""} placeholder="https://example.com" />
            <FieldDescription>An https:// address.</FieldDescription>
          </FormField>
          <FormField>
            <FieldLabel htmlFor="workspace-email">Public email</FieldLabel>
            <TextInput id="workspace-email" name="email" type="email" defaultValue={workspace.email ?? ""} placeholder="hello@example.com" />
            <FieldDescription>Where people reach the workspace. Shown to everyone.</FieldDescription>
          </FormField>
          <FormField>
            <FieldLabel htmlFor="workspace-location">Location</FieldLabel>
            <TextInput id="workspace-location" name="location" maxLength={80} defaultValue={workspace.location ?? ""} placeholder="Portland, Oregon" />
          </FormField>
          <FormField className="sm:col-span-2">
            <FieldLabel htmlFor="workspace-social-0">Social accounts</FieldLabel>
            <div className="grid gap-2">
              {social.map((value, index) => (
                <TextInput
                  key={index}
                  id={`workspace-social-${index}`}
                  name="social"
                  inputMode="url"
                  defaultValue={value}
                  aria-label={`Social account ${index + 1}`}
                  placeholder="https://"
                />
              ))}
            </div>
            <FieldDescription>Up to {SOCIAL_ACCOUNTS} links, each an https:// address.</FieldDescription>
          </FormField>
          {owner && (
            <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
              <SubmitButton pending="Saving…" match={{ intent: "profile" }}>
                Update profile
              </SubmitButton>
              {saved && !busy && !error && (
                <span role="status" className="inline-flex items-center gap-1.5 text-sm text-muted">
                  <Check size={14} className="text-success" />
                  Saved
                </span>
              )}
              <FieldError>{error}</FieldError>
            </div>
          )}
        </fieldset>
      </Form>
    </section>
  );
}

/**
 * Where the workspace's invoices and receipts go, kept private: what its
 * Stripe customer is given, in place of an owner's own address. More
 * recipients are Stripe's to add, on the billing page.
 */
function BillingEmailSection({ workspace, email, saved, error }: { workspace: Workspace; email: string | null; saved: boolean; error?: string }) {
  const busy = usePending({ intent: "billing-email" });
  return (
    <section>
      <h2 className="font-medium">Billing email</h2>
      <p className="mt-1.5 text-xs text-faint">
        Where invoices and receipts go. Never shown on the workspace&apos;s page. Without one, they go to an owner&apos;s email. To send them to more people,
        add them from{" "}
        <Link to={settingsPath(workspace.slug, "billing")} className="text-muted underline underline-offset-4 hover:text-fg">
          Billing and plans
        </Link>
        .
      </p>
      <Form method="post" className="mt-5 max-w-lg space-y-3">
        <input type="hidden" name="intent" value="billing-email" />
        {/* The profile's name and description go with it unchanged: identity takes them on every save. */}
        <input type="hidden" name="displayName" value={workspace.name} />
        <input type="hidden" name="description" value={workspace.description ?? ""} />
        <FormField>
          <FieldLabel htmlFor="workspace-billing-email" className="sr-only">
            Billing email
          </FieldLabel>
          <TextInput id="workspace-billing-email" name="billingEmail" type="email" defaultValue={email ?? ""} placeholder="billing@example.com" />
        </FormField>
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton pending="Saving…" match={{ intent: "billing-email" }} variant="outline">
            Save
          </SubmitButton>
          {saved && !busy && !error && (
            <span role="status" className="inline-flex items-center gap-1.5 text-sm text-muted">
              <Check size={14} className="text-success" />
              Saved
            </span>
          )}
          <FieldError>{error}</FieldError>
        </div>
      </Form>
    </section>
  );
}

/**
 * Where the workspace's new repositories keep their git data. Shown only
 * once g1t has EU storage (or to a workspace that already chose it), so
 * nobody is offered a choice that does nothing.
 */
function ResidencySection({ residency, euAvailable, saved, error }: { residency: DataResidency; euAvailable: boolean; saved: boolean; error?: string }) {
  const [choice, setChoice] = useState<DataResidency>(residency);
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formData?.get("intent") === "residency";
  return (
    <section>
      <h2 className="font-medium">Data residency</h2>
      <p className="mt-1.5 text-xs text-faint">
        Where the git data of repositories made from now on is stored. Repositories the workspace already has stay where they are; ask support to move them.
        Work items, pull requests and settings are not affected.
      </p>
      <Form method="post" className="mt-5 space-y-4">
        <input type="hidden" name="intent" value="residency" />
        <RadioGroup name="residency" value={choice} onValueChange={(value) => setChoice(value as DataResidency)} aria-label="Where new repositories are stored">
          <RadioOption value="anywhere" label="Anywhere" description="Wherever g1t stores repositories. The default." />
          <RadioOption
            value="eu"
            label="EU only"
            description={
              euAvailable
                ? "New repositories are stored in the EU, and are not made if EU storage cannot take them."
                : "EU storage cannot take new repositories right now."
            }
            disabled={!euAvailable && residency !== "eu"}
          />
        </RadioGroup>
        <ErrorText>{error}</ErrorText>
        {saved && !error && (
          <p role="status" className="text-xs text-muted">
            Saved.
          </p>
        )}
        <Button type="submit" disabled={saving || choice === residency}>
          Save
        </Button>
      </Form>
    </section>
  );
}

/**
 * Deleting the workspace, with everything in it, in one step. Owners only,
 * as the whole page is; typed out to confirm. It is kept for
 * `WORKSPACE_RESTORE_DAYS`, when support can restore it. A protected
 * workspace says so instead of offering the button.
 */
function DeleteAction({ workspace, deletion, apps, error }: { workspace: Workspace; deletion: WorkspaceDeletion | null; apps: number | null; error?: string }) {
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
        <Button type="button" variant="destructive" disabled={Boolean(refusal)} onClick={() => setOpen(true)}>
          Delete workspace
        </Button>
      }
    >
      {refusal ? (
        <span role="status">{refusal}</span>
      ) : (
        <>
          Everything in it goes with it: repositories, projects, apps, members' access and tokens. It is kept for {WORKSPACE_RESTORE_DAYS} days, and support can
          restore it until then.
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
                Everything in it goes now. For {WORKSPACE_RESTORE_DAYS} days, support can restore all of it; after that it is gone for good.
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
              <li>Anything it owes is charged to its card now, and its plan ends today. Its statements, invoices and audit log are kept.</li>
              <li>
                To get it back within {WORKSPACE_RESTORE_DAYS} days, an owner writes to support. After that its repositories, projects, apps, webhooks,
                integrations and secrets are removed for good.
              </li>
              <li>
                The name <span className="font-mono text-fg">{workspace.slug}</span> is never given to another workspace. Repositories that were transferred out
                keep redirecting from it.
              </li>
              <li>Members keep their own accounts.</li>
            </ul>
            <ConfirmName confirm={workspace.slug} id="confirm-delete" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            <ErrorText>{error}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!confirmsSlug(workspace.slug, confirm) || deleting}>
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
      load(`${settingsPath(workspace.slug)}?check=${encodeURIComponent(wanted)}`);
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
        The workspace's slug: the first part of every page, clone URL and API path under it. Changing it does not change the display name. The old address
        redirects for {SLUG_HOLD_DAYS} days.
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
              <span role="status" className={`mt-1 block ${status.tone === "ok" ? "text-success" : status.tone === "bad" ? "text-danger" : ""}`}>
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
          <Button type="button" variant="outline" disabled={!available} onClick={() => setOpen(true)}>
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
                  Deployed apps move to <span className="font-mono">*.g1t.page</span> addresses with the new name. The old addresses redirect for{" "}
                  {SLUG_HOLD_DAYS} days.
                </li>
                <li>
                  Update your git remotes, for example{" "}
                  <code className="font-mono text-xs break-all text-fg">
                    git remote set-url origin {site}/{wanted}/&lt;repo&gt;.git
                  </code>
                  , and any URLs written into code, API clients and MCP clients.
                </li>
                <li>
                  After {SLUG_HOLD_DAYS} days, anyone can take the name {workspace.slug}.
                </li>
                <li>You can change the address again after {RENAME_COOLDOWN_HOURS} hours.</li>
              </ul>
              <ConfirmName confirm={wanted} id="confirm-slug" name={undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
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
