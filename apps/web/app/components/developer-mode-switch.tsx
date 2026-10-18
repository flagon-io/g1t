import { useRouteLoaderData } from "react-router";

import type { loader as rootLoader } from "../root";
import { setDeveloperMode, useDeveloperMode } from "../lib/developer-mode";
import { SwitchCard } from "./ui/switch";

/** Developer mode for this browser (lib/developer-mode.ts), switched at once. */
export function DeveloperModeSwitch() {
  const on = useDeveloperMode(useRouteLoaderData<typeof rootLoader>("root")?.developer);
  return (
    <SwitchCard title="Developer mode" checked={on} onCheckedChange={setDeveloperMode}>
      When a page fails, show the error itself, its stack, where it happened and the build, with a button that copies it all for a report. Signed in, errors on
      g1t&apos;s side come through in full too. This browser remembers it.
    </SwitchCard>
  );
}
