import { ImageUp, LoaderCircle, Trash2 } from "lucide-react";
import { useRef } from "react";
import { Form } from "react-router";

import { AVATAR_ACCEPT } from "../lib/avatar-upload";
import { Avatar, ErrorText, SubmitButton, usePending } from "./ui";

/**
 * Uploading an avatar, as GitHub's settings do: the one shown now, a
 * button to pick a new image, which is sent as soon as it is picked, and
 * a way back to the letter. Posts `intent=avatar` with the file in
 * `avatar`, or `intent=remove-avatar`.
 */
export function AvatarField({
  name,
  image,
  square,
  error,
  about,
}: {
  /** What the letter avatar is drawn from. */
  name: string;
  image?: string | null;
  square?: boolean;
  error?: string;
  about: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  // Working until the new picture (or the letter) is the one shown.
  const uploading = usePending({ intent: "avatar" });
  const removing = usePending({ intent: "remove-avatar" });
  const busy = uploading || removing;
  return (
    <div className="flex items-start gap-4">
      <Avatar name={name} image={image} size={64} square={square} />
      <div className="min-w-0 space-y-2">
        <p className="text-sm text-muted">{about}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Form method="post" encType="multipart/form-data" ref={form}>
            <input type="hidden" name="intent" value="avatar" />
            <label
              className={`inline-flex cursor-pointer items-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium ring-1 ring-line transition-colors hover:ring-line-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                busy ? "pointer-events-none opacity-50" : ""
              }`}
            >
              {uploading ? (
                <LoaderCircle size={15} aria-hidden="true" className="animate-spin" />
              ) : (
                <ImageUp size={15} />
              )}
              {uploading ? "Uploading…" : image ? "Upload a new image" : "Upload an image"}
              <input
                type="file"
                name="avatar"
                accept={AVATAR_ACCEPT}
                className="sr-only"
                onChange={(event) => {
                  if (event.currentTarget.files?.length) form.current?.requestSubmit();
                }}
              />
            </label>
          </Form>
          {image && (
            <Form method="post">
              <input type="hidden" name="intent" value="remove-avatar" />
              <SubmitButton variant="quiet" pending="Removing…" match={{ intent: "remove-avatar" }} disabled={uploading}>
                <Trash2 size={15} />
                Remove
              </SubmitButton>
            </Form>
          )}
        </div>
        <p className="text-xs text-faint">PNG, JPEG, WebP or GIF, at most 1 MB. Square images look best.</p>
        <ErrorText>{error}</ErrorText>
      </div>
    </div>
  );
}
