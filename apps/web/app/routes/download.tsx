import { env } from "cloudflare:workers";
import { connectLink } from "@g1t/contracts/discovery";
import { Apple, Bell, Download, Link2, Monitor, RefreshCw, Server, Smartphone, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useLoaderData } from "react-router";

import type { Route } from "./+types/download";
import { QrCode } from "../components/qr-code";
import { ButtonLink } from "../components/ui";
import { Card } from "../components/ui/card";
import { HOSTED_ADDRESSES } from "../lib/addresses";
import { addresses } from "../lib/addresses.server";
import { page } from "../lib/meta";

/**
 * g1t.sh/download: the desktop app, from its newest release, and the phone
 * app. On a self-hosted g1t the phone section offers a `g1t://connect`
 * link and its QR code, which point the app at this g1t. The release
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

/** The phone app's newest Android release (scripts/mobile-release.mjs): `mobile/latest.json`. */
export type MobileRelease = {
  version: string;
  build: number | null;
  pub_date: string;
  notes?: string;
  downloads: { platform: "android"; kind: "apk"; name: string; size: number; sha256: string }[];
};

/** A manifest as read from the bucket, or null when it is not one. */
async function readJson<T>(bucket: R2Bucket | undefined, key: string, check: (value: Partial<T>) => boolean): Promise<T | null> {
  try {
    const found = bucket ? await bucket.get(key) : null;
    if (!found) return null;
    const read = (await found.json()) as Partial<T>;
    return read && check(read) ? (read as T) : null;
  } catch (error) {
    console.error(`download: ${key} could not be read`, error);
    return null;
  }
}

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
    title: "Download g1t for your desktop and phone",
    description: "g1t in a window of its own, for Windows, macOS and Linux, and on your phone: notifications, a badge, g1t:// links, and updates that install themselves.",
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
  const mobile = await readJson<MobileRelease>(bucket, "mobile/latest.json", (read) => typeof read.version === "string" && Array.isArray(read.downloads));
  const { site } = addresses();
  const userAgent = request.headers.get("user-agent") ?? "";
  return {
    release,
    platform: platformOf(userAgent),
    android: /Android/i.test(userAgent),
    mobile,
    site,
    hosted: site === HOSTED_ADDRESSES.site,
  };
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
  { icon: <Server size={16} />, title: "Your own g1t", text: "Running g1t yourself? The tray's \u201cUse another g1t\u201d points the app at your server, and the phone app below works with it too." },
];

export default function DownloadPage() {
  const { release, platform, site, hosted, mobile, android } = useLoaderData<typeof loader>();
  const ordered = platform ? [...PLATFORMS.filter((p) => p.id === platform), ...PLATFORMS.filter((p) => p.id !== platform)] : PLATFORMS;
  const yours = platform && release ? release.downloads.filter((d) => d.platform === platform) : [];
  const featured = yours.find((d) => d.kind === "installer" || d.kind === "dmg" || d.kind === "appimage") ?? yours[0] ?? null;
  const href = (download: DesktopDownload) => `/downloads/desktop/${release!.version}/${download.name}`;

  // A marketing page, drawn like Pricing: the site's header and footer,
  // never the app's rail (lib/chrome.ts, MARKETING).
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm font-medium text-accent">Desktop and phone apps</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">g1t on your desktop, and in your pocket</h1>
      <p className="mt-3 max-w-2xl text-muted">
        The whole of g1t in a window of its own: chat, agents, artifacts and code, for Windows, macOS and Linux, with notifications
        from your system and updates that install themselves.
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
      <div className="mt-8">
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

        {release && !featured && platform && (
          <Card className="p-5">
            <p className="font-medium">Not yet for {PLATFORMS.find((p) => p.id === platform)?.name}.</p>
            <p className="mt-1 text-sm text-muted">
              Version {release.version} is out for {Array.from(new Set(release.downloads.map((d) => PLATFORMS.find((p) => p.id === d.platform)?.name))).join(" and ")};
              yours is built in a later release. Until then, g1t works as an installed web app: in your browser's menu, choose Install or Add to Dock.
            </p>
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
                // A platform this release lacks: it is built on a machine not yet registered.
                if (files.length === 0) {
                  return (
                    <Card key={p.id} tone="plain" className="flex flex-wrap items-center gap-2 rounded-xl px-4 py-3">
                      <span className="text-faint">{p.icon}</span>
                      <span className="font-medium text-muted">{p.name}</span>
                      <span className="text-sm text-muted">· Coming in a later release. {p.note}</span>
                    </Card>
                  );
                }
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
        <PhoneApp site={site} hosted={hosted} mobile={mobile} android={android} />
      </div>
    </main>
  );
}

/**
 * The phone app: Chat with people and agents, live, and notifications on
 * the phone. Not in Google Play or the App Store yet (both wait on
 * Flagon's D-U-N-S number), so the Android app is offered here as an APK,
 * with how to install it and why it is not in a store. On a g1t of your
 * own, a link and its QR code point the app here, so nobody types the
 * address; on g1t.sh the app starts here anyway.
 */
function PhoneApp({ site, hosted, mobile, android }: { site: string; hosted: boolean; mobile: MobileRelease | null; android: boolean }) {
  const link = connectLink(site);
  const host = new URL(site).host;
  const apk = mobile?.downloads.find((download) => download.kind === "apk") ?? null;
  // The release's own address on g1t.sh, wherever this page is: the app is g1t's, served from g1t.sh.
  const apkUrl = apk && mobile ? `${HOSTED_ADDRESSES.site}/downloads/mobile/${mobile.version}/${apk.name}` : null;
  return (
    <section className="mt-14">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Smartphone size={18} className="text-accent" />
        On your phone
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Chat with your team and its agents, live, with notifications for messages to you, mentions, replies and agents waiting on you;
        review and approve pull requests on the way. Android first, with iOS to follow.
      </p>

      {apk && apkUrl && mobile ? (
        <Card className="mt-4 flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
          {!android && (
            <div className="shrink-0">
              <QrCode value={apkUrl} label="Download the g1t app for Android" size={152} />
            </div>
          )}
          <div className="min-w-0">
            <p className="font-medium">g1t for Android, beta {mobile.version}</p>
            <p className="mt-1 text-sm text-muted">
              {android
                ? "Download it, open the file, and allow your browser to install apps when Android asks."
                : "Scan this with your Android phone's camera to download it there, then open the file and allow your browser to install apps when Android asks."}{" "}
              It installs as <span className="text-fg-soft">g1t (beta)</span>, and takes most updates by itself.
            </p>
            <ButtonLink to={apkUrl} reloadDocument className="mt-3">
              <Download size={16} />
              Download for Android{apk.size ? ` (${size(apk.size)})` : ""}
            </ButtonLink>
            <p className="mt-2 font-mono text-xs break-all text-faint">SHA-256 {apk.sha256}</p>
          </div>
        </Card>
      ) : hosted ? (
        <Card className="mt-4 p-5">
          <p className="font-medium">The first Android build is on its way.</p>
          <p className="mt-1 text-sm text-muted">It will be here to download as soon as it is published.</p>
        </Card>
      ) : (
        <Card className="mt-4 p-5">
          <p className="font-medium">Get the app from g1t.sh</p>
          <p className="mt-1 text-sm text-muted">
            The app is the same for every g1t: download it from{" "}
            <a href={`${HOSTED_ADDRESSES.site}/download`} className="text-accent hover:underline">
              g1t.sh/download
            </a>
            , then point it here with the code below.
          </p>
        </Card>
      )}

      <div className="mt-4 rounded-xl border border-line bg-surface p-5 text-sm">
        <p className="font-medium text-fg">Why a download, and not Google Play or the App Store?</p>
        <p className="mt-1 text-muted">
          Both stores publish a company's apps only once the company is verified with a D-U-N-S number, and Flagon's is on its way. Until it
          arrives, the Android app is published {hosted ? "here" : "on g1t.sh"}, signed by us, as the desktop app is. Android asks once to allow installing it from your
          browser; that is the only difference. It moves into Google Play as soon as it can, and iOS follows through the App Store, which has no
          other way in.
        </p>
      </div>

      {!hosted && (
        <Card className="mt-4 flex flex-col gap-5 p-5 sm:flex-row sm:items-center">
          <div className="shrink-0">
            <QrCode value={link} label={`Open the g1t app on ${host}`} size={152} />
          </div>
          <div className="min-w-0">
            <p className="font-medium">Use the app with {host}</p>
            <p className="mt-1 text-sm text-muted">
              With the g1t app on your phone, scan this with the camera, or open this page on the phone and tap the button: the app signs in
              here instead of g1t.sh. In the app, <span className="text-fg-soft">Using your own g1t?</span> on the sign-in screen does the same with
              the address typed.
            </p>
            <ButtonLink to={link} reloadDocument variant="secondary" className="mt-3">
              <Smartphone size={16} />
              Open in the g1t app
            </ButtonLink>
          </div>
        </Card>
      )}

      <p className="mt-4 text-sm text-muted">
        How it works, and what it does with a g1t of your own, is in{" "}
        <a href="https://docs.g1t.sh/guides/mobile/" className="text-accent hover:underline">
          the phone app guide
        </a>
        .
      </p>
    </section>
  );
}
