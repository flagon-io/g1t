import { env } from "cloudflare:workers";
import { connectLink } from "@g1t/contracts/discovery";
import { ArrowRight, Bell, Download, Link2, RefreshCw, Server, ShieldAlert, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLoaderData } from "react-router";

import type { Route } from "./+types/download";
import { PlatformMark } from "../components/platform-mark";
import { QrCode } from "../components/qr-code";
import { ButtonLink } from "../components/ui";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Hint } from "../components/ui/hint";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { HOSTED_ADDRESSES } from "../lib/addresses";
import { addresses } from "../lib/addresses.server";
import {
  type Arch,
  type DesktopPlatform,
  type Device,
  PLATFORM_IDS,
  type PlatformId,
  alternateFiles,
  archOfHint,
  deviceOf,
  featuredFile,
  isDesktop,
  isPlatform,
} from "../lib/download-platform";
import { page } from "../lib/meta";

/**
 * g1t.sh/download: the desktop app, the phone app, and the runner and CLI
 * for each computer, behind one switcher of platforms that opens on the
 * visitor's own (lib/download-platform.ts reads it from the User-Agent, so
 * the first byte is already theirs; `?platform=` chooses another). On a
 * self-hosted g1t a `g1t://connect` link and its QR code point the phone
 * app at this g1t.
 *
 * Everything offered comes from the newest release's manifest in the
 * g1t-downloads bucket: `desktop/latest.json` (scripts/desktop-release.mjs:
 * `downloads` is the list this page shows), `mobile/latest.json`
 * (scripts/mobile-release.mjs), and `runner/latest.json` and
 * `cli/latest.json` (scripts/runner-release.mjs, cli-release.mjs). A
 * platform a release lacks is shown as coming.
 */

export type DesktopDownload = {
  platform: DesktopPlatform;
  arch: Arch;
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

/** The phone app's newest Android release (scripts/mobile-release.mjs): `mobile/latest.json`. */
export type MobileRelease = {
  version: string;
  build: number | null;
  pub_date: string;
  notes?: string;
  downloads: { platform: "android"; kind: "apk"; name: string; size: number; sha256: string }[];
};

/** The runner's or the CLI's newest release: one file for each `<os>-<arch>`. */
export type ToolRelease = {
  version: string;
  files: Record<string, { name: string; sha256: string }>;
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

const hasDownloads = (read: { version?: unknown; downloads?: unknown }) => typeof read.version === "string" && Array.isArray(read.downloads);
const hasFiles = (read: { version?: unknown; files?: unknown }) => typeof read.version === "string" && !!read.files && typeof read.files === "object";

export function meta(args: Route.MetaArgs) {
  return page(args, {
    title: "Download g1t for your desktop",
    description:
      "g1t in a window of its own, for Windows, macOS and Linux: notifications, a badge, g1t:// links, and updates that install themselves. An early, highly experimental Android app too.",
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const bucket = env.DOWNLOADS;
  const [desktop, mobile, runner, cli] = await Promise.all([
    readJson<DesktopRelease>(bucket, "desktop/latest.json", hasDownloads),
    readJson<MobileRelease>(bucket, "mobile/latest.json", hasDownloads),
    readJson<ToolRelease>(bucket, "runner/latest.json", hasFiles),
    readJson<ToolRelease>(bucket, "cli/latest.json", hasFiles),
  ]);
  const { site } = addresses();
  const asked = new URL(request.url).searchParams.get("platform");
  return {
    release: desktop && { version: desktop.version, pub_date: desktop.pub_date ?? "", notes: desktop.notes, downloads: desktop.downloads },
    mobile,
    // Only what the page shows: the runner's manifest also carries its sandbox's images.
    runner: runner && { version: runner.version, files: runner.files },
    cli: cli && { version: cli.version, files: cli.files },
    device: deviceOf(request.headers.get("user-agent")),
    asked: isPlatform(asked) ? asked : null,
    site,
    hosted: site === HOSTED_ADDRESSES.site,
  };
}

type Data = Awaited<ReturnType<typeof loader>>;

const PLATFORMS: Record<PlatformId, { name: string; device: string; note: string }> = {
  macos: { name: "macOS", device: "Mac", note: "macOS 11 or later. Drag g1t to Applications." },
  windows: { name: "Windows", device: "PC", note: "Windows 10 or 11. Installs for you alone, with no administrator needed." },
  linux: { name: "Linux", device: "computer", note: "The AppImage runs anywhere once made executable; the packages install what it needs." },
  android: { name: "Android", device: "phone", note: "" },
  ios: { name: "iOS", device: "iPhone", note: "" },
};

/**
 * What each system says about an app that isn't code-signed, and how to
 * open it anyway. Every build is unsigned while g1t is in alpha.
 */
const UNSIGNED: Record<PlatformId, string | null> = {
  windows: "Windows may say it protected your PC: choose More info, then Run anyway.",
  macos: "macOS may say it can't check g1t: open System Settings, Privacy & Security, and choose Open Anyway.",
  linux: "Your package manager may say the package isn't signed. The AppImage needs only to be made executable.",
  android: "Play Protect may warn about an unknown app: choose More details, then Install anyway.",
  ios: null,
};

const KINDS: Record<string, string> = {
  installer: "Installer",
  dmg: "Disk image",
  appimage: "AppImage",
  deb: "Debian package",
  rpm: "RPM package",
};

function archLabel(platform: string, arch: string): string {
  if (platform === "macos") return arch === "arm64" ? "Apple silicon" : "Intel";
  return arch === "arm64" ? "Arm" : "x64";
}

function size(bytes: number): string {
  if (!bytes) return "";
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function day(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Who the visitor is, as the page first drew it, made more exact once the browser says. */
function useDevice(initial: Device): Device {
  const [device, setDevice] = useState(initial);
  useEffect(() => {
    // An iPad asking for the desktop site says it is a Mac; its touch screen says otherwise.
    if (initial.platform === "macos" && navigator.maxTouchPoints > 1) {
      setDevice({ platform: "ios", arch: "arm64" });
      return;
    }
    if (initial.arch || !initial.platform || !isDesktop(initial.platform)) return;
    const hints = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(keys: string[]): Promise<{ architecture?: string }> } }).userAgentData;
    hints
      ?.getHighEntropyValues(["architecture"])
      .then((values) => {
        const arch = archOfHint(values.architecture);
        if (arch) setDevice((current) => ({ ...current, arch }));
      })
      .catch(() => {});
  }, [initial.platform, initial.arch]);
  return device;
}

export default function DownloadPage() {
  const data = useLoaderData<typeof loader>();
  const device = useDevice(data.device);
  const first: PlatformId =
    data.asked ??
    data.device.platform ??
    (["macos", "windows", "linux"] as const).find((p) => data.release?.downloads.some((d) => d.platform === p)) ??
    "macos";
  const [tab, setTab] = useState<PlatformId>(first);
  const chosen = useRef(data.asked !== null);
  // An iPad found out only in the browser opens on iOS, unless the visitor has chosen.
  useEffect(() => {
    if (!chosen.current && device.platform && device.platform !== data.device.platform) setTab(device.platform);
  }, [device.platform, data.device.platform]);

  const choose = (value: string) => {
    if (!isPlatform(value)) return;
    chosen.current = true;
    setTab(value);
    // In the address, so the link shared is the platform shown; without a navigation, which would read the manifests again.
    const url = new URL(window.location.href);
    url.searchParams.set("platform", value);
    window.history.replaceState(window.history.state, "", url);
  };

  // A marketing page, drawn like Pricing: the site's header and footer,
  // never the app's rail (lib/chrome.ts, MARKETING).
  return (
    <main className="overflow-x-clip">
      <section className="dusk relative">
        <div className="relative mx-auto max-w-5xl px-4 pt-14 text-center sm:pt-20">
          <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Download</p>
          <h1 className="mx-auto mt-4 max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">g1t in an app of its own</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-balance text-fg-soft/80">
            Chat, artifacts and code in an app of their own, with notifications from your system and updates that install themselves. The phone app is highly
            experimental.
          </p>
        </div>

        <Tabs value={tab} onValueChange={choose} className="relative mx-auto max-w-5xl px-4 pt-10 sm:pt-12">
          <div className="flex justify-center">
            <TabsList aria-label="Platform" className="grid w-full max-w-xl grid-cols-5 rounded-full bg-bg/70 backdrop-blur">
              {PLATFORM_IDS.map((id) => (
                <TabsTrigger key={id} value={id} className="inline-flex items-center justify-center gap-2 rounded-full px-1 py-2 text-[0.8125rem] sm:px-3">
                  <PlatformMark platform={id} size={14} className="max-sm:hidden" />
                  {PLATFORMS[id].name}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          <Alert tone="warn" className="mx-auto mt-6 flex max-w-3xl gap-3 px-4 py-3">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" />
            <div>
              <AlertTitle>Unsigned while g1t is in alpha</AlertTitle>
              <AlertDescription>
                The desktop app, the Android app, the runner and the CLI aren't code-signed yet, so your system warns you before it opens them.{" "}
                {UNSIGNED[tab] ?? "Every download here is unsigned until g1t leaves alpha."} Each file's SHA-256 is listed to check it against.
              </AlertDescription>
            </div>
          </Alert>
          {PLATFORM_IDS.map((id) => (
            <TabsContent key={id} value={id} className="mt-6">
              {isDesktop(id) ? (
                <DesktopPanel platform={id} data={data} device={device} />
              ) : id === "android" ? (
                <AndroidPanel data={data} device={device} />
              ) : (
                <IosPanel yours={device.platform === "ios"} onAndroid={() => choose("android")} />
              )}
            </TabsContent>
          ))}
        </Tabs>
        <div aria-hidden="true" className="h-16 bg-linear-to-b from-transparent to-bg" />
      </section>

      <div className="mx-auto max-w-5xl space-y-20 px-4 pt-8 pb-24">
        {!data.hosted && <ConnectCard site={data.site} />}
        <Features />
        <Questions hosted={data.hosted} release={data.release} />
      </div>
    </main>
  );
}

/**
 * One platform's panel: its mark and name, what there is for it, and an
 * aside (the files, or the phone's QR code) beside it on a wide screen and
 * under it on a narrow one.
 */
function Panel({
  platform,
  title,
  meta,
  yours,
  badge,
  children,
  aside,
  asideClassName,
  footer,
}: {
  platform: PlatformId;
  title: string;
  meta?: ReactNode;
  yours: boolean;
  badge?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  asideClassName?: string;
  footer?: ReactNode;
}) {
  return (
    <Card className="overflow-hidden shadow-2xl shadow-black/20">
      <div className={aside ? "grid md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" : undefined}>
        <CardContent className="p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-raised text-fg ring-1 ring-line">
              <PlatformMark platform={platform} size={24} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
                {yours && (
                  <Badge tone="accent" size="sm">
                    This device
                  </Badge>
                )}
                {badge}
              </div>
              {meta && <p className="mt-1 text-sm text-muted">{meta}</p>}
            </div>
          </div>
          <div className="mt-6">{children}</div>
        </CardContent>
        {aside && <CardContent className={`border-t border-line bg-bg/40 p-6 sm:p-8 md:border-t-0 md:border-l ${asideClassName ?? ""}`}>{aside}</CardContent>}
      </div>
      {footer && <CardContent className="border-t border-line p-6 sm:px-8">{footer}</CardContent>}
    </Card>
  );
}

/** The panel's main download, and the other ways to the same app beside it. */
function DownloadButtons({ main, alternates }: { main: { href: string; label: string; detail: string }; alternates: { href: string; label: string }[] }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <ButtonLink to={main.href} reloadDocument variant="accent" size="lg" className="rounded-full">
          <Download size={16} />
          {main.label}
        </ButtonLink>
        {alternates.map((alternate) => (
          <ButtonLink key={alternate.href} to={alternate.href} reloadDocument variant="outline" className="rounded-full">
            {alternate.label}
          </ButtonLink>
        ))}
      </div>
      <p className="mt-3 text-sm text-muted">{main.detail}</p>
    </div>
  );
}

/** What to do while a platform has no release: the site installs as an app from the browser. */
function Meanwhile({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-2 text-sm text-muted">
      <p className="text-base text-fg-soft">{children}</p>
      <p>Until then, g1t installs from your browser: in its menu, choose Install or Add to Dock.</p>
    </div>
  );
}

function DesktopPanel({ platform, data, device }: { platform: DesktopPlatform; data: Data; device: Device }) {
  const { release } = data;
  const info = PLATFORMS[platform];
  const yours = device.platform === platform;
  const files = release ? release.downloads.filter((d) => d.platform === platform) : [];
  const featured = release ? featuredFile(release.downloads, platform, yours ? device.arch : null) : null;
  const alternates = release ? alternateFiles(release.downloads, featured) : [];
  const href = (download: DesktopDownload) => `/downloads/desktop/${release!.version}/${download.name}`;
  const released = release?.pub_date ? day(release.pub_date) : "";
  const label = (d: DesktopDownload) =>
    d.platform === "linux" ? `.${d.name.split(".").pop()}` : d.platform === "macos" ? `${archLabel(d.platform, d.arch)} Mac` : archLabel(d.platform, d.arch);
  const tools = commandLineTools(platform, data.runner, data.cli);
  const out = release ? Array.from(new Set(release.downloads.map((d) => PLATFORMS[d.platform]?.name).filter(Boolean))) : [];

  return (
    <Panel
      platform={platform}
      title={`g1t for ${info.name}`}
      yours={yours}
      meta={release ? `Version ${release.version}${released ? `, released ${released}` : ""}` : undefined}
      badge={
        !featured && (
          <Badge tone="neutral" size="sm">
            Coming
          </Badge>
        )
      }
      aside={featured && <FileList platform={platform} files={files} version={release!.version} href={href} />}
      footer={tools.length > 0 && <CommandLine platform={platform} tools={tools} />}
    >
      {featured ? (
        <>
          <p className="mb-6 max-w-md text-sm text-muted">{info.note}</p>
          <DownloadButtons
            main={{
              href: href(featured),
              label: `Download for ${info.name}`,
              detail: [KINDS[featured.kind] ?? featured.kind, archLabel(featured.platform, featured.arch), size(featured.size)].filter(Boolean).join(" · "),
            }}
            alternates={alternates.map((d) => ({ href: href(d), label: label(d) }))}
          />
        </>
      ) : release ? (
        <Meanwhile>
          {yours ? `Your ${info.device} isn't in this release yet.` : `${info.name} isn't in this release yet.`} Version {release.version} is out for{" "}
          {out.join(" and ")}, and {info.name} comes in a later one.
        </Meanwhile>
      ) : (
        <Meanwhile>The first release of the desktop app is on its way.</Meanwhile>
      )}
    </Panel>
  );
}

/** Every file of a platform in the release, with its SHA-256 on hover. */
function FileList({
  platform,
  files,
  version,
  href,
}: {
  platform: DesktopPlatform;
  files: DesktopDownload[];
  version: string;
  href: (d: DesktopDownload) => string;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium">All {PLATFORMS[platform].name} downloads</h3>
      <ul className="mt-3 divide-y divide-line">
        {files.map((d) => (
          <li key={d.name} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 grow">
              <p className="text-sm">
                {KINDS[d.kind] ?? d.kind} <span className="text-muted">· {archLabel(d.platform, d.arch)}</span>
              </p>
              <Hint label={`SHA-256 ${d.sha256}`} side="bottom" align="start">
                <p className="truncate font-mono text-xs text-faint">{d.name}</p>
              </Hint>
            </div>
            <span className="shrink-0 text-xs text-muted tabular-nums">{size(d.size)}</span>
            <Button asChild variant="ghost" size="icon-sm">
              <a href={href(d)} aria-label={`Download ${d.name}`}>
                <Download size={15} />
              </a>
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-faint">
        Checksums in{" "}
        <a href={`/downloads/desktop/${version}/SHA256SUMS`} className="text-accent hover:underline">
          SHA256SUMS
        </a>
      </p>
    </div>
  );
}

const OS_FILE: Record<DesktopPlatform, string> = { macos: "macos", windows: "windows", linux: "linux" };

/** The runner and the CLI for a computer's system, those whose releases have one. */
function commandLineTools(platform: DesktopPlatform, runner: ToolRelease | null, cli: ToolRelease | null) {
  return [
    {
      id: "runner",
      title: "g1t-runner",
      text: "Runs your workspace's jobs on a server. The desktop app runs one for you.",
      release: runner,
      guide: "https://docs.g1t.sh/guides/self-hosted-runners/",
    },
    { id: "cli", title: "g1t CLI", text: "g1t from your terminal and scripts.", release: cli, guide: "https://docs.g1t.sh/guides/containers/" },
  ]
    .map((tool) => ({
      ...tool,
      files: tool.release
        ? Object.entries(tool.release.files)
            .filter(([key]) => key.startsWith(`${OS_FILE[platform]}-`))
            .map(([key, file]) => ({ arch: key.split("-")[1] ?? "", ...file }))
            // Apple silicon first on a Mac, x64 first elsewhere.
            .sort((a, b) => (platform === "macos" ? a.arch.localeCompare(b.arch) : b.arch.localeCompare(a.arch)))
        : [],
    }))
    .filter((tool) => tool.files.length > 0);
}

function CommandLine({ platform, tools }: { platform: DesktopPlatform; tools: ReturnType<typeof commandLineTools> }) {
  return (
    <div>
      <h3 className="text-sm font-medium">Command line</h3>
      <ul className="mt-3 grid gap-4 sm:grid-cols-2">
        {tools.map((tool) => (
          <li key={tool.id} className="flex flex-col gap-2">
            <p className="text-sm">
              <a href={tool.guide} className="font-medium hover:text-accent">
                {tool.title}
              </a>{" "}
              <span className="text-faint">{tool.release!.version}</span>
            </p>
            <p className="text-sm text-muted">{tool.text}</p>
            <div className="flex flex-wrap gap-2">
              {tool.files.map((file) => (
                <Hint key={file.name} label={`SHA-256 ${file.sha256}`}>
                  <Button asChild variant="outline" size="xs">
                    <a href={`/downloads/${tool.id}/${tool.release!.version}/${file.name}`}>
                      <Download size={13} />
                      {archLabel(platform, file.arch)}
                    </a>
                  </Button>
                </Hint>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The Android app, an APK until it is in Google Play (both stores wait on
 * Flagon's D-U-N-S number). On a computer, a QR code takes it to the phone.
 * The release is g1t.sh's wherever this page is: the app is g1t's.
 */
function AndroidPanel({ data, device }: { data: Data; device: Device }) {
  const { mobile, hosted } = data;
  const onPhone = device.platform === "android";
  const apk = mobile?.downloads.find((download) => download.kind === "apk") ?? null;
  const apkUrl = apk && mobile ? `${HOSTED_ADDRESSES.site}/downloads/mobile/${mobile.version}/${apk.name}` : null;
  const released = mobile?.pub_date ? day(mobile.pub_date) : "";

  if (!apk || !apkUrl || !mobile) {
    return (
      <Panel platform="android" title="g1t for Android" yours={onPhone} badge={hosted ? <Badge size="sm">Coming</Badge> : undefined}>
        {hosted ? (
          <div className="space-y-2 text-sm text-muted">
            <p className="text-base text-fg-soft">The first Android build is on its way. It starts out highly experimental.</p>
            <p>It will be here to download as soon as it is published.</p>
          </div>
        ) : (
          <div className="space-y-2 text-sm text-muted">
            <p className="text-base text-fg-soft">Get the app from g1t.sh.</p>
            <p>
              The app is the same for every g1t: download it from{" "}
              <a href={`${HOSTED_ADDRESSES.site}/download?platform=android`} className="text-accent hover:underline">
                g1t.sh/download
              </a>
              , then point it here with the code below.
            </p>
          </div>
        )}
      </Panel>
    );
  }

  const steps = [
    onPhone ? "Download the app." : "Scan the code with your phone's camera, or download it on the phone.",
    "Open the file, and allow your browser to install apps when Android asks.",
    "Open g1t and sign in.",
  ];
  return (
    <Panel
      platform="android"
      title="g1t for Android"
      yours={onPhone}
      badge={<Badge size="sm">Experimental</Badge>}
      meta={`Version ${mobile.version}${released ? `, released ${released}` : ""}`}
      aside={
        !onPhone && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-2xl bg-white p-3 shadow-lg shadow-black/10 ring-1 ring-line">
              <QrCode value={apkUrl} label="Download the g1t app for Android" size={168} />
            </div>
            <p className="max-w-56 text-sm text-muted">Scan with your phone's camera to download it there.</p>
          </div>
        )
      }
      asideClassName="max-sm:hidden"
    >
      <Alert tone="warn" className="mb-6 max-w-md px-4 py-3">
        <AlertTitle>Highly experimental</AlertTitle>
        <AlertDescription>
          The phone app is early and barely works yet: expect missing screens, rough edges and things that break. For real work, use the desktop app or g1t in
          your phone's browser.
        </AlertDescription>
      </Alert>
      <DownloadButtons main={{ href: apkUrl, label: "Download for Android", detail: ["APK", size(apk.size)].filter(Boolean).join(" · ") }} alternates={[]} />
      <ol className="mt-6 space-y-2 text-sm text-muted">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3">
            <Badge tone="accent" size="sm" className="size-5 justify-center p-0 tabular-nums">
              {index + 1}
            </Badge>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <Hint label={`SHA-256 ${apk.sha256}`} align="start">
        <p className="mt-6 truncate font-mono text-xs text-faint">{apk.name}</p>
      </Hint>
    </Panel>
  );
}

function IosPanel({ yours, onAndroid }: { yours: boolean; onAndroid: () => void }) {
  return (
    <Panel platform="ios" title="g1t for iPhone" yours={yours} badge={<Badge size="sm">Coming</Badge>}>
      <div className="space-y-2 text-sm text-muted">
        <p className="text-base text-fg-soft">The iPhone app comes through the App Store, once it can be published there.</p>
        <p>Until then, g1t installs from Safari: tap Share, then Add to Home Screen.</p>
      </div>
      <Button variant="outline" className="mt-6 rounded-full" onClick={onAndroid}>
        <PlatformMark platform="android" size={14} />
        Get the Android app
      </Button>
    </Panel>
  );
}

/** On a self-hosted g1t: a link and its QR code that point the phone app here. */
function ConnectCard({ site }: { site: string }) {
  const link = connectLink(site);
  const host = new URL(site).host;
  return (
    <Card className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
      <div className="shrink-0 self-center rounded-2xl bg-white p-3 ring-1 ring-line">
        <QrCode value={link} label={`Open the g1t app on ${host}`} size={152} />
      </div>
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">Use the phone app with {host}</h2>
        <p className="mt-2 text-sm text-muted">
          With the g1t app on your phone, scan this with the camera, or open this page on the phone and tap the button: the app signs in here instead of g1t.sh.
          In the app, <span className="text-fg-soft">Using your own g1t?</span> on the sign-in screen does the same with the address typed.
        </p>
        <ButtonLink to={link} reloadDocument variant="secondary" className="mt-4 rounded-full">
          <Smartphone size={16} />
          Open in the g1t app
        </ButtonLink>
      </div>
    </Card>
  );
}

const FEATURES: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <Bell size={18} />, title: "Notifications", text: "A message to you, a mention, or a review requested, from your system, with a badge on the icon." },
  { icon: <Link2 size={18} />, title: "g1t:// links", text: "Open a page in the app from anywhere on your computer. Other links open in your browser." },
  { icon: <RefreshCw size={18} />, title: "Updates install themselves", text: "Signed by g1t and downloaded in the background. The app asks only to restart." },
  {
    icon: <Server size={18} />,
    title: "A runner built in",
    text: "Your workspace's self-hosted jobs run on your computer while g1t is open, in a sandbox, at no cost, and so do jobs that ask for g1t's machines when the workspace prefers its own runners and one of your computer's sizes fits them.",
  },
];

function Features() {
  return (
    <section>
      <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">The desktop app</p>
      <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">Everything in g1t, and what a browser can't do</h2>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {FEATURES.map((item) => (
          <Card asChild key={item.title} className="p-5">
            <li>
              <span className="flex size-9 items-center justify-center rounded-lg bg-accent/10 text-accent">{item.icon}</span>
              <p className="mt-4 font-medium">{item.title}</p>
              <p className="mt-1 text-sm text-muted">{item.text}</p>
            </li>
          </Card>
        ))}
      </ul>
    </section>
  );
}

function Questions({ hosted, release }: { hosted: boolean; release: Data["release"] }) {
  return (
    <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div>
        <p className="font-mono text-xs tracking-[0.2em] text-accent uppercase">Questions</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">Before you install</h2>
        <div className="mt-6 flex flex-col items-start gap-1">
          <ButtonLink to="https://docs.g1t.sh/guides/desktop/" variant="link" size="inline">
            The desktop app guide <ArrowRight size={14} />
          </ButtonLink>
          <ButtonLink to="https://docs.g1t.sh/guides/mobile/" variant="link" size="inline">
            The phone app guide <ArrowRight size={14} />
          </ButtonLink>
        </div>
      </div>
      <Card className="px-5">
        <Accordion type="single" collapsible defaultValue="stores">
          <AccordionItem value="stores">
            <AccordionTrigger>Why a download, and not Google Play or the App Store?</AccordionTrigger>
            <AccordionContent>
              Both stores publish a company's apps only once it is verified with a D-U-N-S number, and Flagon's is on its way. Until then the Android app is
              published {hosted ? "here" : "on g1t.sh"}, as the desktop app is. It moves into Google Play as soon as it can, and iOS follows through the App
              Store.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="unsigned">
            <AccordionTrigger>Why does my system warn me before opening it?</AccordionTrigger>
            <AccordionContent>
              <p>
                While g1t is in alpha, none of its builds are code-signed: not the desktop app, the Android app, the runner or the CLI. Your system can't tell
                who made them, so it warns you the first time. To open one anyway:
              </p>
              <ul className="mt-3 space-y-1.5">
                {(["windows", "macos", "linux", "android"] as const).map((id) => (
                  <li key={id}>
                    <span className="text-fg-soft">{PLATFORMS[id].name}:</span> {UNSIGNED[id]}
                  </li>
                ))}
              </ul>
              <p className="mt-3">
                Check a download against its SHA-256 first. The desktop app's own updates are checked against g1t's signature before they install.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="check">
            <AccordionTrigger>How do I check a download?</AccordionTrigger>
            <AccordionContent>
              Each file's SHA-256 shows when you point at its name, and every release lists them in SHA256SUMS beside its files
              {release ? (
                <>
                  , as in{" "}
                  <a href={`/downloads/desktop/${release.version}/SHA256SUMS`} className="text-accent hover:underline">
                    version {release.version}'s
                  </a>
                </>
              ) : null}
              . The apps check their own updates against g1t's signature.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="own">
            <AccordionTrigger>Do the apps work with my own g1t?</AccordionTrigger>
            <AccordionContent>
              Yes. In the desktop app's tray, Use another g1t points it at your server. The phone app signs in to any g1t from its sign-in screen, or from the
              code on that g1t's download page.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>
    </section>
  );
}
