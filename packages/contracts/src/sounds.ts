/**
 * Sounds and desktop notifications: what a person hears when chat moves,
 * kept with their account by identity (`sound_settings` /
 * `set_sound_settings`) so a phone, a laptop and the desktop app all sound
 * the same. Which sound plays when is the web app's rule
 * (apps/web/app/lib/chat-sounds.ts); identity keeps the choices. Do not
 * disturb is not here: it is the person's presence (`dnd_until`,
 * services/notify), which also silences pop-ups and pushes.
 *
 * On its own, with no imports, so node tests can load it.
 */

/**
 * The sounds, by what they are for. `message`: a new message in a
 * conversation you have open but are not looking at. `direct`: a direct
 * message. `mention`: you were @mentioned. `agent_done`: an agent finished
 * something for you. `sent`: a soft tick as you send (off unless turned
 * on). `call` is reserved for calls and has no setting yet.
 */
export type SoundCue = "message" | "direct" | "mention" | "agent_done" | "sent" | "call";

/** The cues a person can turn on and off, in the order the settings list them. */
export const SOUND_CUES: readonly Exclude<SoundCue, "call">[] = ["message", "direct", "mention", "agent_done", "sent"];

/** A set of sounds: the same roles, a different character. */
export type SoundSet = "soft" | "bright";

export const SOUND_SETS: readonly SoundSet[] = ["soft", "bright"];

export type SoundSettings = {
  /** Whether anything plays at all. */
  sounds_enabled: boolean;
  sound_set: SoundSet;
  /** 0 to 100. */
  sound_volume: number;
  /** Each cue on or off; a cue left out is on, except `sent`. */
  sound_cues: Partial<Record<SoundCue, boolean>>;
  /**
   * Whether an open tab shows a system notification (the browser's
   * Notifications API) for a message to you while the window is not in
   * front. Off unless turned on; the browser's permission is asked only
   * from the settings page.
   */
  desktop_toasts: boolean;
};

/** A change to them: only what is sent changes; `sound_cues` merges by cue. */
export type SoundSettingsChange = Partial<Omit<SoundSettings, "sound_cues">> & { sound_cues?: Partial<Record<SoundCue, boolean>> };

/** Which cues play before anyone changed them: all but the tick as you send. */
export const DEFAULT_SOUND_CUES: Record<Exclude<SoundCue, "call">, boolean> = { message: true, direct: true, mention: true, agent_done: true, sent: false };

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { sounds_enabled: true, sound_set: "soft", sound_volume: 60, sound_cues: { ...DEFAULT_SOUND_CUES }, desktop_toasts: false };

/** Whether a cue plays under these settings: its own switch, else its default. */
export function cueOn(settings: Pick<SoundSettings, "sound_cues">, cue: SoundCue): boolean {
  const chosen = settings.sound_cues[cue];
  if (typeof chosen === "boolean") return chosen;
  return cue === "call" ? true : DEFAULT_SOUND_CUES[cue];
}
