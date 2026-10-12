import { Bot, User } from "lucide-react";
import { useState } from "react";
import { useRouteLoaderData } from "react-router";

import { usercontentFrom } from "../../lib/addresses";
import { Mark } from "../logo";

// shadcn/ui's avatar, as g1t draws one: an uploaded picture, or a letter
// whose colour is stable for a given name; an agent's (an old message's
// author, or g1t's own), with the agent marker in its corner. It is one
// element rather than Radix's root/image/fallback so the server renders
// the letter at once and nothing jumps; an image that fails to load falls
// back to the letter.

const AVATAR_HUES = [82, 200, 262, 28, 330, 160];

/**
 * g1t itself: the system, as the author of security updates, the issues it
 * opens and merges from the queue, and on older rows as reviewer, assignee
 * and commit author. One name, `g1t`.
 */
export function isSystemName(name: string | null | undefined): boolean {
  return name === "g1t";
}

/**
 * Where an uploaded avatar is served, from the hash it is stored by: the
 * usercontent origin, or the site's own address (which redirects there)
 * when it is not known.
 */
export function avatarUrl(avatar: string, usercontent = ""): string {
  return `${usercontent}/avatars/${avatar}`;
}

/**
 * An uploaded avatar if there is one, else a letter avatar whose colour is
 * stable for a given name. People are round; a workspace is `square`. An
 * image that fails to load falls back to the letter.
 *
 * With `agent`, it is an agent's: g1t's own mark, its uploaded picture, or
 * its initial on a squircle tile so it reads apart from people's round
 * letters at any size, and from 16 px up the agent marker in its corner.
 * It then names itself to a screen reader, "Margo, agent", where a
 * person's avatar is decoration beside their name.
 */
export function Avatar({
  name,
  size = 20,
  square,
  image,
  system,
  agent,
  ring,
}: {
  name: string;
  size?: number;
  square?: boolean;
  /**
   * The uploaded avatar's hash, as identity returns it; null when there is
   * none, or `name` is no account's. Left out, a person's picture is looked
   * up by their username.
   */
  image?: string | null;
  /** g1t itself (a user of kind `system`), whatever the name. */
  system?: boolean;
  /** An agent's avatar: g1t's mark, its picture or its initial, with the agent marker. */
  agent?: boolean;
  /** The colour behind the avatar, for the agent marker's ring; the page's by default. */
  ring?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const usercontent = usercontentFrom(useRouteLoaderData("root"));
  const g1t = system || isSystemName(name);
  if (agent) {
    const radius = Math.round(size * 0.26);
    const face = g1t ? (
      <span
        className="inline-flex shrink-0 items-center justify-center bg-[#0b0b0d] text-fg ring-1 ring-line-strong ring-inset scheme-dark"
        style={{ width: size, height: size, borderRadius: radius }}
      >
        <Mark className="size-full" />
      </span>
    ) : image && failed !== image ? (
      <img
        src={avatarUrl(image, usercontent)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(image)}
        className="inline-block shrink-0 bg-raised object-cover"
        style={{ width: size, height: size, borderRadius: radius }}
      />
    ) : (
      <span
        className="inline-flex shrink-0 items-center justify-center bg-raised font-mono font-semibold text-muted uppercase ring-1 ring-line-strong ring-inset"
        style={{ width: size, height: size, borderRadius: radius, fontSize: size * 0.5 }}
      >
        {name[0] ?? "?"}
      </span>
    );
    return (
      <span role="img" aria-label={`${name}, agent`} className="relative inline-flex shrink-0 align-middle">
        {face}
        {size >= 16 && <AgentMarker size={size} ring={ring} />}
      </span>
    );
  }
  // g1t itself wears its own mark: the pixel 1 on a dark square.
  if (g1t) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center bg-[#0b0b0d] text-fg ring-1 ring-line-strong ring-inset scheme-dark"
        style={{ width: size, height: size, borderRadius: size * 0.24 }}
      >
        <Mark className="size-full" />
      </span>
    );
  }
  // ghost stands in for deleted accounts: a plain silhouette, as for
  // anyone on a commit who has no account.
  if (name === "ghost" && !image) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-line text-faint"
        style={{ width: size, height: size }}
      >
        <User size={Math.round(size * 0.62)} strokeWidth={2.25} />
      </span>
    );
  }
  if (image && failed !== image) {
    return (
      <img
        src={avatarUrl(image, usercontent)}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(image)}
        className="inline-block shrink-0 bg-raised object-cover"
        style={{ width: size, height: size, borderRadius: square ? size * 0.24 : size }}
      />
    );
  }
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const hue = AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  const letter = (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-mono font-semibold uppercase"
      style={{
        width: size,
        height: size,
        borderRadius: square ? size * 0.24 : size,
        fontSize: size * 0.5,
        background: `oklch(0.4 0.09 ${hue})`,
        color: `oklch(0.93 0.08 ${hue})`,
      }}
    >
      {name[0]}
    </span>
  );
  // A person drawn by username alone (`image` not given, as opposed to
  // null for "no upload"): their letter at once, and their uploaded
  // picture over it once it has loaded, from the site's address for it.
  if (square || image !== undefined || failed === name || !isUsername(name)) return letter;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {letter}
      <img
        // An image the browser had before the page woke has no load event to come.
        ref={(img) => {
          if (img?.complete && img.naturalWidth > 0) setLoaded(name);
        }}
        src={`/-/avatar/user/${name.toLowerCase()}`}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(name)}
        onError={() => setFailed(name)}
        className={`absolute inset-0 bg-raised object-cover transition-opacity duration-150 ${loaded === name ? "opacity-100" : "opacity-0"}`}
        style={{ width: size, height: size, borderRadius: size }}
      />
    </span>
  );
}

/**
 * A name an account could have: what has a picture to look up. Not ghost,
 * nor "someone", what a feed says when it could not read who it was.
 */
function isUsername(name: string): boolean {
  return name !== "ghost" && name !== "someone" && /^[a-z0-9-]{1,39}$/i.test(name);
}

/**
 * The agent marker: a small bot on an accent disc, ringed in the colour
 * behind it, in the corner of every agent's avatar from 16 px up (under
 * that the squircle tile alone says it). The same mark everywhere, so
 * nobody has to read a name to know they are looking at an agent.
 */
export function AgentMarker({ size, ring = "var(--color-bg)", className }: { size: number; ring?: string; className?: string }) {
  const disc = Math.max(9, Math.min(22, Math.round(size * 0.4)));
  const icon = Math.max(6, Math.round(disc * 0.66));
  const inset = Math.round(disc * 0.28);
  return (
    <span
      aria-hidden="true"
      className={`absolute flex items-center justify-center rounded-full bg-accent text-bg ${className ?? ""}`}
      style={{ width: disc, height: disc, right: -inset, bottom: -inset, boxShadow: `0 0 0 ${size >= 28 ? 2 : 1.5}px ${ring}` }}
    >
      <Bot size={icon} strokeWidth={2.6} absoluteStrokeWidth={false} />
    </span>
  );
}
