import { useEffect, useState } from "react";

import { useDesktopRunner } from "../lib/desktop-runner";
import { type SectionId, desktopSettings, sectionOf } from "../lib/desktop-settings";
import { DesktopRunnerMenu } from "./desktop-runner-menu";
import { DesktopSettingsDialog } from "./desktop-settings";

/** Where the dot sits when the app doesn't say: near the right of the title bar, before the window's buttons. */
const DOT_AT = 0.86;

/**
 * Inside the desktop app, on every page: the app's settings dialog and the
 * runner's menu, which this page draws over itself since it fills the
 * window under the title bar (lib/desktop-settings.ts). It tells the app it
 * can as soon as it mounts, and no longer when it goes, so the app opens
 * them here rather than in windows of their own. It draws nothing until
 * the app asks. Outside the app, and in an app too old to ask, it is
 * nothing at all.
 */
export function DesktopApp() {
  // Found once hydrated: the server never has it, and the first render matches the server's.
  const [bridge, setBridge] = useState<ReturnType<typeof desktopSettings>>(null);
  useEffect(() => setBridge(desktopSettings()), []);
  const runner = useDesktopRunner();
  const [settings, setSettings] = useState<{ open: boolean; section: SectionId; check: number }>({ open: false, section: "general", check: 0 });
  const [menu, setMenu] = useState<{ open: boolean; at: number }>({ open: false, at: DOT_AT });

  useEffect(() => {
    if (!bridge) return;
    const stopOpen = bridge.onOpen((opening) => {
      setMenu((now) => ({ ...now, open: false }));
      setSettings((now) => ({
        open: true,
        // Opened again with no section named, it opens where it was.
        section: opening?.section ? sectionOf(opening.section) : now.open ? now.section : "general",
        check: opening?.check ? now.check + 1 : now.check,
      }));
    });
    const stopMenu = bridge.onRunnerMenu((asked) => {
      const at = typeof asked?.at === "number" && Number.isFinite(asked.at) ? asked.at : null;
      setMenu((now) => ({ open: asked?.action === "toggle" ? !now.open : true, at: at ?? now.at }));
    });
    void bridge.ready(true).catch(() => {});
    return () => {
      stopOpen();
      stopMenu();
      void bridge.ready(false).catch(() => {});
    };
  }, [bridge]);

  // The title bar's dot shows whether its menu is open.
  useEffect(() => {
    bridge?.setRunnerMenuOpen(menu.open);
  }, [bridge, menu.open]);

  if (!bridge) return null;
  return (
    <>
      <DesktopRunnerMenu
        open={menu.open}
        at={menu.at}
        runner={runner}
        onOpenChange={(open) => setMenu((now) => ({ ...now, open }))}
        onSettings={() => {
          setMenu((now) => ({ ...now, open: false }));
          setSettings((now) => ({ ...now, open: true, section: "runner" }));
        }}
      />
      <DesktopSettingsDialog
        open={settings.open}
        section={settings.section}
        check={settings.check}
        runner={runner}
        onOpenChange={(open) => setSettings((now) => ({ ...now, open }))}
        onSection={(section) => setSettings((now) => ({ ...now, section }))}
      />
    </>
  );
}
