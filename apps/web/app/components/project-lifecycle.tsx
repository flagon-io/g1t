import { useState } from "react";
import { Form, useNavigation } from "react-router";

import { RESTORE_DAYS } from "@g1t/contracts";

import { ConfirmName } from "./confirm-name";
import { DangerAction, DangerZone } from "./danger-zone";
import { ConfirmDialog } from "./repo-lifecycle";
import { ErrorText } from "./ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { FieldLabel, Field as FormField } from "./ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { confirmsName } from "../lib/repo-lifecycle";

/** The intents General's action takes from these forms. */
export const LIFECYCLE_INTENTS = ["archive", "transfer", "delete"] as const;
export type LifecycleIntent = (typeof LIFECYCLE_INTENTS)[number];

/**
 * The end of General: archiving, moving or deleting the project, its
 * repository with it. `remove` says whether this person may transfer and
 * delete (owners, unless member privileges let Admins).
 */
export function ProjectDangerZone({
  full,
  archived,
  remove,
  destinations,
  error,
}: {
  full: string;
  archived: boolean;
  remove: boolean;
  destinations: { slug: string; name: string }[];
  error: (intent: LifecycleIntent) => string | null;
}) {
  return (
    <div id="danger-zone" className="mt-10 scroll-mt-20 border-t border-line pt-8">
      <DangerZone>
        <ArchiveAction full={full} archived={archived} error={error("archive")} />
        {remove && <TransferAction repo={full} destinations={destinations} error={error("transfer")} />}
        {remove && <DeleteAction full={full} error={error("delete")} />}
      </DangerZone>
      {!remove && (
        <p className="mt-4 text-sm text-muted">
          Only an owner of the workspace can transfer or delete it: its member privileges keep that to owners.
        </p>
      )}
    </div>
  );
}

/** Read-only, or back to normal. */
function ArchiveAction({ full, archived, error }: { full: string; archived: boolean; error: string | null }) {
  return (
    <ConfirmDialog
      intent="archive"
      fields={{ archived: archived ? "false" : "true" }}
      title={archived ? `Unarchive ${full}?` : `Archive ${full}?`}
      description={archived ? "It goes back to working as before." : "It becomes read-only. You can unarchive it at any time."}
      submit={archived ? "Unarchive" : "Archive"}
      busy={archived ? "Unarchiving…" : "Archiving…"}
      danger={!archived}
      error={error}
      trigger={(open) => (
        <DangerAction
          title={archived ? "Unarchive this project" : "Archive this project"}
          action={
            <Button type="button" variant="destructive" onClick={open}>
              {archived ? "Unarchive" : "Archive"}
            </Button>
          }
        >
          {archived
            ? "It is archived and its repository read-only. Unarchiving lets pushes, merges and workflows work again."
            : "Make its repository read-only: everything stays where it is and can be read, and nothing changes it."}
        </DangerAction>
      )}
    >
      {archived ? (
        <>
          <li>Pushes and merges are accepted again.</li>
          <li>Issues and pull requests unlock.</li>
          <li>Workflows run again.</li>
        </>
      ) : (
        <>
          <li>Pushes and merges are refused, for everyone.</li>
          <li>Issues and pull requests are locked. They stay readable.</li>
          <li>Workflows do not run.</li>
          <li>Its deployments keep serving, and anyone who could see it still can.</li>
        </>
      )}
    </ConfirmDialog>
  );
}

/** Deleting: hidden at once, restorable for a while, then gone. */
function DeleteAction({ full, error }: { full: string; error: string | null }) {
  const namespace = full.split("/")[0];
  return (
    <ConfirmDialog
      intent="delete"
      title={`Delete ${full}?`}
      description={`You can restore it for ${RESTORE_DAYS} days.`}
      confirm={full}
      submit="Delete project"
      busy="Deleting…"
      error={error}
      trigger={(open) => (
        <DangerAction
          title="Delete this project"
          action={
            <Button type="button" variant="destructive" onClick={open}>
              Delete
            </Button>
          }
        >
          Its repository goes with it. It can be restored from the workspace's repositories for {RESTORE_DAYS} days, then
          it is removed for good.
        </DangerAction>
      )}
    >
      <li>
        It disappears at once with its repository: its pages, git remote and API stop answering, for everyone, and its
        apps on g1t.page stop serving.
      </li>
      <li>
        Owners can restore it, as it was, from <span className="font-mono text-fg">{namespace}</span>'s Recently deleted
        repositories for {RESTORE_DAYS} days, custom domains and settings included. After that it is removed for good,
        its git data with it.
      </li>
      <li>Its name stays taken until then, so nothing else can be made at its address.</li>
    </ConfirmDialog>
  );
}

/**
 * Moving the project, with its repository, to another workspace the person
 * may create one in. The dialog says what moves and what changes, and asks
 * for the full name.
 */
function TransferAction({
  repo,
  destinations,
  error,
}: {
  repo: string;
  destinations: { slug: string; name: string }[];
  error: string | null;
}) {
  const [open, setOpen] = useState(Boolean(error));
  const [to, setTo] = useState(destinations[0]?.slug ?? "");
  const [confirm, setConfirm] = useState("");
  const navigation = useNavigation();
  const moving = navigation.state !== "idle" && navigation.formData?.get("intent") === "transfer";
  const name = repo.split("/")[1];
  return (
    <DangerAction
      title="Transfer this project"
      action={
        <Button type="button" variant="destructive" disabled={destinations.length === 0} onClick={() => setOpen(true)}>
          Transfer
        </Button>
      }
    >
      {destinations.length === 0 ? (
        <>Move it to another workspace you own. You own no other workspace yet.</>
      ) : (
        <>Move it, with its repository, to another workspace you own. Its old address keeps redirecting.</>
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
            <input type="hidden" name="intent" value="transfer" />
            <AlertDialogHeader>
              <AlertDialogTitle>Transfer {repo}</AlertDialogTitle>
              <AlertDialogDescription>
                It keeps its name and moves with everything in it: code, issues, pull requests, workflow runs,
                deployments, and its own secrets, variables and webhooks.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <FormField>
              <FieldLabel htmlFor="transfer-to">New workspace</FieldLabel>
              <Select name="to" value={to} onValueChange={setTo}>
                <SelectTrigger id="transfer-to" aria-label="New workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((d) => (
                    <SelectItem key={d.slug} value={d.slug}>
                      {d.name === d.slug ? d.slug : `${d.name} (${d.slug})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
              <li>
                It moves to <span className="font-mono break-all text-fg">g1t.sh/{to}/{name}</span>. Links, git remotes
                and API calls to <span className="font-mono break-all">g1t.sh/{repo}</span> redirect there until a
                repository is made at the old address.
              </li>
              <li>
                Apps it deploys move to <span className="font-mono">*.g1t.page</span> names with the new workspace; the
                old ones redirect for 90 days. Custom domains follow.
              </li>
              <li>The old workspace's secrets, webhooks and integrations stop reaching it; the new one's start.</li>
              <li>Usage from now on is charged to {to}. What it used before stays on the old workspace's bill.</li>
            </ul>
            <ConfirmName confirm={repo} id="transfer-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            <ErrorText>{error}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!to || !confirmsName(confirm, repo) || moving}>
                {moving ? "Transferring…" : "Transfer"}
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </DangerAction>
  );
}
