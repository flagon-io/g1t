/**
 * Each person's dock pins, kept with their account by identity
 * (`dock_pins` / `set_dock_pins`), so their dock follows them to every
 * device. lib/apps.ts says which apps can be pinned; identity only keeps
 * the list in order.
 */
import type { User } from "@g1t/contracts";

import { type PinnableApp, pinsFrom } from "./apps";
import { identity } from "./services.server";

/**
 * The pins `user` saved in the workspace `slug`, or null when they never
 * saved any there or identity could not be asked: the caller falls back
 * to the cookie (lib/apps.ts `pinsToShow`).
 */
export async function savedPins(user: User, slug: string): Promise<PinnableApp[] | null> {
  try {
    const stored = await identity.dockPins(user, slug);
    return stored ? pinsFrom(stored) : null;
  } catch (error) {
    console.error("dock: pins could not be read", error);
    return null;
  }
}

/** Saves `pins` as `user`'s in `slug`, in their order; the pins as kept, or null when they could not be saved. */
export async function savePins(user: User, slug: string, pins: PinnableApp[]): Promise<PinnableApp[] | null> {
  try {
    const result = await identity.setDockPins(user, slug, pins);
    return result.ok ? pinsFrom(result.value) : null;
  } catch (error) {
    console.error("dock: pins could not be saved", error);
    return null;
  }
}
