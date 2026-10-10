import { BellRing, Send } from "lucide-react";
import { useEffect, useState } from "react";

import type { Membership, NotifyLevel, NotifyPreferences, NotifyPreferencesChange, NotifyStatus } from "@g1t/contracts";

import { Button } from "../ui";
import { RadioGroup, RadioOption } from "../ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  desktopBridge,
  disablePush,
  enablePush,
  notifyStatus,
  permission,
  pushChoice,
  pushSupported,
  savePreferences,
  sendTest,
  setSound,
  soundOn,
  chime,
} from "../../lib/notify-client";

const LEVELS: { level: NotifyLevel; label: string; detail: string }[] = [
  { level: "all", label: "Everything", detail: "Every message in conversations you're in, and everything in your notifications." },
  {
    level: "dms_mentions",
    label: "Direct messages, mentions and replies",
    detail: "Messages to you, @mentions, replies in your threads, and agents or reviews waiting on you.",
  },
  { level: "none", label: "Nothing", detail: "No pop-ups or browser notifications. Counts still update." },
];

type Device = "on" | "off" | "blocked" | "unsupported" | "unavailable" | "desktop";

function deviceState(status: NotifyStatus | null): Device {
  if (desktopBridge()) return "desktop";
  if (!pushSupported()) return "unsupported";
  if (status && !status.vapid_public_key) return "unavailable";
  if (permission() === "denied") return "blocked";
  return permission() === "granted" && status?.subscribed && pushChoice() !== "off" ? "on" : "off";
}

const DEVICE_LINE: Record<Device, string> = {
  on: "On. This browser shows a notification when you're away from g1t.",
  off: "Off. You'll only see notifications while g1t is open.",
  blocked: "Blocked by your browser. Allow notifications for this site in its settings, then come back.",
  unsupported: "This browser can't show notifications.",
  unavailable: "Browser notifications aren't set up on this server.",
  desktop: "The desktop app shows notifications itself.",
};

/**
 * Settings → Notifications, the live part: what pops up and is pushed,
 * this browser's notifications, the sound, and a test. Kept by the notify
 * service (services/notify); the sound is this browser's own.
 */
export function LiveNotificationSettings({ workspaces, initial = null }: { workspaces: Membership[]; initial?: NotifyStatus | null }) {
  const [status, setStatus] = useState<NotifyStatus | null>(initial);
  const [prefs, setPrefs] = useState<NotifyPreferences | null>(initial?.preferences ?? null);
  const [device, setDevice] = useState<Device>("off");
  const [sound, setSoundState] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSoundState(soundOn());
    if (initial) {
      setDevice(deviceState(initial));
      return;
    }
    notifyStatus()
      .then((s) => {
        setStatus(s);
        setPrefs(s?.preferences ?? null);
        setDevice(deviceState(s));
        if (!s) setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [initial]);

  const save = async (change: NotifyPreferencesChange) => {
    if (prefs) {
      const workspaces = { ...prefs.workspaces };
      for (const [slug, level] of Object.entries(change.workspaces ?? {})) {
        if (level) workspaces[slug] = level;
        else delete workspaces[slug];
      }
      setPrefs({ level: change.level ?? prefs.level, workspaces });
    }
    setBusy("prefs");
    const saved = await savePreferences(change).catch(() => null);
    setBusy(null);
    if (saved) {
      setPrefs(saved);
      setSaid("Saved.");
    } else setSaid("That didn't save. Try again in a moment.");
  };

  const toggleDevice = async (on: boolean) => {
    setBusy("device");
    if (on) {
      const result = await enablePush();
      setDevice(result === "on" ? "on" : result === "denied" ? (permission() === "denied" ? "blocked" : "off") : deviceState(status));
      if (result === "failed") setSaid("This browser couldn't be set up. Try again in a moment.");
    } else {
      await disablePush().catch(() => {});
      setDevice("off");
    }
    setBusy(null);
  };

  const test = async () => {
    setBusy("test");
    const sent = await sendTest().catch(() => null);
    setBusy(null);
    if (!sent) setSaid("The test didn't send. Try again in a moment.");
    else if (sent.pushed > 0) setSaid(`Sent. Also pushed to ${sent.pushed === 1 ? "1 browser" : `${sent.pushed} browsers`}.`);
    else setSaid("Sent. It shows here; turn on browser notifications to get it when you're away.");
  };

  if (failed) {
    return (
      <section aria-labelledby="live-heading">
        <h2 id="live-heading" className="text-sm font-semibold">
          Pop-ups and browser notifications
        </h2>
        <p className="mt-3 rounded-lg border border-line px-4 py-6 text-sm text-muted">These settings could not be loaded. Try again in a moment.</p>
      </section>
    );
  }

  const deviceOn = device === "on";
  const deviceLocked = device === "unsupported" || device === "unavailable" || device === "blocked" || device === "desktop";

  return (
    <section aria-labelledby="live-heading" className="space-y-6">
      <div>
        <h2 id="live-heading" className="text-sm font-semibold">
          Pop-ups and browser notifications
        </h2>
        <p className="mt-1 text-sm text-muted">What pops up while g1t is open, and what reaches you when it isn't.</p>
      </div>

      <div>
        <h3 className="text-[0.8125rem] font-medium text-fg">Notify me about</h3>
        <RadioGroup
          className="mt-3"
          value={prefs?.level ?? "dms_mentions"}
          disabled={!prefs}
          onValueChange={(value) => void save({ level: value as NotifyLevel })}
          aria-label="Notify me about"
        >
          {LEVELS.map((choice) => (
            <RadioOption key={choice.level} value={choice.level} label={choice.label} description={choice.detail} />
          ))}
        </RadioGroup>
      </div>

      {workspaces.length > 1 && prefs && (
        <div>
          <h3 className="text-[0.8125rem] font-medium text-fg">For a workspace</h3>
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
            {workspaces.map((membership) => (
              <li key={membership.slug} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="min-w-0 grow truncate text-sm">{membership.name || membership.slug}</span>
                <Select
                  value={prefs.workspaces[membership.slug] ?? "default"}
                  onValueChange={(value) => void save({ workspaces: { [membership.slug]: value === "default" ? null : (value as NotifyLevel) } })}
                >
                  <SelectTrigger size="sm" className="w-44" aria-label={`Notifications for ${membership.name || membership.slug}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">As above</SelectItem>
                    <SelectItem value="all">Everything</SelectItem>
                    <SelectItem value="dms_mentions">DMs and mentions</SelectItem>
                    <SelectItem value="none">Nothing</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="divide-y divide-line rounded-xl border border-line bg-surface">
        <div className="flex items-start gap-4 p-4">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
            <BellRing size={16} />
          </span>
          <div className="min-w-0 grow">
            <p className="text-sm font-medium text-fg">Browser notifications</p>
            <p className="mt-0.5 text-xs text-muted" role="status">
              {DEVICE_LINE[device]}
            </p>
          </div>
          <Switch
            checked={deviceOn}
            disabled={deviceLocked || busy === "device" || !status}
            onCheckedChange={(on) => void toggleDevice(on)}
            aria-label="Browser notifications"
          />
        </div>
        <div className="flex items-start gap-4 p-4">
          <div className="min-w-0 grow pl-12">
            <p className="text-sm font-medium text-fg">Sound</p>
            <p className="mt-0.5 text-xs text-muted">A soft chime with each pop-up, in this browser.</p>
          </div>
          <Switch
            checked={sound}
            onCheckedChange={(on) => {
              setSound(on);
              setSoundState(on);
              if (on) chime();
            }}
            aria-label="Sound"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="quiet" onClick={() => void test()} disabled={busy === "test" || !status}>
          <Send size={14} />
          {busy === "test" ? "Sending…" : "Send a test notification"}
        </Button>
        {said && <p className="text-xs text-muted">{said}</p>}
      </div>
    </section>
  );
}
