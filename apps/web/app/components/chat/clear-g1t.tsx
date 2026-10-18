import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

/**
 * Confirms clearing your conversation with @g1t (docs.g1t.sh/guides/ask/,
 * "Clear the conversation"): the Ask panel's menu, the direct message's
 * menu in Chat, and `/clear` typed in either open it. `onClear` deletes
 * it; the dialog stays open, saying what went wrong, if that fails.
 */
export function ClearG1tDialog({
  open,
  onOpenChange,
  onClear,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Clears it: null when done, else what went wrong. */
  onClear: () => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setError(null);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear your conversation with g1t?</AlertDialogTitle>
          <AlertDialogDescription>
            Everything you and g1t said is deleted for good, in Ask and in Chat: your questions, g1t&apos;s answers with their steps and sources, and the
            notifications they sent you. g1t won&apos;t remember any of it. An answer still coming is stopped and thrown away. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // Closed only once it is done.
              event.preventDefault();
              setBusy(true);
              setError(null);
              void onClear().then((problem) => {
                setBusy(false);
                if (problem) setError(problem);
                else onOpenChange(false);
              });
            }}
          >
            {busy ? "Clearing…" : "Clear conversation"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
