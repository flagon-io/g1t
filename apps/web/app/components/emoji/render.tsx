import { Fragment, type ReactNode } from "react";

import { emojiUrl, splitShortcodes } from "../../lib/emoji";

/**
 * One of the workspace's own emoji, inline: an image from the usercontent
 * origin, the size of the text around it unless told otherwise, with its
 * `:name:` as the words a screen reader and a copy get.
 */
export function CustomEmojiImage({
  name,
  file,
  usercontent,
  size,
  className = "",
}: {
  name: string;
  file: string;
  usercontent: string;
  /** Pixels; unset is 1.375em, a little over the line's text. */
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={emojiUrl(file, usercontent)}
      alt={`:${name}:`}
      draggable={false}
      loading="lazy"
      decoding="async"
      className={`inline-block object-contain align-[-0.3em] ${className}`}
      style={size ? { width: size, height: size } : { width: "1.375em", height: "1.375em" }}
    />
  );
}

/**
 * Text with each `:name:` of a workspace emoji drawn as its image, and
 * everything else as text. Never HTML: the parts are React nodes.
 */
export function renderEmoji(text: string, byName: ReadonlyMap<string, string>, usercontent: string, size?: number): ReactNode {
  const parts = splitShortcodes(text, byName);
  if (parts.length === 1 && parts[0]!.t === "text") return text;
  return parts.map((part, index) =>
    part.t === "text" ? (
      <Fragment key={index}>{part.v}</Fragment>
    ) : (
      <CustomEmojiImage key={index} name={part.name} file={part.file} usercontent={usercontent} size={size} />
    ),
  );
}

/** One emoji as a reaction or a pick shows it: a Unicode one as text, a workspace one as its image. */
export function EmojiGlyph({
  emoji,
  byName,
  usercontent,
  size = 18,
}: {
  emoji: string;
  byName: ReadonlyMap<string, string>;
  usercontent: string;
  size?: number;
}) {
  const custom = /^:([a-z0-9_+-]{2,32}):$/.exec(emoji);
  if (custom) {
    const file = byName.get(custom[1]!);
    return file ? (
      <CustomEmojiImage name={custom[1]!} file={file} usercontent={usercontent} size={size} />
    ) : (
      <span className="text-xs text-muted">{emoji}</span>
    );
  }
  return (
    <span className="leading-none" style={{ fontSize: size }}>
      {emoji}
    </span>
  );
}
