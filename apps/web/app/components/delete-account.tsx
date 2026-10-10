import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import { ACCOUNT_RESTORE_DAYS, type AccountDeletion } from "@g1t/contracts";

import { DangerAction } from "./danger-zone";
import { Button, ErrorText } from "./ui";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { FieldDescription, FieldLabel, Field as FormField } from "./ui/field";
import { Input as TextInput } from "./ui/input";
import { accountDeletionRefusal, confirmsUsername, whatAccountDeletionTakes } from "../lib/account-deletion";

/**
 * Deleting your account, in one step, typed out to confirm, with your
 * password unless you signed in within the last few minutes. Kept for
 * `ACCOUNT_RESTORE_DAYS`, when support can restore it. Workspaces you own
 * alone are listed instead of the button until they have another owner or
 * are deleted.
 */
export function DeleteAccountAction({
  username,
  deletion,
  hasPassword,
  error,
  defaultOpen = false,
}: {
  username: string;
  deletion: AccountDeletion | null;
  hasPassword: boolean;
  error?: string;
  /** Open on first render: for previews of the dialog. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(error) || defaultOpen);
  const [confirm, setConfirm] = useState("");
  const navigation = useNavigation();
  const deleting = navigation.state !== "idle" && navigation.formData?.get("intent") === "delete-account";
  const refusal = accountDeletionRefusal(deletion);
  const goes = deletion ? whatAccountDeletionTakes(deletion) : [];
  if (deletion?.protected) {
    return (
      <DangerAction title="Delete your account" action={null}>
        <span role="status">{refusal}</span>
      </DangerAction>
    );
  }
  return (
    <DangerAction
      title="Delete your account"
      action={
        <Button type="button" variant="danger" disabled={Boolean(refusal)} onClick={() => setOpen(true)}>
          Delete account
        </Button>
      }
    >
      {refusal ? (
        <>
          <span role="status">{refusal}</span>
          <ul className="mt-3 space-y-2">
            {deletion?.sole_owner_of.map((workspace) => (
              <li key={workspace.slug} className="rounded-lg border border-line bg-surface px-3 py-2">
                <p className="text-fg">
                  <span className="font-medium">{workspace.name}</span>{" "}
                  <span className="font-mono text-xs text-faint">{workspace.slug}</span>
                </p>
                <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {workspace.members > 1 ? (
                    <Link to={`/${workspace.slug}/-/members`} className="text-accent underline-offset-4 hover:underline">
                      Make someone else an owner
                    </Link>
                  ) : null}
                  <Link to={`/${workspace.slug}/-/settings`} className="text-accent underline-offset-4 hover:underline">
                    Delete the workspace
                  </Link>
                </p>
                {workspace.billing ? <p className="mt-1 text-xs text-warn">{workspace.billing}</p> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          You sign out everywhere and leave every workspace at once. Your account is kept for {ACCOUNT_RESTORE_DAYS}{" "}
          days, and support can restore it until then.
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
            <input type="hidden" name="intent" value="delete-account" />
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything you sign in with stops working now. For {ACCOUNT_RESTORE_DAYS} days, support can restore
                your account; after that it is gone for good.
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
              <li>You are signed out everywhere. Your access tokens, SSH keys, deploy keys you added and applications stop working.</li>
              <li>You leave every workspace, team and repository. Workspaces you share keep everything in them.</li>
              <li>Your profile is no longer found, and nobody can add you to anything.</li>
              <li>
                To get it back within {ACCOUNT_RESTORE_DAYS} days, write to support from one of its addresses. After
                that your addresses, keys, profile and settings are removed for good.
              </li>
              <li>
                What you wrote stays where it is: issues, pull requests, comments and reviews show as{" "}
                <span className="font-mono text-fg">ghost</span> once it is removed.
              </li>
              <li>
                The username <span className="font-mono text-fg">{username}</span> is never given to anyone else.
              </li>
            </ul>
            <FormField>
              <FieldLabel htmlFor="confirm-account">
                Type <span className="font-mono text-fg">{username}</span> to confirm
              </FieldLabel>
              <TextInput
                id="confirm-account"
                name="confirm"
                value={confirm}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(event) => setConfirm(event.target.value)}
                className="font-mono"
              />
            </FormField>
            {hasPassword ? (
              <FormField>
                <FieldLabel htmlFor="confirm-password">Your password</FieldLabel>
                <TextInput id="confirm-password" name="password" type="password" autoComplete="current-password" />
                <FieldDescription>Not needed if you signed in within the last 10 minutes.</FieldDescription>
              </FormField>
            ) : (
              <p className="text-sm text-muted">
                Your account signs in with GitHub only: sign out, sign in with GitHub again, and delete it within 10
                minutes.
              </p>
            )}
            <ErrorText>{error}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant="danger" disabled={!confirmsUsername(username, confirm) || deleting}>
                {deleting ? "Deleting…" : "Delete account"}
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </DangerAction>
  );
}
