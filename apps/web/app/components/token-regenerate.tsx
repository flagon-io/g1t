/**
 * Regenerating a token: a new secret for it, everything else kept, the
 * old secret refused from then on. For rotating a token without remaking
 * it, or replacing one that may have leaked. The page's action answers
 * `intent=regenerate` with `{ secret, token }`, shown once by `TokenCreated`.
 */
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { Form } from "react-router";

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
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { SelectField } from "./ui/select";
import { DEFAULT_EXPIRY_DAYS, EXPIRY_DAYS, describeDays } from "../lib/access-tokens";

export function RegenerateToken({ name }: { name: string }) {
  const [expires, setExpires] = useState(String(DEFAULT_EXPIRY_DAYS));
  const options = [...EXPIRY_DAYS.map((days) => ({ value: String(days), label: describeDays(days) })), { value: "never", label: "No expiration" }];
  return (
    <section className="rounded-xl border border-line p-4">
      <h2 className="text-sm font-medium">Regenerate this token</h2>
      <p className="mt-1 text-xs text-muted">
        A new secret, with the same name, permissions and reach. Anything using the old one stops working at once, until you give it the new one.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SelectField aria-label="Expires" className="w-40" value={expires} onValueChange={setExpires} options={options} />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">
              <RefreshCw size={14} />
              Regenerate
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <Form method="post" className="grid gap-4">
              <input type="hidden" name="intent" value="regenerate" />
              <input type="hidden" name="expires" value={expires} />
              <AlertDialogHeader>
                <AlertDialogTitle>Regenerate {name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Its old secret stops working now. The new one is shown once, and{" "}
                  {expires === "never" ? "does not expire" : `expires in ${describeDays(Number(expires))}`}.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction asChild>
                  <button type="submit">Regenerate token</button>
                </AlertDialogAction>
              </AlertDialogFooter>
            </Form>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </section>
  );
}
