import { BellOff, MonitorSmartphone, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";

import { type SoundCue, type SoundSet, type SoundSettings, SOUND_CUES, cueOn } from "@g1t/contracts/sounds";

import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Hint } from "../ui/hint";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { permission, pushChoice, setPresence, useOwnPresence } from "../../lib/notify-client";
import { PAUSE_FOR, type PauseFor, dndOn, pauseUntil, untilLabel } from "../../lib/presence";
import { applySoundSettings, preview, saveSoundSettings, useSoundSettings } from "../../lib/sounds";

const CUE: Record<Exclude<SoundCue, "call">, { label: string; detail: string }> = {
  message: { label: "New message", detail: "In a conversation you have open, while you're looking elsewhere." },
  direct: { label: "Direct message", detail: "Someone, or an agent, messages you directly." },
  mention: { label: "Mention", detail: "You were @mentioned." },
  agent_done: { label: "Agent finished", detail: "An agent posts that it finished something for you." },
  sent: { label: "Sent", detail: "A soft tick as your message goes." },
};

const SETS: { set: SoundSet; label: string; detail: string }[] = [
  { set: "soft", label: "Soft", detail: "Warm and low." },
  { set: "bright", label: "Bright", detail: "Higher and shorter." },
];

type Desktop = "on" | "off" | "blocked" | "unsupported" | "pushed";

function desktopState(settings: SoundSettings): Desktop {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  if (permission() === "denied") return "blocked";
  if (pushChoice() === "on" && permission() === "granted") return "pushed";
  return settings.desktop_toasts && permission() === "granted" ? "on" : "off";
}

const DESKTOP_LINE: Record<Desktop, string> = {
  on: "On. While this window is behind another, a message to you shows as a system notification.",
  off: "Off. Turning it on asks this browser's permission once.",
  blocked: "Blocked by your browser. Allow notifications for this site in its settings, then come back.",
  unsupported: "This browser can't show system notifications.",
  pushed: "Browser notifications above already show a message to you whenever no tab is in front.",
};

/**
 * Settings → Notifications, the sounds: whether anything plays, which set
 * and how loud, each cue on or off with a way to hear it, Do not disturb,
 * and system notifications from an open tab. Kept with the account by
 * identity (lib/sounds.ts saves; the root loader hands them over with the
 * page), except Do not disturb, which is your presence (services/notify).
 */
export function SoundSettingsSection({ initial }: { initial: SoundSettings | null }) {
  const settings = useSoundSettings();
  const me = useOwnPresence();
  const [now, setNow] = useState(() => Date.now());
  const [said, setSaid] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<Desktop>("off");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The page's own read, in case the root's is older than a change made elsewhere.
    applySoundSettings(initial);
  }, [initial]);
  useEffect(() => setDesktop(desktopState(settings)), [settings]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const save = async (change: Parameters<typeof saveSoundSettings>[0]) => {
    const saved = await saveSoundSettings(change);
    setSaid(saved ? null : "That didn't save. Try again in a moment.");
  };

  const toggleDesktop = async (on: boolean) => {
    if (!on) return save({ desktop_toasts: false });
    setBusy(true);
    try {
      // Only ever from this click: never when a page loads.
      const answer = permission() === "granted" ? "granted" : await Notification.requestPermission();
      if (answer !== "granted") {
        setDesktop(permission() === "denied" ? "blocked" : "off");
        return;
      }
      await save({ desktop_toasts: true });
    } finally {
      setBusy(false);
    }
  };

  const paused = dndOn(me, now);
  const dndValue = paused ? "on" : "off";
  const setDnd = (value: string) => {
    if (value === "off") {
      void setPresence({ dnd_until: null }, { dnd_until: null });
      return;
    }
    if (value === "on") return;
    const until = pauseUntil(value as PauseFor, new Date());
    void setPresence({ dnd_until: until }, { dnd_until: until });
  };

  const off = !settings.sounds_enabled;
  const desktopLocked = desktop === "blocked" || desktop === "unsupported" || desktop === "pushed";

  return (
    <section aria-labelledby="sounds-heading" className="space-y-4">
      <div>
        <h2 id="sounds-heading" className="text-sm font-semibold">
          Sounds &amp; notifications
        </h2>
        <p className="mt-1 text-sm text-muted">
          What you hear when chat moves, on every device you sign in on. Nothing sounds for the conversation you're looking at, for your own
          messages, or in a muted conversation.
        </p>
      </div>

      <Card divided>
        <div className="flex items-center gap-4 p-4">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
            {off ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </span>
          <div className="min-w-0 grow">
            <p className="text-sm font-medium text-fg">Sounds</p>
            <p className="mt-0.5 text-xs text-muted">{off ? "Off. Chat is silent; counts and pop-ups still show." : "On. A short sound for what is for you."}</p>
          </div>
          <Switch checked={settings.sounds_enabled} onCheckedChange={(on) => void save({ sounds_enabled: on })} aria-label="Sounds" />
        </div>

        <div className={`space-y-4 p-4 ${off ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 grow">
              <p className="text-sm font-medium text-fg">Sound set</p>
              <p className="mt-0.5 text-xs text-muted">{SETS.find((s) => s.set === settings.sound_set)?.detail ?? ""} Press play on any sound to hear it.</p>
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={settings.sound_set}
              disabled={off}
              onValueChange={(value) => {
                if (!value) return;
                const set = value as SoundSet;
                void save({ sound_set: set });
                preview("message", set, settings.sound_volume);
              }}
              aria-label="Sound set"
            >
              {SETS.map((choice) => (
                <ToggleGroupItem key={choice.set} value={choice.set} className="px-3">
                  {choice.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex items-center gap-3">
            <p id="volume-label" className="w-16 shrink-0 text-sm font-medium text-fg">
              Volume
            </p>
            <Slider
              value={[settings.sound_volume]}
              min={0}
              max={100}
              step={5}
              disabled={off}
              aria-labelledby="volume-label"
              onValueChange={([value]) => {
                if (value == null) return;
                applySoundSettings({ ...settings, sound_volume: value });
              }}
              onValueCommit={([value]) => {
                if (value == null) return;
                void save({ sound_volume: value });
                preview("message", settings.sound_set, value);
              }}
              className="grow"
            />
            <span className="w-10 shrink-0 text-right text-xs text-muted tabular-nums">{settings.sound_volume}%</span>
          </div>
        </div>

        <ul className={off ? "opacity-60" : ""} aria-label="Sounds">
          {SOUND_CUES.map((cue) => (
            <li key={cue} className="flex items-center gap-3 px-4 py-2.5">
              <Hint label={`Play ${CUE[cue].label.toLowerCase()}`}>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label={`Play ${CUE[cue].label.toLowerCase()}`}
                  onClick={() => preview(cue, settings.sound_set, settings.sound_volume)}
                >
                  <Play size={13} />
                </Button>
              </Hint>
              <div className="min-w-0 grow">
                <p className="text-sm text-fg">{CUE[cue].label}</p>
                <p className="truncate text-xs text-muted">{CUE[cue].detail}</p>
              </div>
              <Switch
                size="sm"
                checked={cueOn(settings, cue)}
                disabled={off}
                onCheckedChange={(on) => void save({ sound_cues: { [cue]: on } })}
                aria-label={CUE[cue].label}
              />
            </li>
          ))}
        </ul>
      </Card>

      <Card divided>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${paused ? "bg-warn/15 text-warn" : "bg-accent/12 text-accent"}`}>
            <BellOff size={16} />
          </span>
          <div className="min-w-0 grow basis-40">
            <p className="text-sm font-medium text-fg">Do not disturb</p>
            <p className="mt-0.5 text-xs text-muted" role="status">
              {paused && me?.dnd_until
                ? `On, ${untilLabel(me.dnd_until, new Date(now))}. No sounds, pop-ups or browser notifications; counts still move.`
                : "Silence sounds, pop-ups and browser notifications for a while. Everyone sees your amber dot."}
            </p>
          </div>
          <Select value={dndValue} onValueChange={setDnd}>
            <SelectTrigger size="sm" className="w-44" aria-label="Do not disturb">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              {paused && me?.dnd_until && <SelectItem value="on">On, {untilLabel(me.dnd_until, new Date(now))}</SelectItem>}
              {PAUSE_FOR.map((choice) => (
                <SelectItem key={choice.key} value={choice.key}>
                  {choice.label.replace(/^For /, "For ").replace("Until tomorrow", "Until tomorrow, 9:00")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-start gap-4 p-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
            <MonitorSmartphone size={16} />
          </span>
          <div className="min-w-0 grow">
            <p className="text-sm font-medium text-fg">Desktop notifications</p>
            <p className="mt-0.5 text-xs text-muted" role="status">
              {DESKTOP_LINE[desktop]}
            </p>
          </div>
          <Switch
            checked={desktop === "on"}
            disabled={desktopLocked || busy}
            onCheckedChange={(on) => void toggleDesktop(on)}
            aria-label="Desktop notifications"
          />
        </div>
      </Card>
      {said && <p className="text-xs text-danger">{said}</p>}
    </section>
  );
}
