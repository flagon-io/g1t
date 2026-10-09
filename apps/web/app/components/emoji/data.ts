import { useEffect, useState } from "react";

import { type EmojiData, MAX_RECENT, pushRecent } from "../../lib/emoji";

/**
 * The standard emoji (data.json, about 54 KB gzipped), fetched the first
 * time anything needs them: the picker opening, a `:` typed in the
 * composer. A chunk of its own, so the site's main bundle never carries it.
 */
let loading: Promise<EmojiData> | null = null;

export function loadEmojiData(): Promise<EmojiData> {
  loading ??= import("./data.json").then((module) => ((module as { default?: unknown }).default ?? module) as EmojiData);
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** The standard emoji once loaded; null until then, or while `enabled` is false. */
export function useEmojiData(enabled = true): EmojiData | null {
  const [data, setData] = useState<EmojiData | null>(null);
  useEffect(() => {
    if (!enabled || data) return;
    let live = true;
    loadEmojiData()
      .then((loaded) => live && setData(loaded))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [enabled, data]);
  return data;
}

const RECENT_KEY = "g1t:emoji-recent";
const TONE_KEY = "g1t:emoji-tone";

/** Emoji this browser used lately, newest first. Nothing when storage is off. */
export function readRecent(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(emoji: string): string[] {
  const next = pushRecent(readRecent(), emoji);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // No storage: recent lasts as long as the page.
  }
  return next;
}

/** The skin tone last picked: 0 for none, 1 to 5 light to dark. */
export function readTone(): number {
  try {
    const tone = Number(localStorage.getItem(TONE_KEY));
    return Number.isInteger(tone) && tone >= 0 && tone <= 5 ? tone : 0;
  } catch {
    return 0;
  }
}

export function rememberTone(tone: number): void {
  try {
    localStorage.setItem(TONE_KEY, String(tone));
  } catch {
    // No storage: the tone lasts as long as the page.
  }
}
