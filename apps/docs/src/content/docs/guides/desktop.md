---
title: The desktop app
description: g1t in a window of its own, for Windows, macOS and Linux, with notifications from your system, a badge on the icon, g1t:// links, a runner for your workspace's jobs, and updates that install themselves.
---

The desktop app is g1t in a window of its own. Everything in it is the
site, [g1t.sh](https://g1t.sh), loaded live: chat, agents, artifacts and
code, exactly as in a browser, so every change to g1t reaches the app the
moment it is deployed. What the app adds is what a browser cannot do:

- **Notifications from your system**, for a message to you, a mention or
  an agent finishing something, while the window is behind another.
- **A badge on the icon**, with what is waiting for you, and a tray icon
  that keeps g1t running when the window is closed.
- **`g1t://` links**, which open a page in the app from anywhere on your
  computer.
- **Updates that install themselves**, signed by g1t, in the background.
- **Your own g1t**, if you [run one](/guides/self-hosting/): the app points
  at any server.
- **A runner for your workspace**, started with the app, so your
  computer runs the workspace's `runs-on: self-hosted` jobs while g1t is
  open, with nothing to install or register. See [the runner](#the-runner).
- **Settings of its own**: opening when you sign in to your computer,
  what closing the window does, notifications, the badge, zoom, updates
  and the runner.

Get it at [g1t.sh/download](https://g1t.sh/download), or from your account
menu, **Get the desktop app**.

## Install

| Platform | What you get | Notes |
| --- | --- | --- |
| **Windows** 10 and 11 | An installer, `g1t-<version>-windows-x64-setup.exe` | Installs for your account alone; no administrator needed. Uses the WebView2 runtime Windows already has, and fetches it if a machine lacks it. |
| **macOS** 11 and later | A disk image, Apple silicon or Intel | Drag g1t to Applications. The app is not yet notarized with Apple: the first time, right-click it and choose **Open**. |
| **Linux** | An AppImage, a `.deb` or an `.rpm` | The AppImage runs anywhere once made executable (`chmod +x`). It needs WebKitGTK 4.1, which the packages install for you. |

Every file's SHA-256 is in `SHA256SUMS` beside it, at
`https://g1t.sh/downloads/desktop/<version>/`.

The app opens on g1t.sh's sign-in page, not the site's landing page: it
is for using g1t, not for reading about it. It keeps you signed in like a
browser does, and signing out brings you back to the sign-in page.
Signing in with GitHub goes to github.com and comes back inside the
window.

## Notifications and the badge

Inside the app, the **Desktop notifications** switch in
[Settings → Notifications](/guides/notifications/#settings) is on and the
app shows them itself: while the window is behind another or hidden, a
message to you shows as a notification from your system, under the same
rules as in a browser: [what you chose to be told about](/guides/chat/#notifications),
never while [Do not disturb](/guides/chat/#sounds-and-do-not-disturb) is
on, never for a muted conversation. With the window in front, the pop-up
in the corner shows instead, as on the site. Clicking a notification
brings the app forward; opening the conversation it is about from the
notification is coming.

The icon carries a badge with what is waiting for you: the count on macOS
and Linux, a lavender dot on Windows. The tray icon's hover text says the
number everywhere. With a notification, the taskbar icon flashes on
Windows and the dock icon bounces on macOS, while the window is not in
front. [The app's settings](#settings) turn off each of these: the
notifications, the flash and the badge.

[Chat sounds](/guides/chat/#sounds-and-do-not-disturb) play as on the
site, through the app's own audio.

## The window and the tray

Closing the window hides it; g1t keeps running in the tray (the menu bar
on macOS) so notifications still arrive. Click the tray icon, or its
**Open g1t**, to bring the window back; on macOS the dock icon does too.
**Quit g1t** in the tray menu ends it. The window remembers its size and
place. To have closing the window quit instead, turn off **Keep g1t
running when the window closes** in [the app's settings](#settings).

The tray menu also holds **Settings…**, **Check for updates…**, **Use
another g1t…** and, when an update is downloaded, **Restart to update**.

### The title bar

g1t draws its own title bar, as Slack and Discord do, so the whole window
is g1t and looks the same on Windows, macOS and Linux. It takes the
colours of g1t's rail, in light and dark.

| Part | What it does |
| --- | --- |
| **☰** (Windows and Linux) | Opens the app's [menu](#the-menu). |
| **← →** | Back and forward through the pages you have been on. |
| **Search** | In the middle: searches your workspace, as **Ctrl+K** or **⌘K** does. Before you are signed in, it shows the page's title. |
| **Minimize, maximize, close** (Windows and Linux) | At the right. Close keeps g1t in the tray unless [the settings](#settings) say it quits. On macOS the window's own buttons sit at the left of the bar. |

Drag the bar to move the window, and double-click it to maximize or
restore it. The bar is there on every page the window shows, signing in
with GitHub included, and the page sits below it, never under it.

To have the system's title bar instead, turn on **Use the system's title
bar** in [the settings](#settings). On Windows and Linux the menu bar
comes back under it. g1t restarts to change it: the settings window offers
**Restart now**.

### The menu

The app has the menus a desktop app has: under **☰** at the left of the
title bar on Windows and Linux, or under the system's title bar if you
use it, and at the top of the screen on macOS. Their shortcuts work
either way.

| Menu | What is in it |
| --- | --- |
| **File** (**g1t** on macOS) | **Settings** (Ctrl+, or ⌘,), **Use another g1t…**, **Close window** (Ctrl+W), **Quit g1t** (Ctrl+Q or ⌘Q) |
| **Edit** | Undo, redo, cut, copy, paste and select all |
| **View** | **Reload** (Ctrl+R), **Actual size** (Ctrl+0), **Zoom in** (Ctrl+=), **Zoom out** (Ctrl+-), full screen |
| **Go** | **Back** (Alt+Left, or ⌘[), **Forward** (Alt+Right, or ⌘]), **Home**, **Notifications** |
| **Window** | Minimize and maximize |
| **Help** | **Desktop app guide** and **g1t.sh status**, in your browser; **Check for updates…**; **Restart to update**, once one is downloaded; **About g1t** |


## Settings

The app's own settings are in a window of their own: **Settings** in the
File menu (the g1t menu on macOS), **Settings…** in the tray, or **Desktop
app settings** in your account menu on g1t. Each change takes effect at
once and is kept on this computer. Your account's settings, which things
notify you among them, stay on g1t, in [your settings](/guides/notifications/#settings).

| Setting | Default | What it does |
| --- | --- | --- |
| **Open g1t when you sign in** | Off | Starts g1t with your computer. The system keeps this: a login item on macOS, a startup entry on Windows, an autostart entry on Linux. |
| **Start in the tray** | On | Opened at sign-in, g1t waits in the tray without opening its window. Opening it yourself always shows the window. |
| **Keep g1t running when the window closes** | On | Closing the window leaves g1t in the tray for notifications. Off, closing the window quits. |
| **Show notifications** | On | Notifications from your system. Off, nothing pops up from the app, whatever your account's settings say. |
| **Flash the taskbar icon** (**Bounce the dock icon** on macOS) | On | Asks for your attention with a notification while the window is not in front. |
| **Show a badge on the icon** | On | The count, or the dot on Windows. Off, the icon stays clean; the tray's hover text still counts. |
| **Use the system's title bar** | Off | The system's title bar in place of [g1t's own](#the-title-bar), with the menu bar under it on Windows and Linux. Takes effect when g1t restarts. |
| **Zoom** | 100% | How large g1t is drawn, from 67% to 200%. The View menu changes it too. |
| **Download updates by themselves** | On | Off, the app never checks on its own; **Check for updates** still does. The runner's updates follow it too. |
| **Run jobs on this computer while g1t is open** | On | Starts [the runner](#the-runner) a few seconds after the window. Off, nothing runs. |
| **How jobs run** | Sandboxed | Sandboxed, in Docker, or directly on this computer. See [how jobs run](#how-jobs-run). |
| **Workspace** | The one you were in when it first registered | The workspace whose jobs the runner runs. Lists the workspaces you own. |

The settings window also shows the app's version and whether it is up to
date, with **Check for updates** (see [Updates](#updates)), and the server it opens, with **Change…** to [use another
g1t](#your-own-g1t).

## The runner

The app runs a [self-hosted runner](/guides/self-hosted-runners/) for
you while it is open: your workspace's jobs that ask for `self-hosted`
run on your computer, at no cost, and nothing has to be downloaded,
registered or started by hand. It starts a few seconds after the window
opens, and stops when g1t quits. Time on it is free, as on any of your
runners.

To stop it, press **Stop** in the settings window's Runner section, or
**Stop running jobs** in the tray; it starts again with **Start**, or the
next time g1t opens. To keep it off, turn off **Run jobs on this computer
while g1t is open** in [the settings](#settings).

A job still runs only on a runner with every label it names. The app's
runner has `self-hosted`, its OS and architecture (`linux` for a runner
whose jobs run in containers, whatever the computer is), and `desktop`.
It is named after your computer, and a new registration from the same
computer takes the place of the old one.

### How jobs run

**How jobs run** in the settings decides what a job on your computer can
reach. The app never changes it by itself: when the one you chose cannot
start, it says why and runs nothing.

| Choice | How | [Isolation](/guides/self-hosted-runners/#isolation) | What a job can reach |
| --- | --- | --- | --- |
| **Sandboxed** (the default) | The runner in a sandbox of its own, and each job in a container inside that. On Linux, the runner's image under [Sysbox](https://github.com/nestybox/sysbox), through your Docker, without its socket. On Windows and macOS, a small virtual machine the app makes, once that is released; until then it says *a sandbox isn't available on this computer yet*. | `nested-container` | Its own container. Not your computer. |
| **In Docker** | `g1t-runner` on your computer, driving your Docker. Each job is a container of its own. | `container` | Its own container; but the runner controls your Docker, which can reach your files (Docker Desktop shares your home folder with its VM), so this is not a sandbox. |
| **Directly on this computer** | `g1t-runner` on your computer, each job a process in a folder of its own. For jobs that need the system itself, such as building a Windows installer. | `host` | Everything your account can: your files, your keys, what an earlier job left. Not a sandbox. Never given a public repository's work. |

On Linux, the sandboxed runner is this container, which the app starts,
replaces and stops itself:

```sh
docker run -d --name g1t-desktop-runner --runtime=sysbox-runc \
  -v g1t-desktop-runner:/data \
  -e G1T_RUNNER_URL -e G1T_RUNNER_NAME -e G1T_RUNNER_LABELS=desktop … \
  g1t.sh/flagon-io/g1t-runner:latest register-and-run
```

Its registration is kept on the `g1t-desktop-runner` volume. For the
other two choices the app keeps `g1t-runner` in its data folder
(`%APPDATA%\sh.g1t.desktop\runner` on Windows,
`~/Library/Application Support/sh.g1t.desktop/runner` on macOS,
`~/.local/share/sh.g1t.desktop/runner` on Linux), with each choice's
registration beside it.

### Registering

The first time, and whenever you change the workspace or how jobs run,
the app registers your computer with the workspace. It needs you signed
in to g1t in the app as an owner of the workspace, since only owners add
runners: the page you are on makes a registration token, which lasts an
hour, and hands it to the app, which gives it to the runner once. The
token is never shown, and is not kept. From then on the runner starts
from its registration, signed in or not.

The workspace is the one you were in when it first registered; choose
another under **Workspace** in the settings. Changing it, or how jobs
run, waits for a job that is running to end, then removes the old
registration and makes a new one.

### Keeping it up to date

The app keeps the runner up to date: soon after it starts and every six
hours, while the runner has no job, it looks for a newer `g1t-runner` in
`g1t.sh/downloads/runner/latest.json` (or a newer image, for the
sandbox), downloads it, checks it against the release's SHA-256, and puts
it in place. A job is never cut short for an update, and one that fails
leaves the runner as it was. Turning off **Download updates by
themselves** turns these off too.

### Seeing it

| Where | What it shows |
| --- | --- |
| The tray | A row with what the runner is doing, *Runner: Waiting for jobs*, which opens the settings; **Stop running jobs** or **Start running jobs** under it. The icon's hover text says it too. |
| The settings window | What it is doing; when it isn't running, why and how to fix it, with the fix's buttons; how jobs run; the workspace; your computer's name and the runner's version; **View on g1t**; and the runner's recent log, with **Open the whole log**. |
| The workspace's [Runners page](/guides/self-hosted-runners/#the-runners-page) | **Desktops**: every computer with the app in the workspace, with what each is doing, or why it isn't running and the fix, in the same words. Inside the app, this computer comes first, live, with its buttons. A computer whose g1t is closed says *g1t is closed on* its name. |

### When it isn't running

Each state says why, and how to fix it, in the same words in the tray,
the settings and the Runners page.

| It says | Why | What to do |
| --- | --- | --- |
| *Waiting for jobs* | It is registered and listening. | Nothing. |
| *Running* a job | It is running that job. | Nothing; the Runners page links to its run. |
| *Starting*, *Registering with* a workspace, *Updating* | It is on its way. | Wait a few seconds. |
| *Not running: turned off* | **Run jobs on this computer while g1t is open** is off. | **Turn on**. |
| *Not running: stopped* | You pressed **Stop**. | **Start**, or open g1t again. |
| *Not running: signed out* | It isn't registered yet, and registering needs you signed in. | **Sign in**, as an owner of the workspace. |
| *Not running: no workspace to run jobs for* | You don't own a workspace, and only owners add runners. | Ask an owner, or **Create a workspace**. |
| *Couldn't register with* a workspace: *only its owners can* | You aren't an owner of it. | Ask an owner to make you one, or **Choose workspace**. |
| *Couldn't register with* a workspace, with g1t's reason | g1t refused the registration, such as for too many tokens in an hour. | **Retry**; it also tries again by itself. |
| *Not running: Docker isn't running* | Running jobs in Docker, or the sandbox on Linux, needs Docker, and it isn't running or isn't installed. | **Open Docker** (Docker Desktop), or **Get Docker**. It starts by itself once Docker answers. |
| *Not running: a sandbox isn't available on this computer yet* | The sandbox for Windows and macOS isn't released. | Wait for it, or **Choose how jobs run**: in Docker or directly on this computer, neither of which is a sandbox. |
| *Not running: Sysbox isn't installed* | The sandbox on Linux needs Sysbox in your Docker. | **Install Sysbox**. |
| *Offline:* the server *unreachable* | Your computer can't reach g1t. | Check the connection; it carries on by itself. **Retry** tries now. |
| *Update failed* | A new version couldn't be downloaded, or its SHA-256 wasn't the release's. | It keeps running the version it has. **Retry**, or **Report** it. |
| *Runner stopped (exit code* N*)* | The runner ended by itself, with the reason from its log. | It starts again by itself, waiting longer each time. **Restart** now, or **View log**. |
| *g1t is closed on* a computer | Seen on the Runners page: g1t hasn't been open on that computer for ten minutes. | Open g1t there. |

## Links

A **`g1t://` link** opens a page in the app: `g1t://acme/-/chat/dm/chn_1`
is `g1t.sh/acme/-/chat/dm/chn_1`. The installer registers the scheme; a
link opened while the app is running moves it to the page without a
reload, and one opened while it is not starts it there. Scripts, launchers
and other apps on your computer can use it.

A link to another site opens in the browser your system uses; the window
stays on g1t. That includes this documentation and the status page. So do
g1t's own pages for reading about g1t rather than using it: pricing, the
policies, security, support and the downloads. Links on g1t that would
open a new tab open in the window instead, as it has no tabs. Signing in
with GitHub is the one trip outside g1t that stays in the window.

## Updates

The app asks `g1t.sh/downloads/desktop/latest.json` for a newer version
shortly after it starts and every six hours, and downloads one in the
background. It never installs under you: a notification and the tray's
**Restart to update** say it is ready, and the restart, or quitting,
installs it.

To see where your copy stands, choose **Check for updates…** in the Help
menu or the tray, or **Check for updates** in [the settings](#settings).
The menu and the tray open the settings window at its Updates section,
which checks and says the answer there:

- **Up to date. Last checked today at 10:42.** You have the newest version.
- **Version 0.2.0 is downloaded and installs when g1t restarts.** A
  **Restart now** button beside it installs it and opens the new version,
  as **Restart to update** in the Help menu and the tray do.
- **Could not reach g1t.sh to check.** Try again once you are online.

A check finds and downloads a new version in one go, so the answer can
take a moment on a slow connection. The automatic checks and yours are the
same check: a version the background found is shown as downloaded when
you look. To stop the app checking on its own, turn off
**Download updates by themselves** in [the settings](#settings).

Every release is signed with g1t's key, whose public half is built into
the app; a download whose signature does not check out is thrown away.
Because the window shows the site itself, most changes to g1t need no
update at all: the app updates when something native changes.

## Your own g1t

If you [run g1t yourself](/guides/self-hosting/), point the app at it:
**Use another g1t…** in the tray or the File menu, or **Change…** in [the
settings](#settings), then your server's address, such as
`https://g1t.example.com`. The app keeps it and opens there from then on;
**Use g1t.sh** on the same page goes back. Only that server's pages can
talk to the app, whichever it is, and updates still come from g1t.sh.

## What's not there yet

- **The sandbox, from the app, on Windows and macOS.** The sandbox itself
  is built: `g1t-runner sandbox up` makes a computer a self-hosted runner
  that nothing a job runs can get out of, with Linux jobs in a Linux VM of
  the runner's own and, on Windows 11 Pro and up, Windows jobs each in a
  Windows Sandbox ([the sandbox](/guides/self-hosted-runners/#sandbox-on-your-computer)).
  The app does not start it for you yet, so until it does, its runner on
  Windows and macOS runs jobs only if you choose Docker or this computer
  itself; see [how jobs run](#how-jobs-run).
- **Agents on your desktop.** The runner takes workflow jobs, and agent
  work only if the workspace [sends it to its runners](/guides/self-hosted-runners/#agents-on-your-runners).
- **Opening the conversation from a notification.** Clicking one brings
  the app forward; the page it is about is coming.
- **A page of its own while offline.** If the network goes away while a
  page is open, the window shows the web view's own error until it is
  back; starting without a network shows the app's own page, with a retry.
- **Notarization on macOS**, so the first open needs no right-click.
- **A phone app.** It is being built: see [the phone app](/guides/mobile/).

## For operators: releasing the app

The app lives in `apps/desktop` in [g1t's repository](https://g1t.sh/flagon-io/g1t):
a Tauri shell in Rust under `src-tauri`, and a launcher page it bundles.
A release is a tag `desktop-v<version>`, where the version is the one in
`apps/desktop/src-tauri/Cargo.toml`: push it, and the `Desktop release`
workflow builds the installers, signs the updater's files, publishes the
release to the `g1t-downloads` bucket and points `latest.json` at it.
`scripts/desktop-release.mjs` does the same by hand, and its header lists
the files a release holds.

| What | Where |
| --- | --- |
| The updater's signing key | `node scripts/desktop-release.mjs keygen`, once. The private key is the repository secret `DESKTOP_SIGNING_KEY`; the public key is `plugins.updater.pubkey` in `tauri.conf.json`. Losing the private key means every installed app stops updating: keep it. |
| Linux builds | g1t's own Linux machines, in every release. |
| Windows builds | Either a Windows machine registered as a [self-hosted runner](/guides/self-hosted-runners/) with the labels `self-hosted` and `windows` (Rust, Node and the Visual Studio build tools on it) and the repository variable `DESKTOP_WINDOWS_RUNNER` set to `true`; or, with no Windows machine, `DESKTOP_WINDOWS_FROM_LINUX` set to `true`, which cross-builds on Linux with `cargo-xwin` and NSIS and needs `aka.ms` and `download.visualstudio.microsoft.com` among the project's [workflow-only domains](/guides/guardrails/#workflow-only-domains) for `desktop-release.yml` in `production`, where the MSVC runtime is fetched from. |
| macOS builds | A Mac, registered as a self-hosted runner with the labels `self-hosted` and `macos`, and the repository variable `DESKTOP_MACOS_RUNNER` set to `true`. |
| A platform with no machine | Its job is skipped and the release goes out with the rest; the download page says which platforms a release lacks, and the next release fills them in. |
| Where releases are served | `g1t.sh/downloads/desktop/<version>/<file>`, from the same bucket as the runner's and the CLI's releases. |

A self-hosted g1t does not serve the app's releases: the app always
updates from g1t.sh, and `g1t.sh/download` is where to send people.
