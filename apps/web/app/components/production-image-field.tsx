import { ImageUp, LoaderCircle, Trash2 } from "lucide-react";
import { useRef } from "react";
import { useFetcher } from "react-router";

import type { ProductionImage } from "@g1t/contracts";

import { PRODUCTION_IMAGE_ACCEPT } from "../lib/production-image";
import { ErrorText, SubmitButton, usePending } from "./ui";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { SwitchCard } from "./ui/switch";

/**
 * A project's production image, in its settings: the one shown now, a
 * button to pick a new one (sent as soon as it is picked), a way to remove
 * it, and whether it is shown instead of a screenshot. Posts
 * `intent=production-image` with the file in `image`,
 * `intent=remove-production-image`, or `intent=prefer-production-image`
 * with `preferred`.
 */
export function ProductionImageField({
  image,
  src,
  screenshots,
}: {
  image: ProductionImage | null;
  /** Where the image is served, when there is one. */
  src: string | null;
  /** Whether production gets a screenshot by itself: on g1t.page, or at an address elsewhere. */
  screenshots: boolean;
}) {
  const upload = useFetcher<{ error?: string }>();
  const prefer = useFetcher<{ error?: string }>();
  const form = useRef<HTMLFormElement>(null);
  const uploading = usePending({ intent: "production-image" }, upload);
  const removing = usePending({ intent: "remove-production-image" }, upload);
  const busy = uploading || removing;
  // Shown as asked while it is being saved.
  const preferred = prefer.formData ? prefer.formData.get("preferred") === "on" : (image?.preferred ?? false);
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="aspect-16/10 w-full shrink-0 overflow-hidden rounded-lg border border-line bg-bg sm:w-48">
          {src ? (
            <img src={src} alt="The uploaded image of production" width={1280} height={800} className="size-full object-cover object-top" />
          ) : (
            <div className="flex size-full items-center justify-center text-faint">
              <ImageUp size={20} aria-hidden="true" />
            </div>
          )}
        </div>
        <div className="min-w-0 grow space-y-2">
          <p className="text-sm text-muted">
            {screenshots
              ? "Shown on the overview while there is no screenshot of production, or instead of one."
              : "Shown on the overview's production card. Give production's address, and a screenshot of it is taken by itself."}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <upload.Form method="post" encType="multipart/form-data" ref={form}>
              <input type="hidden" name="intent" value="production-image" />
              <Button asChild variant="outline" className={busy ? "pointer-events-none opacity-50" : "cursor-pointer"}>
                <label>
                  {uploading ? <LoaderCircle size={15} aria-hidden="true" className="animate-spin" /> : <ImageUp size={15} />}
                  {uploading ? "Uploading…" : image ? "Upload a new image" : "Upload an image"}
                  <input
                    type="file"
                    name="image"
                    accept={PRODUCTION_IMAGE_ACCEPT}
                    className="sr-only"
                    onChange={(event) => {
                      if (event.currentTarget.files?.length) form.current?.requestSubmit();
                    }}
                  />
                </label>
              </Button>
            </upload.Form>
            {image && (
              <upload.Form method="post">
                <input type="hidden" name="intent" value="remove-production-image" />
                <SubmitButton fetcher={upload} variant="outline" pending="Removing…" match={{ intent: "remove-production-image" }} disabled={uploading}>
                  <Trash2 size={15} />
                  Remove
                </SubmitButton>
              </upload.Form>
            )}
          </div>
          <p className="text-xs text-faint">PNG, JPEG or WebP, at most 5 MB. Wide images fit best, such as 1280 × 800.</p>
          <ErrorText>{upload.data?.error ?? prefer.data?.error}</ErrorText>
        </div>
      </div>
      {image && screenshots && (
        <SwitchCard
          className="mt-4"
          title="Use the uploaded image instead of a screenshot"
          checked={preferred}
          onCheckedChange={(on) => prefer.submit({ intent: "prefer-production-image", preferred: on ? "on" : "" }, { method: "post" })}
        >
          No screenshot of production is taken while it is on.
        </SwitchCard>
      )}
    </Card>
  );
}
