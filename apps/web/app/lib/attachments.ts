/**
 * Images pasted, dropped or chosen in a comment box, as GitHub does it: an
 * `![Uploading name…]()` placeholder goes in at the caret while the image
 * uploads, and is swapped for `![name](url)` when it is kept. The work
 * service keeps it (`upload_attachment`, crates/contracts/src/attachments.rs)
 * and the usercontent origin serves it. This is the part with no DOM, so it
 * can be tested under Node: which pastes upload, the placeholder's text and
 * where it goes, and what a refusal says.
 */

/** As `MAX_ATTACHMENT_BYTES` in the contracts: 10 MB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** What an attachment may be, as the work service reads it from the bytes. */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** What the Attach an image control offers to pick. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_TYPES.join(",");

/** The form field a box that uploads later (a new work item with no repository) sends its images in. */
export const DEFERRED_FILE_FIELD = "attachment";
/** With each of those, the reference its Markdown holds: `![name](attachment:<ref>)`. */
export const DEFERRED_REF_FIELD = "attachmentRef";

/** What an attachment is about to be: as much of a `File` as these need. */
export type ImageFile = { name: string; type: string; size: number };

/** What the clipboard holds, as much of a `DataTransfer` as the choice needs. */
export type Clipboard<T extends ImageFile = ImageFile> = {
  /** Its files, from its items of kind `file`. */
  files: readonly T[];
  /** `getData("text/plain")`. */
  text: string;
};

/**
 * The images a paste uploads, or none for the browser to paste as it
 * always does. Only when the clipboard holds image files and no plain
 * text: a screenshot, or an image copied from a page (which comes with
 * its HTML but no text). A spreadsheet's cells or a document's paragraphs
 * come with a picture of themselves too, and paste as their text.
 */
export function pastedImages<T extends ImageFile>(clipboard: Clipboard<T>): T[] {
  if (clipboard.text.trim() !== "") return [];
  return clipboard.files.filter((file) => file.type.startsWith("image/"));
}

/** Whether something dragged over the box carries files. */
export function dragsFiles(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** Why an image will not be attached, before it is sent; null when it may go. */
export function refusal(file: ImageFile): string | null {
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type.toLowerCase())) {
    return `${file.name || "That file"} isn't a PNG, JPEG, GIF or WebP image, so it wasn't attached.`;
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name || "That image"} is over 10 MB, so it wasn't attached.`;
  if (file.size === 0) return `${file.name || "That image"} is empty, so it wasn't attached.`;
  return null;
}

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** A file's name as its alt text: its own, or `image.png` for a pasted one that has none. */
export function imageName(file: ImageFile): string {
  const own = file.name.split(/[/\\]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  return own || `image.${EXTENSIONS[file.type.toLowerCase()] ?? "png"}`;
}

/** A name as Markdown alt text: its brackets and backslashes escaped, as the contracts' `attachment_markdown`. */
export function altText(name: string): string {
  return name.replace(/[[\]\\]/g, (c) => `\\${c}`);
}

/** The Markdown that shows an attachment. */
export function imageMarkdown(name: string, url: string): string {
  return `![${altText(name)}](${url})`;
}

/**
 * The placeholder for an image while it uploads, one no other in `text`
 * is: a second `image.png` is `image.png (2)`, so each is replaced by its
 * own upload alone.
 */
export function placeholderFor(name: string, text: string): string {
  for (let n = 1; ; n++) {
    const shown = n === 1 ? name : `${name} (${n})`;
    const candidate = `![Uploading ${altText(shown)}…]()`;
    if (!text.includes(candidate)) return candidate;
  }
}

/** Text put in at `start`..`end`, and where the caret goes after it. */
export type Insertion = { text: string; start: number; end: number; caret: number };

/**
 * How `markdown` goes in at the selection `start`..`end` of `value`: on a
 * line of its own, as an image is shown, with a line break added before
 * or after it only where the text beside it needs one.
 */
export function insertion(value: string, start: number, end: number, markdown: string): Insertion {
  const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
  const after = end < value.length && value[end] !== "\n" ? "\n" : "";
  const text = `${before}${markdown}${after}`;
  return { text, start, end, caret: start + before.length + markdown.length };
}

/**
 * What of `value` to replace to swap `placeholder` for `replacement`,
 * found where it is now (the person may have written around it); an
 * empty replacement takes the placeholder's line with it when it was
 * alone there. Null when it is gone (they deleted it), so nothing they
 * wrote is touched.
 */
export function placeholderRange(value: string, placeholder: string, replacement: string): { start: number; end: number } | null {
  let start = value.indexOf(placeholder);
  if (start < 0) return null;
  let end = start + placeholder.length;
  if (replacement === "" && (start === 0 || value[start - 1] === "\n") && value[end] === "\n") end += 1;
  else if (replacement === "" && value[start - 1] === "\n" && end === value.length) start -= 1;
  return { start, end };
}

/**
 * Where a caret at `at` belongs once `start`..`end` became `length`
 * characters: where it was before them, as far along after them, and at
 * the end of them from inside (or right at the end of a placeholder, where
 * a paste leaves it), so nothing is left selected to type over.
 */
export function caretAfter(at: number, start: number, end: number, length: number): number {
  if (at <= start) return at;
  if (at > end) return at + length - (end - start);
  return start + length;
}

/** `value` with `placeholder` replaced by `replacement`, as {@link placeholderRange} finds it. */
export function replacePlaceholder(value: string, placeholder: string, replacement: string): string {
  const at = placeholderRange(value, placeholder, replacement);
  return at ? value.slice(0, at.start) + replacement + value.slice(at.end) : value;
}

/** A refusal from the upload route (the work service's code and message), as the box says it. */
export function uploadFailure(name: string, failure: { code?: string; message?: string } | null): string {
  switch (failure?.code) {
    case "too_large":
      return `${name} is over 10 MB, so it wasn't attached.`;
    case "unsupported_type":
      return `${name} isn't a PNG, JPEG, GIF or WebP image, so it wasn't attached.`;
    case "forbidden":
    case "not_found":
    case "unauthenticated":
      return `You can't attach images here, so ${name} wasn't attached.`;
    default:
      return failure?.message ? `${name} wasn't attached: ${failure.message}` : `${name} didn't upload. Try again in a moment.`;
  }
}

/**
 * The reference a deferred image's Markdown holds until it is uploaded:
 * `attachment:<ref>`, a short random word so two never meet.
 */
export function deferredUrl(ref: string): string {
  return `attachment:${ref}`;
}

/**
 * `body` with each deferred image's `attachment:<ref>` swapped for the
 * address it was given; one with no address (its upload failed) is taken
 * out, image and all.
 */
export function resolveDeferred(body: string, urls: ReadonlyMap<string, string | null>): string {
  return body.replace(/!\[((?:\\.|[^\]\\])*)\]\(attachment:([A-Za-z0-9_-]{1,64})\)\n?/g, (whole, alt: string, ref: string) => {
    if (!urls.has(ref)) return whole;
    const url = urls.get(ref);
    return url ? `![${alt}](${url})${whole.endsWith("\n") ? "\n" : ""}` : "";
  });
}

/** The refs a body still holds, so an image whose Markdown was deleted is not uploaded. */
export function deferredRefs(body: string): Set<string> {
  return new Set([...body.matchAll(/\]\(attachment:([A-Za-z0-9_-]{1,64})\)/g)].map((match) => match[1]!));
}
