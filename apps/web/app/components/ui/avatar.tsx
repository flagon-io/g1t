import { Bot, User } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useRouteLoaderData } from "react-router";

import type { AgentLook } from "@g1t/contracts";
import { lookFromSeed } from "@g1t/contracts/agent-look";

import { usercontentFrom } from "../../lib/addresses";
import { AgentFace, type FaceState, faceColorCss } from "../agent-face";
import { Mark } from "../logo";

// shadcn/ui's avatar, as g1t draws one: an uploaded picture, or a letter
// whose colour is stable for a given name; an agent's bot face, with the
// agent marker in its corner. It is one element rather than Radix's
// root/image/fallback so the server renders the letter at once and
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

/** What an agent's avatar is drawn from: its chosen face, else its seed's. */
export type AvatarAgent = {
  look?: AgentLook | null;
  /** What draws the face when there is no look, and times its blink; the name when left out. */
  seed?: string | null;
  /** What the face is doing (components/agent-face.tsx). */
  state?: FaceState;
};

/**
 * An uploaded avatar if there is one, else a letter avatar whose colour is
 * stable for a given name. People are round; a workspace is `square`. An
 * image that fails to load falls back to the letter.
 *
 * With `agent`, it is an agent's: its uploaded picture, g1t's own mark, or
 * its bot face (components/agent-face.tsx), on a squircle tile so it reads
 * apart from people's round letters at any size, and from 16 px up the
 * agent marker in its corner. It then names itself to a screen reader,
 * "Margo, agent", where a person's avatar is decoration beside their name.
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
  /** The uploaded avatar's hash, as identity returns it. */
  image?: string | null;
  /** g1t itself (a user of kind `system`), whatever the name. */
  system?: boolean;
  /** An agent's avatar: `true` draws the face its name seeds, an object the look or seed it has. */
  agent?: boolean | AvatarAgent;
  /** The colour behind the avatar, for the agent marker's ring; the page's by default. */
  ring?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const usercontent = usercontentFrom(useRouteLoaderData("root"));
  const g1t = system || isSystemName(name);
  if (agent) {
    const own = typeof agent === "object" ? agent : {};
    const seed = own.seed || name || "agent";
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
      <AgentTile size={size} radius={radius} color={faceColorCss((own.look ?? lookFromSeed(seed)).color)}>
        <AgentFace look={own.look ?? null} seed={seed} size={size} state={own.state} />
      </AgentTile>
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

/**
 * The tile an agent's face sits on: a squircle in a wash of the face's own
 * colour, so a round-headed bot still reads as an agent beside a person's
 * round letter.
 */
function AgentTile({ size, radius, color, children }: { size: number; radius: number; color: string; children: ReactNode }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-visible"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `color-mix(in oklab, ${color} 20%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 40%, transparent)`,
      }}
    >
      {children}
    </span>
  );
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
