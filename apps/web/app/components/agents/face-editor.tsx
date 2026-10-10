import { RotateCcw, Shuffle, Smile } from "lucide-react";

import type { AgentLook } from "@g1t/contracts";
import { LOOK_KEYS, LOOK_OPTIONS, PRESET_EXPRESSIONS, lookFromSeed, randomLook, sameLook } from "@g1t/contracts/agent-look";

import { AgentFace, FACE_COLOR_LABELS, type FaceState, faceColorCss } from "../agent-face";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** What each choice is called, in the hint over it. */
const LABELS: { [K in keyof AgentLook]: Record<AgentLook[K], string> } = {
  shape: { round: "Round", square: "Square", squircle: "Squircle", blob: "Blob", hex: "Hex" },
  color: FACE_COLOR_LABELS,
  eyes: { dots: "Dots", round: "Round", wide: "Wide", happy: "Happy", visor: "Visor", sleepy: "Sleepy" },
  mouth: { smile: "Smile", grin: "Grin", flat: "Flat", open: "Open", none: "No mouth" },
  antenna: { none: "No antenna", single: "One", double: "Two", bulb: "Bulb" },
  accessory: { none: "Nothing", headphones: "Headphones", bow: "Bow", glasses: "Glasses", hat: "Hat", spark: "Spark" },
  pattern: { none: "Plain", stripe: "Stripes", dots: "Dots", gradient: "Sheen" },
};

const PARTS: { [K in keyof AgentLook]: string } = {
  shape: "Shape",
  color: "Colour",
  eyes: "Eyes",
  mouth: "Mouth",
  antenna: "Antenna",
  accessory: "Accessory",
  pattern: "Pattern",
};

const STATES: { state: FaceState; label: string }[] = [
  { state: "idle", label: "Idle: it blinks and breathes" },
  { state: "working", label: "Working: eyes narrowed, a soft pulse" },
  { state: "asleep", label: "Asleep: paused or out of budget" },
  { state: "happy", label: "Happy: a session finished well" },
];

/**
 * An agent's face, chosen part by part (docs.g1t.sh/guides/agents/, "Its
 * face"): a live preview, each state it can be in, then a row of choices
 * for each of the seven parts, drawn as the face would be with that
 * choice. Shuffle draws a random face; Reset gives it back the face its
 * seed draws, which is what `null` means. A personality preset can lend
 * its expression, but only when asked: a chosen look is never changed
 * behind someone's back.
 */
export function FaceEditor({
  value,
  seed,
  name = "agent",
  preset,
  onChange,
}: {
  /** The chosen look, or null for the seed's face. */
  value: AgentLook | null;
  seed: string;
  /** The agent's name, for the preview's label. */
  name?: string;
  /** Its personality preset, whose expression it can borrow. */
  preset?: string | null;
  onChange: (look: AgentLook | null) => void;
}) {
  const own = lookFromSeed(seed);
  const current = value ?? own;
  const expression = preset ? PRESET_EXPRESSIONS[preset] : undefined;
  const wearsExpression = expression ? Object.entries(expression).every(([key, choice]) => current[key as keyof AgentLook] === choice) : true;
  return (
    <div className="grid gap-5 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex flex-col items-center gap-3 sm:items-start">
        <Avatar name={name} size={96} agent={{ look: value, seed }} />
        <div role="list" aria-label="How it looks in each state" className="flex items-center gap-2">
          {STATES.map(({ state, label }) => (
            <Hint key={state} label={label}>
              <span role="listitem" className="inline-flex rounded-md">
                <AgentFace look={value} seed={seed} size={28} state={state} />
              </span>
            </Hint>
          ))}
        </div>
        <p className="text-xs text-faint">{value ? "A chosen face." : "Its own face, drawn from its seed."}</p>
      </div>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(randomLook())}>
            <Shuffle size={14} />
            Shuffle
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!value || sameLook(value, own)} onClick={() => onChange(null)}>
            <RotateCcw size={14} />
            Reset to its own
          </Button>
          {expression && (
            <Hint label={`A ${preset} voice suggests ${Object.values(expression).join(" and ")}. Only when you choose it.`}>
              <Button type="button" variant="ghost" size="sm" disabled={wearsExpression} onClick={() => onChange({ ...current, ...expression })}>
                <Smile size={14} />
                Match its voice
              </Button>
            </Hint>
          )}
        </div>
        {LOOK_KEYS.map((key) => (
          <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span id={`face-${key}`} className="w-20 shrink-0 text-xs font-medium text-fg-soft">
              {PARTS[key]}
            </span>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={current[key]}
              onValueChange={(choice) => {
                if (choice) onChange({ ...current, [key]: choice } as AgentLook);
              }}
              aria-labelledby={`face-${key}`}
              className="min-w-0"
            >
              {(LOOK_OPTIONS[key] as readonly AgentLook[typeof key][]).map((choice) => (
                <Hint key={choice} label={(LABELS[key] as Record<string, string>)[choice]}>
                  <ToggleGroupItem
                    value={choice}
                    aria-label={(LABELS[key] as Record<string, string>)[choice]}
                    className="h-11 min-w-11 px-1.5 data-[state=on]:shadow-[inset_0_0_0_1.5px_var(--color-accent)]"
                  >
                    {key === "color" ? (
                      <span aria-hidden="true" className="size-6 rounded-full ring-1 ring-black/15 ring-inset" style={{ background: faceColorCss(choice as AgentLook["color"]) }} />
                    ) : (
                      <AgentFace look={{ ...current, [key]: choice } as AgentLook} seed={seed} size={36} className="[&_.face-eyes]:animate-none [&_.face-bob]:animate-none" />
                    )}
                  </ToggleGroupItem>
                </Hint>
              ))}
            </ToggleGroup>
          </div>
        ))}
      </div>
    </div>
  );
}
