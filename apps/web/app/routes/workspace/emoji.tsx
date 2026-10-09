import { data } from "react-router";

import { MAX_EMOJI_BYTES } from "@g1t/contracts";

import type { Route } from "./+types/emoji";
import { type EmojiActionResult, EmojiSettings } from "../../components/emoji/settings";
import { ErrorText } from "../../components/ui";
import { useAddresses } from "../../lib/addresses";
import { sniffImage, toBase64 } from "../../lib/avatar-upload";
import { page } from "../../lib/meta";
import { chat } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Emoji · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = requireUser(context, request);
  if (!roleIn(getViewer(context), params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const list = await chat.listEmoji(slug, viewer).catch(() => null);
  return { slug, me: viewer.id, list: list?.ok ? list.value : null, error: list && !list.ok ? list.error.message : list ? null : "Chat didn't answer. Try again in a moment." };
}

/** The types the chat service keeps; it reads them from the bytes again. */
const TYPES = new Set(["image/png", "image/gif", "image/webp"]);

export async function action({ params, context, request }: Route.ActionArgs): Promise<EmojiActionResult> {
  assertSameOrigin(request);
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const fail = (error: string): EmojiActionResult => ({ ok: false, intent, error });
  try {
    if (intent === "add") {
      const file = form.get("file");
      if (!file || typeof file === "string" || file.size === 0) return fail("Choose an image.");
      if (file.size > MAX_EMOJI_BYTES) return fail(`An emoji image is at most ${MAX_EMOJI_BYTES / 1024} KB.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!TYPES.has(sniffImage(bytes) ?? "")) return fail("Use a PNG, GIF or WebP image.");
      const added = await chat.addEmoji(slug, viewer, String(form.get("name") ?? ""), { data: toBase64(bytes) });
      return added.ok ? { ok: true, intent } : fail(added.error.message);
    }
    if (intent === "alias") {
      const made = await chat.aliasEmoji(slug, viewer, String(form.get("name") ?? ""), String(form.get("target") ?? ""));
      return made.ok ? { ok: true, intent } : fail(made.error.message);
    }
    if (intent === "remove") {
      const removed = await chat.removeEmoji(slug, viewer, String(form.get("name") ?? ""));
      return removed.ok ? { ok: true, intent } : fail(removed.error.message);
    }
    if (intent === "setting") {
      const value = form.get("value") === "admins" ? "admins" : "members";
      const set = await chat.setEmojiUpload(slug, viewer, value);
      return set.ok ? { ok: true, intent } : fail(set.error.message);
    }
    return fail("Unknown request.");
  } catch (error) {
    console.error("emoji: the chat service did not answer", error);
    return fail("Chat didn't answer. Try again in a moment.");
  }
}

export default function WorkspaceEmoji({ loaderData }: Route.ComponentProps) {
  const { usercontent } = useAddresses();
  if (!loaderData.list) return <ErrorText>{loaderData.error}</ErrorText>;
  return <EmojiSettings slug={loaderData.slug} list={loaderData.list} usercontent={usercontent} meId={loaderData.me} />;
}
