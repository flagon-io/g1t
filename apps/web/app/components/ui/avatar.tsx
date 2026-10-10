import { User } from "lucide-react";
import { useState } from "react";
import { useRouteLoaderData } from "react-router";

import { usercontentFrom } from "../../lib/addresses";
import { Mark } from "../logo";

// shadcn/ui's avatar, as g1t draws one: an uploaded picture, or a letter
// whose colour is stable for a given name. It is one element rather than
// Radix's root/image/fallback so the server renders the letter at once and
// nothing jumps; an image that fails to load falls back to the letter.

const AVATAR_HUES = [82, 200, 262, 28, 330, 160];

/**
 * g1t itself: its agent, as reviewer, assignee and commit author, and the
 * system, as the author of security updates, the issues it opens and merges
 * from the queue. One name, `g1t`.
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
 */
export function Avatar({
  name,
  size = 20,
  square,
  image,
  system,
}: {
  name: string;
  size?: number;
  square?: boolean;
  /** The uploaded avatar's hash, as identity returns it. */
  image?: string | null;
  /** g1t itself (a user of kind `system`), whatever the name. */
  system?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const usercontent = usercontentFrom(useRouteLoaderData("root"));
  // g1t itself wears its own mark: the pixel 1 on a dark square.
  if (system || isSystemName(name)) {
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
  return (
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
}
