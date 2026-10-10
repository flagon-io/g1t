import { BellOff, BellRing } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Hint } from "../ui/hint";
import { setPresence, useOwnPresence } from "../../lib/notify-client";
import { PAUSE_FOR, dndOn, pauseUntil, untilLabel } from "../../lib/presence";

/**
 * Do not disturb from the chat sidebar's header: one bell-off button. Off,
 * it opens the choices (30 minutes, an hour, two, tomorrow at 9); on, it
 * is lit and the menu ends it. The same Do not disturb as the avatar
 * menu's Pause notifications and the settings page: your presence
 * (`dnd_until`), which silences sounds, pop-ups and pushes alike.
 */
export function DndMenu({ className }: { className?: string }) {
  const me = useOwnPresence();
  const [now, setNow] = useState(() => Date.now());
  // It ends on its own: the button follows, a minute at a time.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const on = dndOn(me, now);
  const until = on && me?.dnd_until ? untilLabel(me.dnd_until, new Date(now)) : null;
  return (
    <DropdownMenu>
      <Hint label={on ? `Do not disturb, ${until}` : "Do not disturb"}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={on ? `Do not disturb is on, ${until}` : "Do not disturb"}
            aria-pressed={on}
            className={`${on ? "text-warn hover:text-warn aria-pressed:text-warn" : "text-faint"} ${className ?? ""}`}
          >
            <BellOff size={15} />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="min-w-52">
        {on ? (
          <DropdownMenuItem
            className="gap-2.5 px-2.5"
            onSelect={() => {
              void setPresence({ dnd_until: null }, { dnd_until: null });
            }}
          >
            <BellRing />
            <span className="grow">Resume notifications</span>
            {until && <span className="text-xs text-faint">{until}</span>}
          </DropdownMenuItem>
        ) : (
          PAUSE_FOR.map((choice) => (
            <DropdownMenuItem
              key={choice.key}
              className="px-2.5"
              onSelect={() => {
                const at = pauseUntil(choice.key, new Date());
                void setPresence({ dnd_until: at }, { dnd_until: at });
              }}
            >
              {choice.label}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <p className="max-w-56 px-2.5 py-1 text-xs leading-snug text-faint">
          {on ? "No sounds, pop-ups or browser notifications until then. Counts still move." : "Silences sounds, pop-ups and browser notifications. Counts still move."}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
