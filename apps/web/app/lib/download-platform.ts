/**
 * Which platform a visitor to g1t.sh/download is on, and which of a
 * release's files to offer them first (routes/download.tsx). The server
 * reads the User-Agent, so the page is drawn for the visitor's platform
 * from the first byte; the browser can then say which processor it has
 * (`navigator.userAgentData`), which a User-Agent no longer does on a Mac.
 */

export const PLATFORM_IDS = ["macos", "windows", "linux", "android", "ios"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];
export type Arch = "x64" | "arm64";

/** The desktop app's platforms, as its releases name them. */
export type DesktopPlatform = Extract<PlatformId, "macos" | "windows" | "linux">;

export type Device = { platform: PlatformId | null; arch: Arch | null };

export function isPlatform(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

export function isDesktop(platform: PlatformId): platform is DesktopPlatform {
  return platform === "macos" || platform === "windows" || platform === "linux";
}

/**
 * The platform and processor a User-Agent names, each null when it does not
 * say. A phone is checked first: Android's says Linux, an iPhone's says
 * "like Mac OS X". An iPad asking for the desktop site says Macintosh, which
 * only the browser can tell apart (by its touch screen).
 */
export function deviceOf(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? "";
  if (/iPhone|iPad|iPod/i.test(ua)) return { platform: "ios", arch: "arm64" };
  if (/Android/i.test(ua)) return { platform: "android", arch: null };
  if (/Windows/i.test(ua)) return { platform: "windows", arch: /ARM64|aarch64/i.test(ua) ? "arm64" : /Win64|x64|WOW64|amd64/i.test(ua) ? "x64" : null };
  if (/Macintosh|Mac OS X/i.test(ua)) return { platform: "macos", arch: null };
  if (/CrOS|Linux|X11/i.test(ua)) return { platform: "linux", arch: /aarch64|arm64/i.test(ua) ? "arm64" : /x86_64|amd64/i.test(ua) ? "x64" : null };
  return { platform: null, arch: null };
}

/** The processor a browser's client hints name (`getHighEntropyValues(["architecture"])`). */
export function archOfHint(architecture: string | undefined): Arch | null {
  if (architecture === "arm") return "arm64";
  if (architecture === "x86") return "x64";
  return null;
}

/** The kinds of file a platform's download is, most wanted first. */
const PREFERRED: Record<DesktopPlatform, string[]> = {
  macos: ["dmg"],
  windows: ["installer"],
  linux: ["appimage", "deb", "rpm"],
};

type File = { platform: string; arch: string; kind: string };

/**
 * The file to offer first for a platform: its preferred kind, on the
 * visitor's processor when known; on a Mac whose processor is not known,
 * Apple silicon's, which every Mac sold since 2023 has. Null when the
 * release has nothing for the platform.
 */
export function featuredFile<T extends File>(downloads: T[], platform: DesktopPlatform, arch: Arch | null): T | null {
  const files = downloads.filter((d) => d.platform === platform);
  if (files.length === 0) return null;
  const want = arch ?? (platform === "macos" ? "arm64" : "x64");
  const rank = (d: T) => {
    const kind = PREFERRED[platform].indexOf(d.kind);
    return (kind === -1 ? 10 : kind) + (d.arch === want ? 0 : 100);
  };
  return [...files].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * The other ways to have the same app, shown beside the main button: on a
 * Mac, the other processor's disk image (the Intel one, for one whose
 * processor the page could not tell); on Linux, the other packages for the
 * same processor; on Windows, the other processor's installer.
 */
export function alternateFiles<T extends File>(downloads: T[], featured: T | null): T[] {
  if (!featured) return [];
  const others = downloads.filter((d) => d.platform === featured.platform && d !== featured);
  if (featured.platform === "linux") return others.filter((d) => d.arch === featured.arch).slice(0, 2);
  return others.filter((d) => d.kind === featured.kind).slice(0, 1);
}
