---
title: The desktop app
description: g1t in a window of its own, for Windows, macOS and Linux, with notifications from your system, a badge on the icon, g1t:// links, a runner for your workspace's jobs, and updates that install themselves.
---

The desktop app is g1t in a window of its own. Everything in it is the
site, [g1t.sh](https://g1t.sh), loaded live: chat, artifacts and code,
exactly as in a browser, so every change to g1t reaches the app the moment
it is deployed. What the app adds is what a browser cannot do:

- **Notifications from your system**, for a message to you or a mention,
  while the window is behind another.
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
  what closing the window does, notifications, the badge, zoom,
  developer tools, updates and the runner.

Get it at [g1t.sh/download](https://g1t.sh/download), or from your account
menu, **Get the desktop app**. The page opens on the system you visit it
from, with every other platform a tab away, and lists the
[runner](/guides/self-hosted-runners/) and the g1t CLI for each system
under **Command line**.

## Install

| Platform               | What you get                                        | Notes                                                                                                                                          |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows** 10 and 11  | An installer, `g1t-<version>-windows-x64-setup.exe` | Installs for your account alone; no administrator needed. Uses the WebView2 runtime Windows already has, and fetches it if a machine lacks it. |
| **macOS** 11 and later | A disk image, Apple silicon or Intel                | Drag g1t to Applications.                                                                                                                      |
| **Linux**              | An AppImage, a `.deb` or an `.rpm`                  | The AppImage runs anywhere once made executable (`chmod +x`). It needs WebKitGTK 4.1, which the packages install for you.                      |

Every file's SHA-256 is in `SHA256SUMS` beside it, at
`https://g1t.sh/downloads/desktop/<version>/`.

### Unsigned during the alpha

While g1t is in alpha, none of its builds are code-signed: not the desktop
app, the Android app, the runner or the CLI. Your system can't tell who made
them, so it warns you the first time you open one. Check the file against
its SHA-256, then:

- **Windows**: when SmartScreen says it protected your PC, choose **More
  info**, then **Run anyway**.
- **macOS**: when it says it can't check g1t, open **System Settings →
  Privacy & Security** and choose **Open Anyway**.
- **Linux**: your package manager may say the `.deb` or `.rpm` isn't
  signed. The AppImage needs only `chmod +x`.

The app's own updates are different: each is checked against g1t's
signature before it installs.

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

g1t draws its own title bar, so the whole window is g1t and looks the
same on Windows, macOS and Linux. It takes the colours of g1t's rail, in
light and dark.

| Part                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **☰** (Windows and Linux)                        | Opens the app's [menu](#the-menu).                                                                                                                                                                                                                                                                                                                                                                                |
| **← →**                                           | Back and forward through the pages you have been on.                                                                                                                                                                                                                                                                                                                                                              |
| **Search**                                        | In the middle: searches your workspace, as **/** does. Before you are signed in, it shows the page's title.                                                                                                                                                                                                                                                                                                       |
| **The runner's dot**                              | At the right, right beside **Settings**: a small circle in the colour of what [the runner](#the-runner) is doing, live: green while it runs, blue and breathing while it works (_Running a job_, _Runner starting_, _Runner updating_), amber or red when it needs you, grey when it is stopped or off. Hover it for the words; a wide window shows them beside it. It opens [the runner menu](#the-runner-menu). |
| **Settings**                                      | Opens [the settings](#settings) over the page.                                                                                                                                                                                                                                                                                                                                                                    |
| **Minimize, maximize, close** (Windows and Linux) | At the right. Close keeps g1t in the tray unless [the settings](#settings) say it quits. On macOS the window's own buttons sit at the left of the bar.                                                                                                                                                                                                                                                            |

Drag the bar to move the window, and double-click it to maximize or
restore it. The bar is there on every page the window shows, signing in
with GitHub included, and the page sits below it, never under it.

To have the system's title bar instead, turn on **Use the system's title
bar** in [the settings](#settings). On Windows and Linux the menu bar
comes back under it. g1t restarts to change it: the settings offer
**Restart now**.

### The menu

The app has the menus a desktop app has: under **☰** at the left of the
title bar on Windows and Linux, or under the system's title bar if you
use it, and at the top of the screen on macOS. Their shortcuts work
either way.

| Menu                        | What is in it                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File** (**g1t** on macOS) | **Settings** (Ctrl+, or ⌘,), **Use another g1t…**, **Close window** (Ctrl+W), **Quit g1t** (Ctrl+Q or ⌘Q)                                                                               |
| **Edit**                    | Undo, redo, cut, copy, paste and select all                                                                                                                                             |
| **View**                    | **Reload** (Ctrl+R), **Actual size** (Ctrl+0), **Zoom in** (Ctrl+=), **Zoom out** (Ctrl+-), full screen, **Developer tools** (Ctrl+Shift+I, or ⌥⌘I), once [turned on](#developer-tools) |
| **Go**                      | **Back** (Alt+Left, or ⌘[), **Forward** (Alt+Right, or ⌘]), **Home**, **Notifications**                                                                                                 |
| **Window**                  | Minimize and maximize                                                                                                                                                                   |
| **Help**                    | **Desktop app guide** and **g1t.sh status**, in your browser; **Check for updates…**; **Restart to update**, once one is downloaded; **About g1t**                                      |

## Settings

The app's own settings open over the page you are on, with their
sections down the left (**Starting and closing**, **Runner**,
**Notifications**, **Window**, **Updates**, **Server**, **About**) and the
one you choose on the right. Open them with the **Settings** button at the
right of the title bar, **Settings** in the File menu (the g1t menu on
macOS) or Ctrl+, (⌘, on macOS), **Settings…** in the tray, or **Desktop
app settings** in your account menu on g1t; the window comes forward if it
was hidden. Escape or **×** closes them. Each change takes effect at once
and is kept on this computer; there is nothing to save. Your account's
settings, which things notify you among them, stay on g1t, in
[your settings](/guides/notifications/#settings).

While the window shows no page of g1t's, such as the page that picks a
server, the page g1t shows when it can't reach the server, or signing in
with GitHub, the settings open in a window of their own instead, with the
same settings.

| Setting                                                        | Default | What it does                                                                                                                                                                 |
| -------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open g1t when you sign in**                                  | Off     | Starts g1t with your computer. The system keeps this: a login item on macOS, a startup entry on Windows, an autostart entry on Linux.                                        |
| **Start in the tray**                                          | On      | Opened at sign-in, g1t waits in the tray without opening its window. Opening it yourself always shows the window.                                                            |
| **Keep g1t running when the window closes**                    | On      | Closing the window leaves g1t in the tray for notifications. Off, closing the window quits.                                                                                  |
| **Show notifications**                                         | On      | Notifications from your system. Off, nothing pops up from the app, whatever your account's settings say.                                                                     |
| **Flash the taskbar icon** (**Bounce the dock icon** on macOS) | On      | Asks for your attention with a notification while the window is not in front.                                                                                                |
| **Show a badge on the icon**                                   | On      | The count, or the dot on Windows. Off, the icon stays clean; the tray's hover text still counts.                                                                             |
| **Use the system's title bar**                                 | Off     | The system's title bar in place of [g1t's own](#the-title-bar), with the menu bar under it on Windows and Linux. Takes effect when g1t restarts.                             |
| **Zoom**                                                       | 100%    | How large g1t is drawn, from 67% to 200%. The View menu changes it too.                                                                                                      |
| **Developer tools**                                            | Off     | F12 or Ctrl+Shift+I (⌥⌘I on macOS), and **Developer tools** in the View menu, open the web inspector for the page. See [Developer tools](#developer-tools).                  |
| **Download updates by themselves**                             | On      | Off, the app never checks on its own; **Check for updates** still does. The runner's updates follow it too: off, only **Check for runner updates** looks for a newer runner. |

**Updates** also shows the app's version and whether it is up to date,
with **Check for updates** (see [Updates](#updates)); **Server** shows the
server it opens, with **Change…** to [use another g1t](#your-own-g1t); and
**Runner** has [the runner's settings](#runner-settings) and a card for
each kind of job.

A button that asks the app to do something, such as **Check for updates**,
**Restart now**, **Retry**, **Start** or **Stop**, shows a spinner and
can't be pressed again until what it asked for shows: the runner's state
changes, the answer comes, or, after 20 seconds with no change, it is
yours to press again. If the app couldn't do it, the settings say why.

### Developer tools

When a page goes wrong, such as one that says _Something went wrong_, the
web inspector shows why: the page's console, its network requests and its
code. It is off unless you turn on **Developer tools** in the settings'
**Window** section. Then any of these opens it for the page in the window:

- **F12**, on the page.
- **Ctrl+Shift+I** on Windows and Linux, **⌥⌘I** (Cmd+Option+I) on macOS.
- **Developer tools** in the View menu.

On macOS and Linux the same keys, or the menu row, close it again; on
Windows, close the inspector's own window. With the setting off, none of
them open it, and the View menu's row is greyed out. On Windows the change
takes effect at once; on macOS and Linux it takes effect when g1t
restarts, and the settings offer **Restart now**.

g1t's pages can open it too, from `window.g1tDesktop.devtools.open()`,
which works only while the setting is on and only for g1t's own pages.

## The runner

The app runs a [self-hosted runner](/guides/self-hosted-runners/) for
you while it is open: your workspace's jobs that ask for `self-hosted`
run on your computer, at no cost, and nothing has to be downloaded,
registered or started by hand. It starts a few seconds after g1t's page has loaded
(or after 20 seconds without it), and stops when g1t quits; sandboxed, it
runs on while g1t restarts ([Updates](#updates)). It runs apart
from the window: a runner that fails starts again on its own, and never takes
the app down with it. Time on it is free, as on any of your
runners.

To stop it, press **Stop** in [the runner menu](#the-runner-menu), or
**Stop running jobs** in the tray; it starts again with **Start**, or the
next time g1t opens. To keep it off, turn off **Run jobs on this computer
while g1t is open** in [the runner's settings](#runner-settings).

Sandboxed, each kind of job has its own line in the runner menu and card
in the settings, **Linux jobs** and **Windows jobs**, each with its own **Stop**
and **Start**. Stopping Windows jobs leaves Linux jobs running, and the
other way round; a kind you stop stays stopped, across restarts, until you
start it again. Both are on until you stop one.

Jobs that ask for `ubuntu-latest` or another Linux label of g1t's machines
run on it too, while it is idle and takes their [size](#job-sizes), unless your workspace turned off **Prefer our runners for
hosted labels**; otherwise they run on g1t's machines. They run in
[g1t's machine image](/guides/self-hosted-runners/#g1ts-machine-image),
which has what g1t's machines have, published at
`g1t.sh/flagon-io/g1t-hosted` with each runner release. The runner pulls it
once, about 5.6 GB, in the background when it first starts, and takes these
jobs only once it has it; until then they run on g1t's machines. It is x64
only: on an Apple silicon Mac or another arm64 computer, the runner takes
none of them. Such a job gets its run's secrets on your computer, as any
job here does. See [jobs that ask for g1t's
machines](/guides/self-hosted-runners/#jobs-that-ask-for-g1ts-machines).

A job still runs only on a runner with every label it names. The app's
runner has `self-hosted`, its OS and architecture (`linux` for a runner
whose jobs run in containers, whatever the computer is), and `desktop`.
It is named after your computer, and a new registration from the same
computer takes the place of the old one. Sandboxed, the computer has a
runner for each kind of job it can run, named after it with `-linux` or
`-windows`: `build-box-linux` has `linux`, and `build-box-windows` has
`windows`, on a Windows computer with Windows Sandbox.

### The runner menu

The runner's dot, right beside **Settings** in the title bar, opens its
menu, under the dot. The runner's row in the tray opens it too. It shows,
live:

- What the runner is doing, how jobs run, the workspace and the runner's
  version, with **Stop** or **Start** for the whole runner.
- When the runner needs you, why, and the fix with its buttons.
- Each kind of job, sandboxed: its state, the job it is running with a link
  to its run, a newer runner waiting for it, why it isn't running and the
  fix, and its own **Stop** or **Start**.
- When the app last looked for a newer runner, with **Check for runner
  updates**.
- The last lines of the runner's log, with **Open the whole log**.
- **Runner settings…**, which opens [the settings](#settings) at Runner.

Escape, a click outside it, or the dot again closes it. While the window
shows no page of g1t's, the dot and the tray open the Runner window
instead: the same, in a window of its own.

### Runner settings

The settings' **Runner** section has a card for each kind of job, as the
menu has them with more detail (its runner's name on g1t, its version and
isolation), and these:

| Setting                                         | Default                                      | What it does                                                                                     |
| ----------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Run jobs on this computer while g1t is open** | On                                           | Starts the runner a few seconds after g1t's page loads. Off, nothing runs.                       |
| **How jobs run**                                | Sandboxed                                    | Sandboxed, in Docker, or directly on this computer. See [how jobs run](#how-jobs-run).           |
| **Linux jobs**, **Windows jobs** (sandboxed)    | Both on                                      | Each kind of job's card has its own **Stop** and **Start**, which leave the other kind as it is. |
| **Workspace**                                   | The one you were in when it first registered | The workspace whose jobs the runner runs. Lists the workspaces you own.                          |

Choosing **In Docker** or **Directly on this computer** opens the Runner
window, a page that comes with the app, and you choose it there. Jobs
outside the sandbox can reach your files, so the app takes that choice
only from its own pages, never from a page g1t's server sends; going back
to **Sandboxed** works from either.

[Seeing it](#seeing-it) says what else it shows.

### Job sizes

Sandboxed, the **Runner** section has a **Job sizes** card: which of g1t's
machines your Linux jobs take jobs that ask for one of them for
([sizes](/guides/self-hosted-runners/#sizes)). It shows:

- **Sandbox**: how a job is kept from your computer, in plain words: a
  nested container (each job in a fresh container inside the runner's own
  sandbox), a VM, or the host.
- **This computer**: its CPUs and memory.
- **Linux sandbox**: its share of them, which no job gets more of, and on
  Windows what WSL's VM has (its `processors` and `memory` in
  `%USERPROFILE%\.wslconfig`, else every CPU and half the memory). **Sandbox
  CPUs** and **Memory (GB)** change it with **Set share**, and a warning
  says when it is more than half your computer or more than WSL's VM.
- Each size, **Small** (1 vCPU, 6 GB), **Standard** (2 vCPU, 8 GB) and
  **Large** (4 vCPU, 12 GB), ticked when your runner takes it, with
  **CPUs** and **Memory (GB)** to give its jobs more than the size (never
  fewer CPUs, and memory down to the size's least: 4, 6 and 8 GB), and a
  warning under a size that is more than half your computer or more than
  the sandbox has. A size the sandbox holds with all its CPUs but less of
  its memory still runs, with the memory there is: _Runs with 8 GB instead
  of 12 GB: jobs that need all of it may run out of memory_, and a job
  that does runs again on g1t's machines. A warning never stops you
  offering it.

You choose nothing to start with: the first time the sandbox starts, one
size is picked and ticked for you, with why: Standard if it fits in half
your computer and in the sandbox's share, else Small, else none (_Chosen
for you: Standard fits in half this machine's 16 CPUs and 32 GB and in the
sandbox's 8 vCPU, 8 GB_); else Standard, then Small, at its least memory.
It is never Large. Tick more, untick it, or give it more, and **Save
sizes**; **Choose for me** picks again. What you save is kept, and Linux
jobs start again with it after the job they are running, if any, without
registering again.

Saving sizes grows the sandbox's share to hold the largest one you ticked:
at least its CPUs, and its memory plus 1 GB for the runner itself. Large
in a share of 8 CPUs and 8 GB makes it 8 CPUs and 13 GB. It never shrinks a
share, so one you set stays at least that. A share left alone is half your
computer's CPUs (at most 16) and a quarter of its memory (2 to 16 GB).
Changing the share starts Linux jobs again after the job they are running,
as changing sizes does.

The card shows with g1t-runner 0.3.6 and the app 0.3.11 or later; the
share's fields with g1t-runner 0.3.7 and the app 0.3.12.

### How jobs run

**How jobs run**, in [the runner's settings](#runner-settings), decides what a job on your computer can
reach. The app never changes it by itself: when the one you chose cannot
start, it says why and runs nothing.

| Choice                        | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | [Isolation](/guides/self-hosted-runners/#isolation) | What a job can reach                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sandboxed** (the default)   | [The sandbox](/guides/self-hosted-runners/#sandbox-on-your-computer), which the app sets up and starts itself. Linux jobs run in a small Linux VM of the runner's own, each in a container inside it: a WSL 2 distribution on Windows, a VM under Apple's Virtualization framework on macOS, and on Linux the runner's image under [Sysbox](https://github.com/nestybox/sysbox), or a VM under QEMU with KVM. On Windows 11 Pro, Enterprise and Education, Windows jobs run too, each in a Windows Sandbox of its own. | `nested-container`; `vm` for Windows jobs           | Its own container, or its own Windows Sandbox. Not your computer.                                                                                                  |
| **In Docker**                 | `g1t-runner` on your computer, driving your Docker. Each job is a container of its own.                                                                                                                                                                                                                                                                                                                                                                                                                                | `container`                                         | Its own container; but the runner controls your Docker, which can reach your files (Docker Desktop shares your home folder with its VM), so this is not a sandbox. |
| **Directly on this computer** | `g1t-runner` on your computer, each job a process in a folder of its own. For jobs that need the system itself, such as building a Windows installer.                                                                                                                                                                                                                                                                                                                                                                  | `host`                                              | Everything your account can: your files, your keys, what an earlier job left. Not a sandbox. Never given a public repository's work.                               |

What the sandbox needs on each computer, and how the app gets it there,
is in [getting the runner running](#getting-the-runner-running).

The sandbox keeps jobs from your computer, not your computer from the
sandbox: anything running as your account can look inside it while a job
runs. So don't choose **Directly on this computer** under the same
account you use for the sandbox, and don't run software you don't trust
there. A runner registered for running jobs directly stays registered when
you choose another way, so remove it once you no longer use it:
`g1t-runner remove --dir <data folder>/host`, with the data folder below.
`g1t-runner sandbox status` warns while one is there. A job's secrets go from inside the sandbox
straight to g1t, the job's token left on your computer is spent once the
job has started, and the runner's folders are yours alone. [What your
computer can see](/guides/self-hosted-runners/#what-your-computer-can-see)
has the details.

For the sandbox, the app runs the same commands you would, with its own
copy of `g1t-runner` and its state in the app's local data folder, which
never roams to other computers with your profile
(`%LOCALAPPDATA%\sh.g1t.desktop\runner` on Windows, or
`%APPDATA%\sh.g1t.desktop\runner` where an earlier version set it up;
`~/Library/Application Support/sh.g1t.desktop/runner` on macOS;
`~/.local/share/sh.g1t.desktop/runner` on Linux):

| When                                                        | The app runs                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A few seconds after g1t's page loads                        | `g1t-runner sandbox up --json --state-dir <data folder>/sandbox --url <server> --name <computer> --labels desktop`, with the registration token the first time only, in its environment as `G1T_RUNNER_TOKEN`, never on its command line, where anyone on the computer could read it. The first `up` downloads and checks the sandbox's image and makes the VM, which takes a few minutes. |
| Every few seconds while it runs                             | `g1t-runner sandbox status --json`, for the tray, the settings and the Runners page.                                                                                                                                                                                                                                                                                                       |
| When g1t quits, or you press **Stop running jobs**          | `g1t-runner sandbox down`: a job that is running is cut short. Quitting asks first ([Updates](#updates)).                                                                                                                                                                                                                                                                                  |
| When g1t restarts, to update or for a setting               | Nothing: the sandbox runs on by itself, a job it is running too, and the `up` as g1t opens again finds it running and starts nothing.                                                                                                                                                                                                                                                      |
| When you press **Stop** on one kind of job's card           | `g1t-runner sandbox down --only windows` (or `linux`): that kind stops, a job of its own cut short, and stays off; the other runs on. Every `up` names the kinds that are on, `--only linux,windows`, so one you stopped never starts by itself.                                                                                                                                           |
| When you press **Start** on one kind of job's card          | `g1t-runner sandbox up --only windows` (or `linux`), leaving the other as it is. A kind never registered is registered first, with a token as above.                                                                                                                                                                                                                                       |
| While one kind of job runs and the other should and doesn't | `g1t-runner sandbox up --only` it again, by itself: every five minutes while the newest release has no sandbox images, else after a wait that grows each time, up to ten minutes. **Retry** or **Check now** tries at once.                                                                                                                                                                |
| When you choose another way of running jobs                 | `g1t-runner sandbox down --drain`, once the job that is running ends. The sandbox keeps its registration, so choosing Sandboxed again needs no new one.                                                                                                                                                                                                                                    |
| With a new release, once Linux jobs have no job             | `g1t-runner sandbox update`: the newest signed image, the same registration. Windows jobs run on meanwhile.                                                                                                                                                                                                                                                                                |
| With a new release, once Windows jobs have no job           | `g1t-runner sandbox down --only windows --drain`, the new `g1t-runner` put in place, then `g1t-runner sandbox up --only windows`. Their runner is `g1t-runner` itself, so they stop while it is replaced, a few seconds; Linux jobs run on meanwhile.                                                                                                                                      |

The other two choices run `g1t-runner` from the same data folder, with
each one's registration beside it.

On Windows the sandbox is the WSL distribution `g1t-sandbox`, of which a
computer has one. If this copy of g1t has no record of making the one
there (you made it with `g1t-runner sandbox up`, or g1t was uninstalled
with its data deleted and installed again), the app leaves it alone and
says _this computer has another sandbox_: **Remove it and start again**
removes it, with its VM and registration, and makes the app's own; or keep
it and turn the app's runner off. Uninstalling g1t with **Delete the
application data** ticked removes the sandbox too.

### Getting the runner running

The sandbox is a small virtual machine, so it needs what any VM needs:
virtualization on in your computer, and on Windows the parts of Windows
that run Linux VMs. You don't need to know what those are. Before it
downloads anything, the app asks `g1t-runner sandbox status` what your
computer still lacks for each kind of job, and each kind's card says it in
plain words: what is missing, why, and one button that fixes it, or the
exact steps when only you can.

| Computer                                           | Linux jobs need                                                                                              | Windows jobs need                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Windows 11 (any edition), Windows 10 2004 or later | Virtualization on, the Virtual Machine Platform feature, and WSL 2.0 or later. **Set up** does the last two. | Windows 11 Pro, Enterprise or Education, 24H2 or later; virtualization on; the Windows Sandbox feature. **Set up** turns it on. |
| macOS 13 or later, Apple silicon or Intel          | [vfkit](https://github.com/crc-org/vfkit), from [Homebrew](https://brew.sh): `brew install vfkit`.           | Not released yet.                                                                                                               |
| Linux                                              | Sysbox 0.7 or later in Docker; or virtualization on, KVM, and QEMU.                                          | None: Linux jobs are this computer's own.                                                                                       |

Each kind of job is set up on its own: Windows jobs that can't run on
Windows Home never stop Linux jobs, and Linux jobs waiting on WSL never
stop Windows jobs. What is missing is looked at again within half a minute, so
a card changes by itself once you have fixed it; **Check now** looks at
once.

**On Windows, Set up does what Windows can do itself, in one go.** It turns
on Virtual Machine Platform and Windows Sandbox, for the kinds of job you
have on, and installs or updates WSL. Windows asks you to allow it, once
(on a standard account, an administrator types their password). The cards
say _Setting up_ meanwhile, a few minutes. When what it turned on takes a
restart, they say _Restart needed_, with **Restart now** and **Later**.
**Restart now** asks first, in a Windows dialog of its own (_Restart
Windows now to finish setting up the runner?_, with No chosen until you
choose Yes), so save your work before you answer; a page can't restart
your computer without you. Either way, g1t opens once by itself the next
time you sign in to Windows, whether or not it opens at sign-in anyway,
and carries on: Linux jobs download their image and start. Until Windows
has restarted, the cards keep saying _Restart needed_.

If a step fails after a feature was turned on, the cards still ask for the
restart, and offer **Set up** again after it for what is left. Set up is
the same as running these in an admin terminal, and its log goes into the
runner's (**View log**):

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
Enable-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM -All -NoRestart
wsl --install --no-distribution --web-download   # or wsl --update --web-download, for an older WSL
```

It turns on only the features that are off, for the kinds of job that are
on. WSL is downloaded directly first (`--web-download`), which needs no
Microsoft Store; if that fails, the same command runs again without it,
through the Store.

Set up is for Windows alone. On Linux and macOS nothing the sandbox needs
can be installed without your password in a terminal, so the card gives
the command, with **Copy command**, and changes by itself once it has
run. The sandbox has been checked end to end on Windows; on macOS and on
Linux without Sysbox, the checks and commands below are what the app does,
but the VMs themselves [have not yet been run there](/guides/self-hosted-runners/#what-it-cannot-stop).

Whatever is missing, nothing falls back to running jobs in Docker or
directly on your computer: those are only ever [your choice](#how-jobs-run).

#### On Windows

| The card says                                                                                       | What is missing                                                                                                                                                                   | What to do                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| _Needs setting up_: _WSL isn't installed_, _Virtual Machine Platform is off_, _WSL needs an update_ | WSL 2, which the Linux VM runs on: the Virtual Machine Platform feature, and WSL 2.0 or later from the Microsoft Store (not the one built into older Windows).                    | **Set up**, and restart if it asks.                                                                                                |
| _Needs setting up_: _Windows Sandbox is off_                                                        | The Windows Sandbox feature, which each Windows job runs in.                                                                                                                      | **Set up**, then restart.                                                                                                          |
| _Not available_: _Not in Windows Home_                                                              | Windows Sandbox, which Windows Home doesn't have. Linux jobs run all the same.                                                                                                    | Nothing, for Linux jobs. For Windows jobs, Windows 11 Pro, Enterprise or Education: **Open Activation** is where Windows upgrades. |
| _Restart needed_: _Restart to finish setting up_                                                    | Set up turned on a Windows feature, which takes effect after a restart.                                                                                                           | **Restart now**, or **Later** and restart when it suits you. g1t opens again after and carries on.                                 |
| _Virtualization is off_                                                                             | Intel VT-x or AMD-V, turned off in your computer's firmware, where Windows can't turn it on. Said on Windows jobs too, when Windows Sandbox is on but could not start.            | [Turn on virtualization](#turning-on-virtualization) (**How to turn it on** opens these steps), then **Check now**.                |
| _This VM can't run the sandbox_                                                                     | g1t is in a virtual machine whose host doesn't pass virtualization through to it. Said once the sandbox's VM has failed to start for that reason, since it can't be known before. | [Turn on nested virtualization](#in-a-virtual-machine) on the host (**How to turn it on**).                                        |
| _Windows needs an update_, on Linux jobs                                                            | Windows older than Windows 10 version 2004, the first with WSL 2.                                                                                                                 | **Open Windows Update**, update, and restart.                                                                                      |
| _Windows needs an update_, on Windows jobs                                                          | Windows Sandbox's command line, `wsb`, which came with Windows 11 24H2.                                                                                                           | **Open Windows Update**, update to 24H2 or later, and restart.                                                                     |
| _Set up didn't finish_                                                                              | You said No to Windows' prompt, or a step failed, with its reason.                                                                                                                | **Set up** again; **View log** says what happened.                                                                                 |
| _WSL uses mirrored networking_                                                                      | A setting, not a part: `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig` lets Linux reach your computer's own `localhost`, so the sandbox won't start with it.              | Remove it, run `wsl --shutdown`, then **Retry**.                                                                                   |

#### On Linux

With Sysbox 0.7 or later in Docker, none of these is needed: the runner's
image runs under Sysbox, without a VM. Without it, Linux jobs run in a VM
under QEMU with KVM, and the card says what is missing for that, with the
command that fixes it on **Copy command**.

| The card says                   | What is missing                                                                              | What to do                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _No access to KVM_              | `/dev/kvm` is there, and your account may not use it.                                        | `sudo usermod -aG kvm $USER`, then log out and back in.                                                                                                                                                    |
| _KVM isn't loaded_              | `/dev/kvm`, though your processor can run VMs.                                               | `sudo modprobe kvm_intel` (Intel) or `sudo modprobe kvm_amd` (AMD). If it says the firmware disabled it, [turn on virtualization](#turning-on-virtualization).                                             |
| _QEMU isn't installed_          | QEMU, which runs the VM.                                                                     | `sudo apt install qemu-system-x86` (`qemu-system-arm` on Arm) on Debian and Ubuntu, `sudo dnf install qemu-kvm` on Fedora, `sudo pacman -S qemu-base` on Arch, `sudo zypper install qemu-kvm` on openSUSE. |
| _Virtualization is off_         | Your processor says it can't run VMs: virtualization is off in the firmware, or it has none. | [Turn on virtualization](#turning-on-virtualization), or install Sysbox.                                                                                                                                   |
| _This VM can't run the sandbox_ | Linux in a VM whose host doesn't pass virtualization through.                                | [Turn on nested virtualization](#in-a-virtual-machine), or install Sysbox.                                                                                                                                 |

#### On macOS

| The card says                                  | What is missing                                                 | What to do                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| _vfkit isn't installed_, with **Get Homebrew** | vfkit, and Homebrew, which installs it.                         | **Get Homebrew** and install it, then `brew install vfkit` in Terminal (**Copy command**). |
| _vfkit isn't installed_                        | vfkit, which runs the VM with Apple's Virtualization framework. | `brew install vfkit` in Terminal (**Copy command**).                                       |
| _macOS needs an update_                        | macOS 13 or later.                                              | **Open Software Update**, update, and open g1t again.                                      |

The VM's image is the one for your Mac's processor, Apple silicon or Intel;
while a release has none for it yet, the card says _Waiting for image_.
Every Mac g1t runs on has virtualization on.

#### Turning on virtualization

Virtualization (Intel VT-x, _Intel Virtualization Technology_; AMD-V,
_SVM Mode_) is a setting in your computer's firmware, the BIOS or UEFI
settings, which only you can change. Most computers have it on; some
come with it off.

1. Open the firmware settings. On Windows: **Settings**, **System**,
   **Recovery**, **Advanced startup**, **Restart now**, then
   **Troubleshoot**, **Advanced options**, **UEFI Firmware Settings**,
   **Restart**. Or press its key as the computer starts: usually F2 (Dell,
   Acer, ASUS, Lenovo IdeaPad), F10 (HP), F1 (Lenovo ThinkPad), or Del
   (desktops: MSI, Gigabyte, ASRock).
2. Find **Intel Virtualization Technology** (sometimes **VT-x** or **Intel
   VT**) or **SVM Mode** (AMD), usually under **Advanced**, **CPU
   Configuration** or **Security**, and turn it on.
3. Save and exit, usually F10. Windows starts again, and the card changes
   by itself.

#### In a virtual machine

g1t inside a VM runs the sandbox as a VM inside that VM, which works only
when the host passes virtualization through: _nested virtualization_. Turn
it on for the VM on its host, with the VM off, then start it again:

| Host                       | How                                                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hyper-V                    | `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true`, in an admin PowerShell on the host.                                                                                                            |
| VMware Workstation, Fusion | The VM's settings, **Processors**, **Virtualize Intel VT-x/EPT or AMD-V/RVI**.                                                                                                                                         |
| VirtualBox                 | The VM's settings, **System**, **Processor**, **Enable Nested VT-x/AMD-V**, or `VBoxManage modifyvm <name> --nested-hw-virt on`.                                                                                       |
| Proxmox, KVM               | The VM's processor type `host`.                                                                                                                                                                                        |
| A cloud VM                 | A machine type with nested virtualization: on Azure, Dv3 and Ev3 or later; on Google Cloud, nested virtualization turned on for the instance. Elsewhere, ask your provider: some offer it only on bare-metal machines. |

### Registering

The first time, and whenever you change the workspace or how jobs run,
the app registers your computer with the workspace. It needs you signed
in to g1t in the app as an owner of the workspace, since only owners add
runners: the page you are on makes a registration token, which lasts an
hour, and hands it to the app, which gives it to the runner once. The
token is never shown, and is not kept. From then on the runner starts
from its registration, signed in or not.

The workspace is the one you were in when it first registered; choose
another under **Workspace** in [the runner's settings](#runner-settings). Changing it, or how jobs
run, waits for a job that is running to end, then removes the old
registration and makes a new one. The sandbox is registered with one
workspace, so moving it to another removes it and makes it again, image
and all; its old runners stay listed on g1t, offline, until you remove
them there.

### Keeping it up to date

The app keeps the runner up to date. Soon after it starts, then every
hour, it looks for a newer `g1t-runner` in
`g1t.sh/downloads/runner/latest.json`, while the runner carries on:

1. **It checks the release is g1t's.** The manifest's Ed25519 signature,
   `latest.json.sig`, must check out against g1t's release key, which is
   built into the app. A manifest without one, or whose signature
   doesn't check out, is refused, and nothing in it is used: the app says
   _Update refused: not signed by g1t_ and keeps the runner it has.
2. **It downloads the new `g1t-runner`** and checks it against the
   SHA-256 the signed manifest names, throwing away one that differs.
3. **It puts it in, one kind of job at a time, as each is idle.** A job
   is never cut short for an update. Sandboxed, Linux jobs take the
   release's image (`g1t-runner sandbox update`, which checks its
   signature and SHA-256 itself) as soon as they have no job, and
   Windows jobs, whose runner is `g1t-runner` itself, stop after their
   job, take the new program and start again, while the other kind runs
   on. In Docker or directly on this computer, the runner stops between
   jobs and starts on the new one.

Meanwhile each card says what is waiting: _0.3.2 ready, installs after
this job_. **Check for runner updates**, in [the runner menu](#the-runner-menu),
looks at once, and installs what it finds the same way. An
update that fails leaves the runner as it was, and the next hour's look
tries again. Turning off **Download updates by themselves** stops the
hourly look; **Check for runner updates** still looks, and installs.

### Seeing it

| Where                                                                         | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The title bar                                                                 | Its dot, right beside **Settings**, in the colour of what it is doing; hover it for the words (_Runner running_, _Running a job_, _Running 2 jobs_, _Runner starting_, _Runner setting up_, _Runner stopped_, _Runner needs you_), which a wide window shows beside it. It opens the runner menu.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The tray                                                                      | A row with what the runner is doing, _Runner: Waiting for jobs_, which opens the runner menu; **Stop running jobs** or **Start running jobs** under it. The icon's hover text says it too.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [The runner menu](#the-runner-menu)                                           | At the top, what the whole runner is doing, as the dot says it, with how jobs run, its workspace and version, and its own **Stop** or **Start**. When it needs you, only what is about the whole runner: signed out, no workspace, turned off, stopped, the sandbox down, with the fix's buttons. Sandboxed, a line for each kind of job: its state (_Running a job_, _Waiting for jobs_, _Starting_, _Downloading image_ with how far, _Updating_, _Waiting for image_, _Needs setting up_, _Setting up_, _Restart needed_, _Stopped_, _Not available_, _Problem_), the job it is running with a link to it, a newer runner waiting for it (_0.3.2 ready, installs after this job_), and when it isn't running why and the fix, with the fix's buttons and its own **Stop** or **Start**. Then when the app last looked for a newer runner, with **Check for runner updates**; the last lines of its log, following along, with **Open the whole log**; and **Runner settings…**. |
| [The runner's settings](#runner-settings)                                     | The same, with a card for each kind of job side by side, which adds its runner's name on g1t, version, updates and isolation; then **Run jobs on this computer while g1t is open**, how jobs run, the workspace, and your computer's name, the runner's version and when the app last looked for a newer one, with **View on g1t**. In Docker or directly on this computer, one line says what it is doing, or why it isn't running and the fix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| The workspace's [Runners page](/guides/self-hosted-runners/#the-runners-page) | **Desktops**: every computer with the app in the workspace, with what each is doing, or why it isn't running and the fix, in the same words; a sandboxed one's kinds of job as cards of their own, as in the settings, with a link to the run each is running, its version, when the app last looked for updates and a newer one waiting. Inside the app, this computer comes first, live, with its buttons, each kind's **Stop** or **Start** and **Check for runner updates** among them. A computer whose g1t is closed says _g1t is closed on_ its name.                                                                                                                                                                                                                                                                                                                                                                                                                       |

### When it isn't running

Each state says why, and how to fix it, in the same words in the tray,
the settings and the Runners page.

| It says                                                                                                                                                      | Why                                                                                                                                                                 | What to do                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| _Waiting for jobs_                                                                                                                                           | It is registered and listening.                                                                                                                                     | Nothing.                                                                                                                                                                                                                                                           |
| _Running_ a job                                                                                                                                              | It is running that job.                                                                                                                                             | Nothing; the Runners page links to its run.                                                                                                                                                                                                                        |
| _Starting_, _Registering with_ a workspace, _Updating_                                                                                                       | It is on its way.                                                                                                                                                   | Wait a few seconds.                                                                                                                                                                                                                                                |
| _Not running: turned off_                                                                                                                                    | **Run jobs on this computer while g1t is open** is off.                                                                                                             | **Turn on**.                                                                                                                                                                                                                                                       |
| _Not running: stopped_                                                                                                                                       | You pressed **Stop running jobs** in the tray.                                                                                                                      | **Start**, or open g1t again.                                                                                                                                                                                                                                      |
| _Not running: every kind of job is stopped_                                                                                                                  | You stopped Linux jobs and Windows jobs, each on its card.                                                                                                          | **Start** on one.                                                                                                                                                                                                                                                  |
| _Linux jobs: Stopped_, _Windows jobs: Stopped_, _You stopped_ them                                                                                           | You pressed **Stop** on that card. The other kind runs on.                                                                                                          | **Start** on the card.                                                                                                                                                                                                                                             |
| _Linux jobs: Waiting for image_: _Waiting for the sandbox's image_                                                                                           | The newest `g1t-runner` is published without the sandbox's images yet (or without this kind of computer's), so there is nothing to download.                        | Nothing: g1t looks again every five minutes and starts Linux jobs once they're out. **Check now** looks at once.                                                                                                                                                   |
| _Not running: signed out_                                                                                                                                    | It isn't registered yet, and registering needs you signed in.                                                                                                       | **Sign in**, as an owner of the workspace.                                                                                                                                                                                                                         |
| _Not running: no workspace to run jobs for_                                                                                                                  | You don't own a workspace, and only owners add runners.                                                                                                             | Ask an owner, or **Create a workspace**.                                                                                                                                                                                                                           |
| _Couldn't register with_ a workspace: _only its owners can_                                                                                                  | You aren't an owner of it.                                                                                                                                          | Ask an owner to make you one, or **Choose workspace**.                                                                                                                                                                                                             |
| _Couldn't register with_ a workspace, with g1t's reason                                                                                                      | g1t refused the registration, such as for too many tokens in an hour.                                                                                               | **Retry**; it also tries again by itself.                                                                                                                                                                                                                          |
| _Not running: Docker isn't running_                                                                                                                          | Running jobs in Docker needs Docker, and it isn't running or isn't installed.                                                                                       | **Open Docker** (Docker Desktop), or **Get Docker**. It starts by itself once Docker answers.                                                                                                                                                                      |
| _Needs setting up_, _Setting up_, _Restart needed_ on a card, and _Not running:_ what it needs (_WSL isn't installed_, _virtualization is off_, …)           | Your computer lacks something the sandbox needs: WSL, a Windows feature, virtualization, KVM, QEMU, vfkit.                                                          | **Set up** on Windows, or the card's steps. [Getting the runner running](#getting-the-runner-running) has a row for each, on each system.                                                                                                                          |
| _Not running: WSL uses mirrored networking_                                                                                                                  | `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig` lets Linux reach your computer's own `localhost`.                                                           | Remove it, run `wsl --shutdown`, then **Retry**.                                                                                                                                                                                                                   |
| _Not running: WSL isn't installed_, _virtualization is off_, _vfkit isn't installed_, _no Sysbox or KVM_, with **Copy command** or **Open Windows features** | The same, said by an older `g1t-runner`, from before it named what a computer lacks.                                                                                | Its fix; the app downloads a newer `g1t-runner` by itself, which brings **Set up**.                                                                                                                                                                                |
| _Not running: the sandbox's image didn't download_                                                                                                           | The image couldn't be fetched from g1t, with the reason.                                                                                                            | It tries again by itself, waiting longer each time; check that your computer can reach g1t. **Retry** tries now.                                                                                                                                                   |
| _Not running: the sandbox's image didn't check out_                                                                                                          | The image that downloaded isn't the one the release signed (its signature or SHA-256), so it wasn't used.                                                           | It downloads it again by itself. If it keeps happening, something between your computer and g1t, such as a proxy or antivirus, is changing downloads: **Report** it.                                                                                               |
| _Not running: the sandbox can't run here_                                                                                                                    | Something else the sandbox needs, in its own words.                                                                                                                 | What it says.                                                                                                                                                                                                                                                      |
| _Not running: the sandbox failed_                                                                                                                            | The sandbox stopped, or didn't start, with its reason.                                                                                                              | It starts again by itself, waiting longer each time. **Retry**, or **View log**.                                                                                                                                                                                   |
| _Not running: this computer has another sandbox_                                                                                                             | A sandbox this copy of g1t has no record of making: one you made with `g1t-runner sandbox up`, or one left from before g1t was installed again. A computer has one. | **Remove it and start again**, which asks first; its old runners stay listed on g1t, offline, until you remove them there. Or keep it, and turn the app's runner off.                                                                                              |
| _Not running: this g1t-runner has no sandbox_                                                                                                                | The app's `g1t-runner` is from before the sandbox.                                                                                                                  | It downloads a newer one by itself; **Retry** looks now.                                                                                                                                                                                                           |
| _Windows jobs: Not available_: _Not in Windows Home_                                                                                                         | Windows Home has no Windows Sandbox. Linux jobs still run.                                                                                                          | Nothing, for Linux jobs; Windows jobs need Pro, Enterprise or Education.                                                                                                                                                                                           |
| _Windows jobs: Problem_: _Its runner didn't start_ or _Its runner stopped_                                                                                   | The runner for Windows jobs didn't start, with why, or stopped by itself, while Linux jobs run.                                                                     | It is started again by itself in a few minutes; **Retry** now, or **View log**.                                                                                                                                                                                    |
| _macOS jobs: Not available_: _Not released yet_                                                                                                              | Sandboxed macOS jobs aren't released.                                                                                                                               | Nothing: they come with a `g1t-runner` update, which the app downloads by itself.                                                                                                                                                                                  |
| _Offline:_ the server _unreachable_                                                                                                                          | Your computer can't reach g1t.                                                                                                                                      | Check the connection; it carries on by itself. **Retry** tries now.                                                                                                                                                                                                |
| _0.3.2 ready, installs after this job_, on a card                                                                                                            | A newer `g1t-runner` is downloaded and checked, and that kind of job is running a job.                                                                              | Nothing: it goes in as soon as the job ends, and the other kind runs on meanwhile.                                                                                                                                                                                 |
| _Update failed_                                                                                                                                              | A new version couldn't be downloaded, its SHA-256 wasn't the release's, or the sandbox's image couldn't be updated.                                                 | It keeps running the version it has, and tries again within the hour. **Check again** now; **Report** it if it keeps failing.                                                                                                                                      |
| _Update refused: not signed by g1t_                                                                                                                          | The newest release's manifest has no signature, or one that isn't g1t's release key's, so nothing in it was used.                                                   | Nothing to fix on your side: it keeps running the version it has, and looks again within the hour (**Check again** looks now). If it keeps happening, something between your computer and g1t, such as a proxy or antivirus, is changing downloads: **Report** it. |
| _Not running: the runner's release isn't signed by g1t_                                                                                                      | As above, before any `g1t-runner` was installed, so there is none to run.                                                                                           | It tries again by itself in a few minutes; **Retry** now, or **Report** it if it keeps happening.                                                                                                                                                                  |
| _Runner stopped (exit code_ N*)*                                                                                                                             | The runner ended by itself, with the reason from its log.                                                                                                           | It starts again by itself, waiting longer each time. **Restart** now, or **View log**.                                                                                                                                                                             |
| _g1t is closed on_ a computer                                                                                                                                | Seen on the Runners page: g1t hasn't been open on that computer for ten minutes.                                                                                    | Open g1t there.                                                                                                                                                                                                                                                    |

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
as it starts and every hour, and downloads one in the background.

- **As it starts**, a newer version is installed straight away, and g1t
  opens again on it a moment later, before you have begun working in it.
  If something in the app misbehaves, quitting and opening g1t again is
  enough to be on the newest version. The one exception is a runner in
  Docker or directly on this computer in the middle of a job, which is
  never cut short: then the update waits like any other. A sandboxed
  runner's job runs on through the update.
- **Later on**, it never installs under you: a notification and the
  tray's **Restart to update** say it is ready, and the restart, or
  quitting, installs it.

To see where your copy stands, choose **Check for updates…** in the Help
menu or the tray, or **Check for updates** in [the settings](#settings).
The menu and the tray open the settings at their Updates section,
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

### Restarting

**Restart now**, **Restart to update** and **Quit g1t** go at once: the
settings say _Restarting…_, the windows close, and until g1t has gone the
tray's icon says _Updating g1t…_ (or _Restarting g1t…_, _Quitting g1t…_).
On Windows the installer starts once g1t has let go of its runner, and it
opens the new version itself, once.

What happens to [the runner](#the-runner):

- **Sandboxed**, a restart leaves it running, and a job it is running
  runs on. The new version takes it up again as it opens. Quitting stops
  it, as it runs jobs only while g1t is open.
- **In Docker or directly on this computer**, the runner is g1t's own, so
  it stops, within about 10 seconds. If it is running a job, g1t asks
  first: _A job is running on this computer. Restart when it finishes, or
  stop it now?_ Restarting when it finishes waits for the job, however
  long it takes, and then goes without asking again; the tray says
  _Updating g1t when the job finishes…_ meanwhile. Cancel keeps g1t open.
  Quitting asks the same of the sandbox's jobs.

What happened is in the runner's log (**Open the whole log** in [the
runner menu](#the-runner-menu)), and in the app's own, `g1t.log`
(`%LOCALAPPDATA%\sh.g1t.desktop\logs` on Windows,
`~/Library/Logs/sh.g1t.desktop` on macOS,
`~/.local/share/sh.g1t.desktop/logs` on Linux): whether the runner was
left running, waited for a job, or stopped.

## Your own g1t

If you [run g1t yourself](/guides/self-hosting/), point the app at it:
**Use another g1t…** in the tray or the File menu, or **Change…** in [the
settings](#settings), then your server's address, such as
`https://g1t.example.com`. The app keeps it and opens there from then on;
**Use g1t.sh** on the same page goes back. Only that server's pages can
talk to the app, whichever it is, and updates still come from g1t.sh.

## What's not there yet

- **Windows jobs on a Mac.** Sandboxed macOS jobs are designed, not
  released, so a Mac's sandbox runs Linux jobs only.
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

| What                       | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The runner's release key   | The app trusts a `g1t-runner` release only when its manifest is signed with g1t's runner release key, whose public half (the repository variable `RUNNER_RELEASE_PUBLIC_KEY`) is built into the app, in `src-tauri/src/runner/native.rs`. To build the app for a g1t of your own, whose runner releases you sign with your own key, set `G1T_RUNNER_RELEASE_KEY` to its public key, base64, when you build it.                                                                       |
| The updater's signing key  | `node scripts/desktop-release.mjs keygen`, once. The private key is the repository secret `DESKTOP_SIGNING_KEY`; the public key is `plugins.updater.pubkey` in `tauri.conf.json`. Losing the private key means every installed app stops updating: keep it.                                                                                                                                                                                                                          |
| Linux builds               | g1t's own Linux machines, in every release.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Windows builds             | Either a Windows machine registered as a [self-hosted runner](/guides/self-hosted-runners/) with the labels `self-hosted` and `windows` (Rust, Node and the Visual Studio build tools on it) and the repository variable `DESKTOP_WINDOWS_RUNNER` set to `true`; or, with no Windows machine, `DESKTOP_WINDOWS_FROM_LINUX` set to `true`, which cross-builds on Linux with `cargo-xwin` and NSIS, fetching the MSVC runtime from `aka.ms` and `download.visualstudio.microsoft.com`. |
| macOS builds               | A Mac, registered as a self-hosted runner with the labels `self-hosted` and `macos`, and the repository variable `DESKTOP_MACOS_RUNNER` set to `true`.                                                                                                                                                                                                                                                                                                                               |
| A platform with no machine | Its job is skipped and the release goes out with the rest; the download page says which platforms a release lacks, and the next release fills them in.                                                                                                                                                                                                                                                                                                                               |
| Where releases are served  | `g1t.sh/downloads/desktop/<version>/<file>`, from the same bucket as the runner's and the CLI's releases.                                                                                                                                                                                                                                                                                                                                                                            |

A self-hosted g1t does not serve the app's releases: the app always
updates from g1t.sh, and `g1t.sh/download` is where to send people.
