import { ImagePlus, LoaderCircle } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ATTACHMENT_ACCEPT,
  DEFERRED_FILE_FIELD,
  DEFERRED_REF_FIELD,
  caretAfter,
  deferredUrl,
  dragsFiles,
  imageMarkdown,
  imageName,
  insertion,
  pastedImages,
  placeholderFor,
  placeholderRange,
  refusal,
  uploadFailure,
} from "../lib/attachments";
import { Button } from "./ui/button";

/**
 * Where the comment boxes inside keep the images put in them: a
 * repository (its pull requests, commits, and work items filed from it),
 * a work item, or `later` for a work item not open yet with no repository
 * to keep them (they go with the form, and the work item keeps them once
 * it is open, as `g1t work new --attach` does).
 */
export type AttachTo = { repo: string } | { workspace: string; number: number } | "later";

const AttachContext = createContext<AttachTo | null>(null);

/** Comment boxes inside take images, kept by `to` (lib/attachments.ts). */
export function AttachImages({ to, children }: { to: AttachTo | null; children: ReactNode }) {
  return <AttachContext.Provider value={to}>{children}</AttachContext.Provider>;
}

function endpoint(to: Exclude<AttachTo, "later">, name: string): string {
  const query = new URLSearchParams("repo" in to ? { repo: to.repo } : { workspace: to.workspace, number: String(to.number) });
  query.set("name", name);
  return `/-/attachments?${query}`;
}

/**
 * Puts `text` in for `start`..`end` and tells the box it changed. At the
 * caret (`end`), it keeps the browser's undo when the box is focused;
 * elsewhere (`keep`), the person's caret or selection stays where it was
 * in what they wrote.
 */
function put(box: HTMLTextAreaElement, text: string, start: number, end: number, select: "end" | "keep") {
  if (select === "end") {
    if (document.activeElement === box) {
      box.setSelectionRange(start, end);
      // Deprecated but still the one way to keep the edit undoable; falls back below.
      if (document.execCommand?.("insertText", false, text)) return;
    }
    box.setRangeText(text, start, end, "end");
  } else {
    const [from, to, direction] = [box.selectionStart, box.selectionEnd, box.selectionDirection];
    box.setRangeText(text, start, end);
    box.setSelectionRange(caretAfter(from, start, end, text.length), caretAfter(to, start, end, text.length), direction ?? undefined);
  }
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Paste, drop or choose images in the comment box `ref`, GitHub's way:
 * each puts `![Uploading name…]()` at the caret while it uploads, and that
 * placeholder alone becomes `![name](url)`, wherever the person's writing
 * has moved it. Its form can't be sent while one is uploading. Nothing
 * outside an `<AttachImages>` takes images.
 */
export function useImageAttach(ref: RefObject<HTMLTextAreaElement | null>) {
  const to = useContext(AttachContext);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // A work item not open yet: its images, by the ref their Markdown holds.
  const [later, setLater] = useState<{ ref: string; file: File }[]>([]);
  const filesInput = useRef<HTMLInputElement>(null);
  const chooser = useRef<HTMLInputElement>(null);

  const attach = useCallback(
    (files: readonly File[]) => {
      const box = ref.current;
      if (!box || !to) return;
      const refused: string[] = [];
      for (const file of files) {
        const why = refusal(file);
        if (why) {
          refused.push(why);
          continue;
        }
        const name = imageName(file);
        if (to === "later") {
          const id = Math.random().toString(36).slice(2, 10);
          const at = insertion(box.value, box.selectionStart, box.selectionEnd, imageMarkdown(name, deferredUrl(id)));
          put(box, at.text, at.start, at.end, "end");
          setLater((held) => [...held, { ref: id, file }]);
          continue;
        }
        const placeholder = placeholderFor(name, box.value);
        const at = insertion(box.value, box.selectionStart, box.selectionEnd, placeholder);
        put(box, at.text, at.start, at.end, "end");
        setUploading((count) => count + 1);
        void (async () => {
          let replacement = "";
          let failed: string | null = null;
          try {
            const answer = await fetch(endpoint(to, name), { method: "POST", body: file, headers: { "content-type": file.type } });
            const body = (await answer.json().catch(() => null)) as
              | { ok: true; markdown: string }
              | { ok: false; error: { code: string; message: string } }
              | null;
            if (body?.ok) replacement = body.markdown;
            else failed = uploadFailure(name, body && !body.ok ? body.error : null);
          } catch {
            failed = `${name} didn't upload. Check your connection and try again.`;
          }
          const now = ref.current;
          const range = now && placeholderRange(now.value, placeholder, replacement);
          if (now && range) put(now, replacement, range.start, range.end, "keep");
          // Beside any other refusal from the same paste or drop, not over it.
          if (failed) setError((shown) => (shown ? `${shown} ${failed}` : failed));
          setUploading((count) => count - 1);
        })();
      }
      setError(refused.length ? refused.join(" ") : null);
    },
    [ref, to],
  );

  // While an image uploads, the form waits: its buttons are off, and a
  // submit some other way (Enter in a field) is held back.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form || uploading === 0) return;
    const hold = (event: SubmitEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setError("Wait for the image to finish uploading, then send it.");
    };
    form.addEventListener("submit", hold, { capture: true });
    const buttons = [...form.querySelectorAll<HTMLButtonElement>("button[type=submit]:not(:disabled)")];
    for (const button of buttons) button.disabled = true;
    return () => {
      form.removeEventListener("submit", hold, { capture: true });
      for (const button of buttons) button.disabled = false;
    };
  }, [ref, uploading]);

  // A work item not open yet: the images held go with the form, those
  // whose Markdown is still in the box (the action checks again).
  useEffect(() => {
    const input = filesInput.current;
    if (!input || typeof DataTransfer === "undefined") return;
    const files = new DataTransfer();
    for (const held of later) files.items.add(held.file);
    input.files = files.files;
  }, [later]);

  if (!to) return null;

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    if (!data) return;
    const files = [...data.items].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => file != null);
    const images = pastedImages({ files, text: data.getData("text/plain") });
    if (images.length === 0) return;
    event.preventDefault();
    attach(images);
  };
  const onDragOver = (event: DragEvent<HTMLTextAreaElement>) => {
    if (!dragsFiles([...event.dataTransfer.types])) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    setDragging(false);
    if (!dragsFiles([...event.dataTransfer.types])) return;
    event.preventDefault();
    const box = ref.current;
    // Where the drop landed is where the caret is, as the browser placed it on dragover.
    box?.focus();
    attach([...event.dataTransfer.files]);
  };

  const footer = (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
      <Button
        type="button"
        variant="ghost"
        size="inline"
        className="gap-1 rounded px-1 py-0.5 text-xs font-normal text-faint hover:text-fg max-sm:min-h-9"
        onClick={() => chooser.current?.click()}
      >
        <ImagePlus size={14} aria-hidden="true" />
        Attach an image
      </Button>
      <span className="max-sm:hidden">or paste or drop one in. PNG, JPEG, GIF or WebP, up to 10 MB.</span>
      <input
        ref={chooser}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          ref.current?.focus();
          attach(files);
        }}
      />
      {to === "later" && (
        <>
          <input ref={filesInput} type="file" name={DEFERRED_FILE_FIELD} multiple hidden tabIndex={-1} aria-hidden="true" />
          {later.map((held) => (
            <input key={held.ref} type="hidden" name={DEFERRED_REF_FIELD} value={held.ref} />
          ))}
          {later.length > 0 && <span>{later.length === 1 ? "The image uploads" : "The images upload"} when you open the work item.</span>}
        </>
      )}
      <span aria-live="polite" className="contents">
        {uploading > 0 && (
          <span className="flex items-center gap-1 text-muted">
            <LoaderCircle size={12} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            Uploading {uploading === 1 ? "an image" : `${uploading} images`}…
          </span>
        )}
      </span>
      {error && (
        <p role="alert" className="basis-full text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );

  return { onPaste, onDragOver, onDragLeave, onDrop, dragging, footer };
}
