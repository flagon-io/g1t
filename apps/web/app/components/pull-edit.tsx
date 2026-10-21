import { Pencil } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Form, useNavigation } from "react-router";

import { MentionTextarea } from "./mention-textarea";
import { SubmitButton } from "./ui";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

/**
 * Edit beside a pull request's title: its title and description, in a
 * dialog. Posts `action=edit`; the work service reads the work items it
 * closes and is part of again. A merged or closed one's text can still be
 * corrected, and what it landed stays as it was.
 */
export function EditPullDialog({ title, body, merged, error }: { title: string; body: string | null; merged: boolean; error?: string | null }) {
  const [open, setOpen] = useState(Boolean(error));
  const navigation = useNavigation();
  const id = useId();
  // Stays open while it saves, and on a refusal; closes once it saved.
  const saving = navigation.state !== "idle" && navigation.formData?.get("action") === "edit";
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (saving) setSent(true);
    else if (sent) {
      setSent(false);
      if (!error) setOpen(false);
    }
  }, [saving, sent, error]);
  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="max-sm:h-11">
          <Pencil size={14} />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="action" value="edit" />
          <DialogHeader>
            <DialogTitle>Edit pull request</DialogTitle>
            <DialogDescription>
              {merged
                ? "It has merged: the work items it landed stay as they were."
                : "The work items it closes (Fixes #12) and is part of (Part of #12) are read again from the title and description."}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input id={`${id}-title`} name="title" defaultValue={title} required maxLength={200} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-body`}>Description</FieldLabel>
            <MentionTextarea id={`${id}-body`} name="body" rows={10} placeholder="What changed and why" defaultValue={body ?? ""} />
            <FieldDescription>Markdown. Leave it empty to take the description away.</FieldDescription>
          </Field>
          <FieldError>{error}</FieldError>
          <DialogFooter>
            <SubmitButton match={{ action: "edit" }} pending="Saving…" className="max-sm:h-11">
              Save
            </SubmitButton>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
