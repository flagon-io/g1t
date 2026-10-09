import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";

import type { CustomEmoji, EmojiList, MemberProfile, Result } from "@g1t/contracts";

/**
 * What emoji components need from the page around them: the workspace's
 * own emoji, where their images are served, who is looking, and how to
 * react to a message. A conversation provides it; without one, reactions
 * show but cannot be clicked and only standard emoji are offered.
 */
export type EmojiContextValue = {
  customs: CustomEmoji[];
  /** Each custom emoji's image file, by name. */
  byName: ReadonlyMap<string, string>;
  /** The usercontent origin custom emoji images are served from. */
  usercontent: string;
  me: MemberProfile | null;
  /** Reacts to a message (`on`) or takes it back. */
  react?: (messageId: string, emoji: string, on: boolean) => void;
  /** Where the workspace's emoji are managed, for the picker's "Add emoji". */
  manageHref?: string;
};

const EMPTY: EmojiContextValue = { customs: [], byName: new Map(), usercontent: "", me: null };

export const EmojiContext = createContext<EmojiContextValue>(EMPTY);

export function useEmojiContext(): EmojiContextValue {
  return useContext(EmojiContext);
}

export function EmojiProvider({ value, children }: { value: Omit<EmojiContextValue, "byName">; children: ReactNode }) {
  const byName = useMemo(() => new Map(value.customs.map((e) => [e.name, e.file])), [value.customs]);
  const full = useMemo(() => ({ ...value, byName }), [value, byName]);
  return <EmojiContext.Provider value={full}>{children}</EmojiContext.Provider>;
}

/** Each workspace's emoji as last fetched, shared by every conversation in the tab. */
const fetched = new Map<string, Promise<CustomEmoji[]>>();

/** Drops what was fetched, after the workspace's emoji change. */
export function forgetCustomEmoji(slug: string): void {
  fetched.delete(slug.toLowerCase());
}

/** The workspace's own emoji, fetched once per tab (routes/workspace/chat/api.ts, `?emoji=1`). */
export function useCustomEmoji(slug: string): CustomEmoji[] {
  const [list, setList] = useState<CustomEmoji[]>([]);
  useEffect(() => {
    if (!slug) return;
    const key = slug.toLowerCase();
    let promise = fetched.get(key);
    if (!promise) {
      promise = fetch(`/${slug}/-/chat/api?emoji=1`)
        .then((response) => response.json() as Promise<Result<EmojiList>>)
        .then((result) => (result.ok ? result.value.emoji : []))
        .catch(() => {
          fetched.delete(key);
          return [];
        });
      fetched.set(key, promise);
    }
    let live = true;
    void promise.then((emoji) => live && setList(emoji));
    return () => {
      live = false;
    };
  }, [slug]);
  return list;
}
