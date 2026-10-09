import { ImagePlus, Lock, Plus, Search, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { type CustomEmoji, type EmojiList, type EmojiUpload, MAX_EMOJI_BYTES, MAX_EMOJI_SIDE } from "@g1t/contracts";

import { EmojiProvider, forgetCustomEmoji } from "./context";
import { loadEmojiData } from "./data";
import { CustomEmojiImage } from "./render";
import { MemberAvatar } from "../chat/marks";
import { Button, EmptyState, ErrorText, TimeAgo, notACredential } from "../ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Hint } from "../ui/hint";
import { cleanEmojiName, emojiNameProblem, standardCodes } from "../../lib/emoji";

/** What the page's action answers (routes/workspace/emoji.tsx). */
export type EmojiActionResult = { ok: true; intent: string } | { ok: false; intent: string; error: string };

/** What an image may be: as the chat service checks, by its bytes. */
const ACCEPT = "image/png,image/gif,image/webp";

/**
 * A workspace's own emoji: every one with its name, who added it and when;
 * adding one from an image, giving one another name, and removing them.
 * Owners also choose who may add them.
 */
export function EmojiSettings({ slug, list, usercontent, meId }: { slug: string; list: EmojiList; usercontent: string; meId: string }) {
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [aliasing, setAliasing] = useState(false);
  const shown = useMemo(() => {
    const q = cleanEmojiName(query);
    return q ? list.emoji.filter((e) => e.name.includes(q) || e.alias_of?.includes(q)) : list.emoji;
  }, [list.emoji, query]);
  const taken = useMemo(() => new Set(list.emoji.map((e) => e.name)), [list.emoji]);
  useEffect(() => forgetCustomEmoji(slug), [slug, list.emoji]);

  return (
    <EmojiProvider value={{ customs: list.emoji, usercontent, me: null }}>
      <div className="space-y-8">
        <div>
          <p className="max-w-2xl text-sm text-muted">
            Emoji everyone in {slug} can use in messages and reactions, as <code className="font-mono text-fg-soft">:name:</code>. Images are PNG, GIF or
            WebP, up to {MAX_EMOJI_BYTES / 1024} KB and {MAX_EMOJI_SIDE}×{MAX_EMOJI_SIDE} pixels; square ones look best.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block sm:w-72">
            <span className="sr-only">Find an emoji</span>
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an emoji"
              {...notACredential()}
              className="w-full rounded-md border border-line bg-bg py-1.5 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
            />
          </label>
          {list.can_upload ? (
            <div className="flex gap-2">
              {list.emoji.length > 0 && (
                <Button variant="quiet" onClick={() => setAliasing(true)}>
                  Add an alias
                </Button>
              )}
              <Button variant="accent" onClick={() => setAdding(true)}>
                <Plus size={15} />
                Add emoji
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Lock size={13} className="shrink-0 text-faint" />
              Only owners can add emoji in this workspace.
            </p>
          )}
        </div>

        {list.emoji.length === 0 ? (
          <EmptyState title="No emoji of your own yet">
            <ImagePlus size={20} className="mx-auto mb-2 text-faint" />
            Add your team’s logo, a mascot or an inside joke, and use it as <code className="font-mono">:name:</code> anywhere in chat.
          </EmptyState>
        ) : (
          <section aria-label="Emoji">
            <h2 className="mb-3 text-sm font-medium text-muted">
              {query ? "Matching" : "All emoji"} <span className="text-faint">{shown.length}</span>
            </h2>
            {shown.length === 0 ? (
              <p className="rounded-xl border border-line px-4 py-8 text-center text-sm text-muted">No emoji match “{query}”.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {shown.map((emoji) => (
                  <EmojiCard key={emoji.name} slug={slug} emoji={emoji} usercontent={usercontent} removable={list.can_manage || (emoji.created_by.kind === "user" && emoji.created_by.id === meId)} />
                ))}
              </ul>
            )}
          </section>
        )}

        {list.can_manage && <UploadSetting value={list.emoji_upload} />}
      </div>
      <UploadDialog open={adding} onOpenChange={setAdding} taken={taken} />
      <AliasDialog open={aliasing} onOpenChange={setAliasing} emoji={list.emoji} taken={taken} usercontent={usercontent} />
    </EmojiProvider>
  );
}

function EmojiCard({ slug, emoji, usercontent, removable }: { slug: string; emoji: CustomEmoji; usercontent: string; removable: boolean }) {
  const fetcher = useFetcher<EmojiActionResult>();
  const [confirm, setConfirm] = useState(false);
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.data?.ok) forgetCustomEmoji(slug);
  }, [fetcher.data, slug]);
  return (
    <li className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg">
        <CustomEmojiImage name={emoji.name} file={emoji.file} usercontent={usercontent} size={32} />
      </span>
      <div className="min-w-0 grow">
        <p className="truncate font-mono text-sm text-fg">:{emoji.name}:</p>
        <p className="flex min-w-0 items-center gap-1.5 truncate text-xs text-faint">
          {emoji.alias_of ? (
            <span className="truncate">
              Alias of <span className="font-mono text-muted">:{emoji.alias_of}:</span>
            </span>
          ) : (
            <>
              <MemberAvatar member={emoji.created_by} size={14} />
              <span className="truncate">{emoji.created_by.display_name || emoji.created_by.name}</span>
              <span aria-hidden>·</span>
              <TimeAgo at={emoji.created_at} />
            </>
          )}
        </p>
        {fetcher.data && !fetcher.data.ok && <p className="mt-0.5 text-xs text-danger">{fetcher.data.error}</p>}
      </div>
      {removable &&
        (confirm ? (
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-fg">
              Keep
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => fetcher.submit({ intent: "remove", name: emoji.name }, { method: "post" })}
              className="rounded-md bg-danger/15 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/25 disabled:opacity-60"
            >
              {busy ? "Removing…" : emoji.alias_of ? "Remove" : "Remove with aliases"}
            </button>
          </div>
        ) : (
          <Hint label={`Remove :${emoji.name}:`}>
            <button
              type="button"
              aria-label={`Remove :${emoji.name}:`}
              onClick={() => setConfirm(true)}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint opacity-100 transition hover:bg-raised hover:text-danger sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
            >
              <Trash2 size={15} />
            </button>
          </Hint>
        ))}
    </li>
  );
}

/** Owners: who may add emoji. */
function UploadSetting({ value }: { value: EmojiUpload }) {
  const fetcher = useFetcher<EmojiActionResult>();
  const current = (fetcher.formData?.get("value") as EmojiUpload | null) ?? value;
  const choices: { value: EmojiUpload; label: string; detail: string }[] = [
    { value: "members", label: "Every member", detail: "Anyone in the workspace can add emoji and aliases." },
    { value: "admins", label: "Owners only", detail: "Members use the workspace’s emoji; only owners add them." },
  ];
  return (
    <section aria-labelledby="emoji-upload" className="rounded-xl border border-line p-4">
      <h2 id="emoji-upload" className="text-sm font-medium text-fg">
        Who can add emoji
      </h2>
      <p className="mt-1 text-xs text-muted">Whoever added an emoji, and owners, can remove it.</p>
      <div role="radiogroup" aria-labelledby="emoji-upload" className="mt-3 grid gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            role="radio"
            aria-checked={current === choice.value}
            onClick={() => current !== choice.value && fetcher.submit({ intent: "setting", value: choice.value }, { method: "post" })}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              current === choice.value ? "border-accent/60 bg-accent/10" : "border-line hover:border-line-strong hover:bg-surface"
            }`}
          >
            <span className="flex items-center gap-2 text-sm font-medium text-fg">
              <span className={`size-3.5 rounded-full border ${current === choice.value ? "border-4 border-accent" : "border-line-strong"}`} aria-hidden />
              {choice.label}
            </span>
            <span className="mt-0.5 block pl-5.5 text-xs text-muted">{choice.detail}</span>
          </button>
        ))}
      </div>
      {fetcher.data && !fetcher.data.ok && <ErrorText>{fetcher.data.error}</ErrorText>}
    </section>
  );
}

/** What a chosen file is, read in the browser before sending it: the chat service checks again. */
type Chosen = { file: File; url: string; width: number; height: number; problem: string | null };

async function inspect(file: File): Promise<Chosen> {
  const url = URL.createObjectURL(file);
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
  let problem: string | null = null;
  if (!["image/png", "image/gif", "image/webp"].includes(file.type)) problem = "Use a PNG, GIF or WebP image.";
  else if (file.size > MAX_EMOJI_BYTES) problem = `This image is ${Math.ceil(file.size / 1024)} KB; the most is ${MAX_EMOJI_BYTES / 1024} KB.`;
  else if (!size.width) problem = "This file couldn’t be read as an image.";
  else if (size.width > MAX_EMOJI_SIDE || size.height > MAX_EMOJI_SIDE) problem = `This image is ${size.width}×${size.height}; the most is ${MAX_EMOJI_SIDE}×${MAX_EMOJI_SIDE}.`;
  return { file, url, ...size, problem };
}

/** Adding an emoji: an image, previewed as messages and reactions will show it, and its name. */
export function UploadDialog({
  open,
  onOpenChange,
  taken,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: ReadonlySet<string>;
  /** For a preview without a real file (the screenshots harness). */
  initial?: { url: string; name: string; width: number; height: number; bytes: number };
}) {
  const fetcher = useFetcher<EmojiActionResult>();
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [named, setNamed] = useState(Boolean(initial));
  const [standard, setStandard] = useState<ReadonlySet<string> | null>(null);
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (!open) return;
    void loadEmojiData()
      .then((data) => setStandard(standardCodes(data)))
      .catch(() => {});
  }, [open]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.intent === "add") {
      onOpenChange(false);
      setChosen(null);
      setName("");
      setNamed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  useEffect(() => () => {
    if (chosen) URL.revokeObjectURL(chosen.url);
  }, [chosen]);

  const clean = cleanEmojiName(name);
  const nameProblem = name ? emojiNameProblem(clean, taken, standard) : null;
  const preview = chosen?.url ?? initial?.url ?? null;
  const problem = chosen?.problem ?? null;
  const ready = Boolean((chosen && !problem) || initial) && clean && !nameProblem && !busy;

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const seen = await inspect(file);
    setChosen(seen);
    // The file's name suggests the emoji's, until a name is typed.
    if (!named) setName(cleanEmojiName(file.name.replace(/\.[a-z0-9]+$/i, "")).replace(/[^a-z0-9_+-]/g, "").slice(0, 32));
  };

  const submit = () => {
    if (!chosen || !ready) return;
    const form = new FormData();
    form.set("intent", "add");
    form.set("name", clean);
    form.set("file", chosen.file);
    fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an emoji</DialogTitle>
          <DialogDescription>PNG, GIF or WebP, up to {MAX_EMOJI_BYTES / 1024} KB and {MAX_EMOJI_SIDE}×{MAX_EMOJI_SIDE}. Animated GIFs play.</DialogDescription>
        </DialogHeader>
        <input ref={input} type="file" accept={ACCEPT} onChange={onFile} className="sr-only" tabIndex={-1} aria-hidden />
        <button
          type="button"
          onClick={() => input.current?.click()}
          className={`flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-5 text-sm transition-colors ${
            problem ? "border-danger/60 bg-danger/5" : "border-line-strong hover:border-accent/50 hover:bg-surface"
          }`}
        >
          {preview ? (
            <>
              <img src={preview} alt="" className="size-16 object-contain" />
              <span className="text-xs text-muted">
                {chosen ? `${chosen.width}×${chosen.height} · ${Math.ceil(chosen.file.size / 1024)} KB` : initial ? `${initial.width}×${initial.height} · ${Math.ceil(initial.bytes / 1024)} KB` : ""} ·{" "}
                <span className="text-accent">Choose another</span>
              </span>
            </>
          ) : (
            <>
              <Upload size={20} className="text-faint" />
              <span className="font-medium text-fg-soft">Choose an image</span>
            </>
          )}
        </button>
        {problem && <ErrorText>{problem}</ErrorText>}

        <label className="block">
          <span className="text-sm font-medium text-fg">Name</span>
          <span className="mt-1.5 flex items-center rounded-md border border-line-strong bg-bg focus-within:border-accent/50">
            <span className="pl-2.5 font-mono text-sm text-faint">:</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setNamed(true);
              }}
              placeholder="shipit"
              maxLength={40}
              {...notACredential()}
              aria-invalid={Boolean(nameProblem)}
              className="min-w-0 grow bg-transparent px-0.5 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-faint"
            />
            <span className="pr-2.5 font-mono text-sm text-faint">:</span>
          </span>
          <span className={`mt-1 block text-xs ${nameProblem ? "text-danger" : "text-faint"}`}>
            {nameProblem ?? "Lowercase letters, digits, -, _ and +; 2 to 32 characters."}
          </span>
        </label>

        {preview && (
          <div className="rounded-xl border border-line bg-bg p-3" aria-label="Preview">
            <p className="mb-2 text-[0.6875rem] font-semibold tracking-wide text-faint uppercase">Preview</p>
            <p className="text-[0.9375rem] text-fg-soft">
              Shipping it today <img src={preview} alt={`:${clean || "name"}:`} className="inline-block size-[1.375em] object-contain align-[-0.3em]" />
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="flex h-6 items-center gap-1 rounded-full border border-accent/60 bg-accent/15 px-1.5 text-xs font-medium text-accent">
                <img src={preview} alt="" className="size-[15px] object-contain" />3
              </span>
              <img src={preview} alt="" className="size-9 object-contain" />
              <span className="ml-auto font-mono text-xs text-faint">:{clean || "name"}:</span>
            </div>
          </div>
        )}
        {fetcher.data && !fetcher.data.ok && fetcher.data.intent === "add" && <ErrorText>{fetcher.data.error}</ErrorText>}

        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="accent" onClick={submit} disabled={!ready}>
            {busy ? "Adding…" : "Add emoji"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Another name for an emoji the workspace has. */
function AliasDialog({
  open,
  onOpenChange,
  emoji,
  taken,
  usercontent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  emoji: CustomEmoji[];
  taken: ReadonlySet<string>;
  usercontent: string;
}) {
  const fetcher = useFetcher<EmojiActionResult>();
  const originals = emoji.filter((e) => !e.alias_of);
  const [target, setTarget] = useState(originals[0]?.name ?? "");
  const [name, setName] = useState("");
  const clean = cleanEmojiName(name);
  const problem = name ? emojiNameProblem(clean, taken, null) : null;
  const busy = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && fetcher.data.intent === "alias") {
      onOpenChange(false);
      setName("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  const picked = originals.find((e) => e.name === target);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an alias</DialogTitle>
          <DialogDescription>Another name for an emoji: both show the same image. Removing the emoji removes its aliases.</DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className="text-sm font-medium text-fg">Emoji</span>
          <span className="mt-1.5 flex items-center gap-2 rounded-md border border-line-strong bg-bg px-2.5">
            {picked && <CustomEmojiImage name={picked.name} file={picked.file} usercontent={usercontent} size={20} />}
            <select value={target} onChange={(event) => setTarget(event.target.value)} className="min-w-0 grow bg-transparent py-1.5 font-mono text-sm text-fg outline-none">
              {originals.map((e) => (
                <option key={e.name} value={e.name}>
                  :{e.name}:
                </option>
              ))}
            </select>
          </span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-fg">Alias</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="ship-it"
            {...notACredential()}
            className="mt-1.5 w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 font-mono text-sm text-fg outline-none placeholder:text-faint focus:border-accent/50"
          />
          {problem && <span className="mt-1 block text-xs text-danger">{problem}</span>}
        </label>
        {fetcher.data && !fetcher.data.ok && fetcher.data.intent === "alias" && <ErrorText>{fetcher.data.error}</ErrorText>}
        <DialogFooter>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!clean || Boolean(problem) || !target || busy}
            onClick={() => fetcher.submit({ intent: "alias", name: clean, target }, { method: "post" })}
          >
            {busy ? "Adding…" : "Add alias"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
