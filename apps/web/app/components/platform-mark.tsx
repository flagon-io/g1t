import { AppWindow } from "lucide-react";
import { siAndroid, siApple, siLinux } from "simple-icons";

import type { PlatformId } from "../lib/download-platform";

/**
 * A platform's mark, in the text's colour: Apple's for macOS and iOS,
 * Linux's and Android's from Simple Icons. Simple Icons has no Windows
 * mark, so Windows has Lucide's window.
 */
export function PlatformMark({ platform, size = 16, className }: { platform: PlatformId; size?: number; className?: string }) {
  if (platform === "windows") return <AppWindow size={size} className={className} aria-hidden="true" />;
  const path = platform === "linux" ? siLinux.path : platform === "android" ? siAndroid.path : siApple.path;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true" className={className}>
      <path d={path} />
    </svg>
  );
}
