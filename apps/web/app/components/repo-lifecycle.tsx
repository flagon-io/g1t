import { Archive } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Form, Link, useNavigation } from "react-router";

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
import { FieldLabel, Field as FormField } from "./ui/field";
import { Input as TextInput } from "./ui/input";
import { confirmsName } from "../lib/repo-lifecycle";

/**
 * A dialog that posts one `intent`, says what will happen as a list, and,
 * when `confirm` is given, asks for that name to be typed first. It opens
 * from `trigger`, and opens by itself again when the action sent back an
 * error, so the error is seen beside what caused it.
 */
export function ConfirmDialog({
  intent,
  fields,
  title,
  description,
  children,
  confirm,
  submit,
  busy,
  error,
  danger = true,
  action,
  trigger,
}: {
  intent: string;
  /** Other hidden fields to post with it. */
  fields?: Record<string, string>;
  title: ReactNode;
  description?: ReactNode;
  /** What happens, as list items. */
  children?: ReactNode;
  /** The name to type, such as `acme/web`; nothing to type when absent. */
  confirm?: string;
  submit: string;
  /** The button's words while it is posting. */
  busy: string;
  error?: string | null;
  danger?: boolean;
  /** Where to post, when not the page's own action. */
  action?: string;
  trigger: (open: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(error));
  const [typed, setTyped] = useState("");
  const navigation = useNavigation();
  const id = useId();
  const posting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === intent &&
    Object.entries(fields ?? {}).every(([k, v]) => navigation.formData?.get(k) === v);
  const ready = confirm == null || confirmsName(typed, confirm);
  return (
    <>
      {trigger(() => setOpen(true))}
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setTyped("");
        }}
      >
        <AlertDialogContent>
          <Form method="post" action={action} className="grid gap-4">
            <input type="hidden" name="intent" value={intent} />
            {Object.entries(fields ?? {}).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
            </AlertDialogHeader>
            {children && <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">{children}</ul>}
            {confirm != null && (
              <FormField>
                <FieldLabel htmlFor={`${id}-confirm`}>
                  Type <span className="font-mono break-all text-fg">{confirm}</span> to confirm
                </FieldLabel>
                <TextInput
                  id={`${id}-confirm`}
                  name="confirm"
                  value={typed}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                  className="font-mono"
                />
              </FormField>
            )}
            <ErrorText>{error}</ErrorText>
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <Button type="submit" variant={danger ? "danger" : "primary"} disabled={!ready || posting}>
                {posting ? busy : submit}
              </Button>
            </AlertDialogFooter>
          </Form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Said across the top of an archived repository's pages: what archived
 * means, and for owners, where to undo it. On its settings pages it says
 * why the settings are turned off.
 */
export function ArchivedBanner({ base, owner, settings }: { base: string; owner: boolean; settings?: boolean }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-sm sm:flex-row sm:items-start sm:justify-between"
    >
      <p className="flex gap-2.5">
        <Archive size={16} className="mt-0.5 shrink-0 text-warn" />
        <span>
          <span className="font-medium text-fg">This repository is archived.</span>{" "}
          <span className="text-muted">
            {settings
              ? "It is read-only, so settings that change it are turned off until it is unarchived."
              : "It is read-only: pushes and merges are refused, issues and pull requests are locked, and agents and workflows do not run. Its deployments keep serving."}
          </span>
        </span>
      </p>
      {owner && (
        <Link
          to={`${base}/settings/repository#danger-zone`}
          className="shrink-0 pl-6.5 font-medium text-warn hover:underline sm:pl-0"
        >
          Unarchive
        </Link>
      )}
    </div>
  );
}
