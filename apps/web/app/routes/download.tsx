import { env } from "cloudflare:workers";
import { Apple, Bell, Download, Link2, Monitor, RefreshCw, Server, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useLoaderData } from "react-router";

import type { Route } from "./+types/download";
import { TrustPage } from "../components/trust-page";
import { ButtonLink } from "../components/ui";
import { Card } from "../components/ui/card";
import { page } from "../lib/meta";

/**
 * g1t.sh/download: the desktop app, from its newest release. The release
 * is `desktop/latest.json` in the g1t-downloads bucket, as
 * scripts/desktop-release.mjs writes it: what the app's updater reads
 * (`platforms`), and the list this page shows (`downloads`). The visitor's
 * own platform, read from the browser, comes first.
 */

export type DesktopDownload = {
  platform: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  kind: string;
  name: string;
  size: number;
  sha256: string;
};

export type DesktopRelease = {
  version: string;
  pub_date: string;
  notes?: string;
  downloads: DesktopDownload[];
};

type Platform = DesktopDownload["platform"];

/** Which platform a browser says it is on; null when it does not say. */
export function platformOf(userAgent: string | null): Platform | null {
  if (!userAgent) return null;
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macos";
  if (/Linux|X11/i.test(userAgent) && !/Android/i.test(userAgent)) return "linux";
  return null;
}

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Download g1t for your desktop",
    description: "g1t in a window of its own, for Windows, macOS and Linux: notifications from your system, a badge on the icon, g1t:// links, and updates that install themselves.",
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const bucket = env.DOWNLOADS;
  let release: DesktopRelease | null = null;
  try {
    const found = bucket ? await bucket.get("desktop/latest.json") : null;
    if (found) {
      const read = (await found.json()) as Partial<DesktopRelease>;
      if (read && typeof read.version === "string" && Array.isArray(read.downloads)) {
        release = { version: read.version, pub_date: read.pub_date ?? "", notes: read.notes, downloads: read.downloads };
      }
    }
  } catch (error) {
    console.error("download: the release could not be read", error);
  }
  return { release, platform: platformOf(request.headers.get("user-agent")) };
}

const PLATFORMS: { id: Platform; name: string; icon: ReactNode; note: string }[] = [
  { id: "windows", name: "Windows", icon: <Monitor size={16} />, note: "Windows 10 and 11. Installs for you alone, no administrator needed." },
  { id: "macos", name: "macOS", icon: <Apple size={16} />, note: "macOS 11 and later. Apple silicon and Intel are separate downloads." },
  { id: "linux", name: "Linux", icon: <Terminal size={16} />, note: "An AppImage that runs anywhere, or a package for Debian and Ubuntu." },
];

const KINDS: Record<string, string> = {
  installer: "Installer",
  dmg: "Disk image",
  appimage: "AppImage",
  deb: "Debian package",
  rpm: "RPM package",
};

function archLabel(download: DesktopDownload): string {
  if (download.platform === "macos") return download.arch === "arm64" ? "Apple silicon" : "Intel";
  return download.arch === "arm64" ? "arm64" : "x64";
}

function size(bytes: number): string {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

const WHAT: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <Bell size={16} />, title: "Notifications from your system", text: "A message to you, a mention, or an agent finished, while the window is behind another; the icon carries a badge until you have looked." },
  { icon: <Link2 size={16} />, title: "g1t:// links", text: "A g1t:// link opens the page in the app, from anywhere on your computer. Links to other sites open in your browser." },
  { icon: <RefreshCw size={16} />, title: "Updates install themselves", text: "The app downloads a new version in the background, signed by g1t, and asks only to restart. Everything you see is the site itself, so most changes need no update at all." },
  { icon: <Server size={16} />, title: "Your own g1t", text: "Running g1t yourself? The tray's \u201cUse another g1t\u201d points the app at your server." },
];

export default function DownloadPage() {
  const { release, platform } = useLoaderData<typeof loader>();
  const ordered = platform ? [...PLATFORMS.filter((p) => p.id === platform), ...PLATFORMS.filter((p) => p.id !== platform)] : PLATFORMS;
  const yours = platform && release ? release.downloads.filter((d) => d.platform === platform) : [];
  const featured = yours.find((d) => d.kind === "installer" || d.kind === "dmg" || d.kind === "appimage") ?? yours[0] ?? null;
  const href = (download: DesktopDownload) => `/downloads/desktop/${release!.version}/${download.name}`;

  return (
    <TrustPage
      eyebrow="Desktop app"
      title="g1t on your desktop"
      lede={
        <p>
          The whole of g1t in a window of its own: chat, agents, artifacts and code, for Windows, macOS and Linux.
          {release && (
            <>
              {" "}
              Version {release.version}
              {release.pub_date && (
                <>
                  , released{" "}
                  {new Date(release.pub_date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
                </>
              )}
              .
            </>
          )}
        </p>
      }
    >
      <div className="max-w-3xl">
        {!release && (
          <Card className="p-5">
            <p className="font-medium">The first release is on its way.</p>
            <p className="mt-1 text-sm text-muted">
              The desktop app is built and being released now. Until it is here, g1t works as an installed web app too: in your browser's menu, choose
              Install or Add to Dock.
            </p>
          </Card>
        )}

        {release && featured && (
          <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">For your {PLATFORMS.find((p) => p.id === platform)?.name}</p>
              <p className="mt-1 text-sm text-muted">
                {KINDS[featured.kind] ?? featured.kind}, {archLabel(featured)}
                {featured.size ? `, ${size(featured.size)}` : ""}.
                {yours.length > 1 ? " The other downloads for it are below." : ""}
              </p>
            </div>
            <ButtonLink to={href(featured)} reloadDocument className="shrink-0">
              <Download size={16} />
              Download g1t {release.version}
            </ButtonLink>
          </Card>
        )}

        <div className="mt-10 grid gap-3 sm:grid-cols-2">
          {WHAT.map((item) => (
            <div key={item.title} className="flex gap-3 rounded-xl border border-line bg-surface p-5">
              <span className="mt-0.5 shrink-0 text-accent">{item.icon}</span>
              <span>
                <span className="block font-medium">{item.title}</span>
                <span className="mt-1 block text-sm text-muted">{item.text}</span>
              </span>
            </div>
          ))}
        </div>

        {release && (
          <section className="mt-14">
            <h2 className="text-xl font-semibold tracking-tight">All downloads</h2>
            <p className="mt-1 text-sm text-muted">
              Every file of version {release.version}, with its SHA-256 in{" "}
              <a href={`/downloads/desktop/${release.version}/SHA256SUMS`} className="text-accent hover:underline">
                SHA256SUMS
              </a>
              .
            </p>
            <div className="mt-4 space-y-3">
              {ordered.map((p) => {
                const files = release.downloads.filter((d) => d.platform === p.id);
                if (files.length === 0) return null;
                return (
                  <Card key={p.id} tone="plain" divided className="rounded-xl">
                    <div className="flex items-center gap-2 px-4 py-3">
                      <span className="text-accent">{p.icon}</span>
                      <span className="font-medium">{p.name}</span>
                      <span className="text-sm text-muted">· {p.note}</span>
                    </div>
                    {files.map((d) => (
                      <div key={d.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                        <a href={href(d)} className="font-medium text-fg hover:underline">
                          {KINDS[d.kind] ?? d.kind}, {archLabel(d)}
                        </a>
                        <span className="text-muted">{size(d.size)}</span>
                        <code className="ml-auto truncate font-mono text-xs text-faint">{d.name}</code>
                      </div>
                    ))}
                  </Card>
                );
              })}
            </div>
            <p className="mt-6 text-sm text-muted">
              On macOS the app is not yet notarized with Apple: the first time, right-click it and choose Open. How the app works, and how a
              release is made, is in{" "}
              <a href="https://docs.g1t.sh/guides/desktop/" className="text-accent hover:underline">
                the desktop app guide
              </a>
              .
            </p>
          </section>
        )}
      </div>
    </TrustPage>
  );
}
