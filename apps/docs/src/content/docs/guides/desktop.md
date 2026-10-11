---
title: The desktop app
description: g1t in a window of its own, for Windows, macOS and Linux, with notifications from your system, a badge on the icon, g1t:// links, and updates that install themselves.
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

The app opens on g1t.sh and asks you to sign in once; it keeps you signed
in like a browser does. Signing in with GitHub goes to github.com and comes
back inside the window.

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
number everywhere.

[Chat sounds](/guides/chat/#sounds-and-do-not-disturb) play as on the
site, through the app's own audio.

## The window and the tray

Closing the window hides it; g1t keeps running in the tray (the menu bar
on macOS) so notifications still arrive. Click the tray icon, or its
**Open g1t**, to bring the window back; on macOS the dock icon does too.
**Quit g1t** in the tray menu ends it. The window remembers its size and
place.

The tray menu also holds **Check for updates…**, **Use another g1t…** and,
when an update is downloaded, **Restart to update**.

## Links

A **`g1t://` link** opens a page in the app: `g1t://acme/-/chat/dm/chn_1`
is `g1t.sh/acme/-/chat/dm/chn_1`. The installer registers the scheme; a
link opened while the app is running moves it to the page without a
reload, and one opened while it is not starts it there. Scripts, launchers
and other apps on your computer can use it.

A link to another site opens in the browser your system uses; the window
stays on g1t. Links on g1t that would open a new tab open in the window
instead, as it has no tabs. Signing in with GitHub is the one trip
outside g1t that stays in the window.

## Updates

The app asks `g1t.sh/downloads/desktop/latest.json` for a newer version
shortly after it starts and every six hours, and downloads one in the
background. It never installs under you: a notification and the tray's
**Restart to update** say it is ready, and the restart, or quitting,
installs it. **Check for updates…** in the tray asks now and tells you the
answer.

Every release is signed with g1t's key, whose public half is built into
the app; a download whose signature does not check out is thrown away.
Because the window shows the site itself, most changes to g1t need no
update at all: the app updates when something native changes.

## Your own g1t

If you [run g1t yourself](/guides/self-hosting/), point the app at it:
**Use another g1t…** in the tray menu, then your server's address, such as
`https://g1t.example.com`. The app keeps it and opens there from then on;
**Use g1t.sh** on the same page goes back. Only that server's pages can
talk to the app, whichever it is, and updates still come from g1t.sh.

## What's not there yet

- **A runner inside the app**, so an agent can work on your own machine
  with what only it reaches, as [the runners page](/guides/self-hosted-runners/)
  says. The self-hosted runner works on the same machine meanwhile.
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
| Windows and Linux builds | A Linux machine builds both: Linux natively, Windows with `cargo-xwin` and NSIS. |
| macOS builds | A Mac, registered as a [self-hosted runner](/guides/self-hosted-runners/) with the labels `self-hosted` and `macos`, and the repository variable `DESKTOP_MACOS_RUNNER` set to `true`. Without one, the macOS job is skipped and the release carries Windows and Linux. |
| Where releases are served | `g1t.sh/downloads/desktop/<version>/<file>`, from the same bucket as the runner's and the CLI's releases. |

A self-hosted g1t does not serve the app's releases: the app always
updates from g1t.sh, and `g1t.sh/download` is where to send people.
