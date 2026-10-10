import { SmilePlus } from "lucide-react";

import type { ChatReaction } from "@g1t/contracts";

import { useEmojiContext } from "./context";
import { EmojiPickerPopover } from "./picker";
import { EmojiGlyph } from "./render";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { reactorsLine } from "../../lib/emoji";

/**
 * A message's reactions: one pill per emoji with how many used it, lit when
 * the viewer did. Hovering one says who; clicking it adds or takes back the
 * viewer's own, at once (the page applies it before the service answers).
 * `+` opens the picker. Without a way to react (no conversation around
 * it), the pills only show.
 */
export function ReactionBar({ messageId, reactions }: { messageId: string; reactions: readonly ChatReaction[] | undefined }) {
  const { react, me, byName, usercontent } = useEmojiContext();
  if (!reactions?.length) return null;
  const meId = me?.kind === "user" ? me.id : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" aria-label="Reactions">
      {reactions.map((reaction) => {
        const custom = /^:([a-z0-9_+-]{2,32}):$/.exec(reaction.emoji);
        const label = (
          <span className="flex max-w-64 flex-col items-center gap-1 py-0.5 text-center">
            <EmojiGlyph emoji={reaction.emoji} byName={byName} usercontent={usercontent} size={32} />
            <span>
              {reactorsLine(reaction, meId)} reacted
              {custom && <span className="text-faint"> with {reaction.emoji}</span>}
            </span>
          </span>
        );
        return (
          <Hint key={reaction.emoji} label={label}>
            <button
              type="button"
              aria-pressed={reaction.me}
              aria-label={`${reaction.emoji}, ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}${reaction.me ? ", including yours" : ""}`}
              disabled={!react}
              onClick={() => react?.(messageId, reaction.emoji, !reaction.me)}
              className={`flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs font-medium tabular-nums transition-colors disabled:cursor-default ${
                reaction.me
                  ? "border-accent/60 bg-accent/15 text-accent hover:bg-accent/25"
                  : "border-line bg-surface text-muted hover:border-line-strong hover:bg-raised hover:text-fg"
              }`}
            >
              <EmojiGlyph emoji={reaction.emoji} byName={byName} usercontent={usercontent} size={15} />
              {reaction.count}
            </button>
          </Hint>
        );
      })}
      {react && <AddReaction messageId={messageId} variant="pill" />}
    </div>
  );
}

/**
 * Adding a reaction: the `+` pill after the reactions, or (`toolbar`) the
 * smiley in a message's hover actions.
 */
export function AddReaction({ messageId, variant = "toolbar" }: { messageId: string; variant?: "pill" | "toolbar" }) {
  const { react } = useEmojiContext();
  if (!react) return null;
  const button =
    variant === "pill" ? (
      <Button
        type="button"
        aria-label="Add a reaction"
        variant="outline"
        className="h-6 rounded-full bg-surface px-1.5 text-faint hover:bg-raised"
      >
        <SmilePlus size={14} />
      </Button>
    ) : (
      <Button
        type="button"
        aria-label="Add a reaction"
        variant="ghost"
        size="icon-xs"
      >
        <SmilePlus size={15} />
      </Button>
    );
  return (
    <EmojiPickerPopover onPick={(emoji) => react(messageId, emoji, true)} side={variant === "pill" ? "top" : "bottom"} align={variant === "pill" ? "start" : "end"}>
      <Hint label="Add a reaction">{button}</Hint>
    </EmojiPickerPopover>
  );
}

/** The reactions a phone's message sheet offers in one tap. */
const QUICK = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

/**
 * A row of one-tap reactions and the full picker, for a message's actions
 * on a phone (no hover there). `onDone` closes whatever it sits in.
 */
export function QuickReactions({ messageId, onDone }: { messageId: string; onDone: () => void }) {
  const { react } = useEmojiContext();
  if (!react) return null;
  const pick = (emoji: string) => {
    react(messageId, emoji, true);
    onDone();
  };
  return (
    <div className="flex items-center justify-between gap-1 px-2 pb-2" aria-label="React">
      {QUICK.map((emoji) => (
        <Button
          key={emoji}
          type="button"
          aria-label={`React with ${emoji}`}
          onClick={() => pick(emoji)}
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full bg-surface text-[1.375rem] active:bg-raised"
        >
          {emoji}
        </Button>
      ))}
      <EmojiPickerPopover onPick={pick} side="top" align="end">
        <Button type="button" aria-label="More reactions" variant="ghost" size="icon" className="size-11 rounded-full bg-surface active:bg-raised">
          <SmilePlus size={20} />
        </Button>
      </EmojiPickerPopover>
    </div>
  );
}
