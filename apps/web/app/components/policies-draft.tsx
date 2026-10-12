import { CONTACT, POLICIES_DRAFT } from "../lib/legal";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

/** The note at the top of the policies while they are drafts (`POLICIES_DRAFT`). */
export function PoliciesDraft() {
  if (!POLICIES_DRAFT) return null;
  return (
    <Alert tone="warn" className="mb-8 max-w-3xl">
      <AlertTitle>Draft</AlertTitle>
      <AlertDescription>
        These policies are still being written and may change before g1t's general launch. Questions:{" "}
        <a className="text-accent hover:underline" href={`mailto:${CONTACT.legal}`}>
          {CONTACT.legal}
        </a>
        .
      </AlertDescription>
    </Alert>
  );
}
