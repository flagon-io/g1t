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
menu, **Get the desktop app**. The page opens on the system you visit it
from, with every other platform a tab away, and lists the
[runner](/guides/self-hosted-runners/) and the g1t CLI for each system
under **Command line**.

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
| **The runner** | At the right, beside **Settings**: what [the runner](#the-runner) is doing in a few words, with a dot in its colour (*Runner running*, *Running a job*, *Running 2 jobs*, *Runner starting*, *Runner stopped*, *Runner needs you*), live. It opens [the Runner window](#the-runner-window). In a narrow window only its dot shows. |
| **Settings** | Opens [the settings](#settings). |
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

The app's own settings are in a window of their own: the **Settings**
button at the right of the title bar, **Settings** in the File menu (the
g1t menu on macOS) or Ctrl+, (⌘, on macOS), **Settings…** in the tray, or
**Desktop app settings** in your account menu on g1t. Each change takes effect at
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
| **Download updates by themselves** | On | Off, the app never checks on its own; **Check for updates** still does. The runner's updates follow it too: off, only **Check for runner updates** looks for a newer runner. |

The settings window also shows the app's version and whether it is up to
date, with **Check for updates** (see [Updates](#updates)), and the server it opens, with **Change…** to [use another
g1t](#your-own-g1t). The runner is a line there, what it is doing with
**Open runner**: its own settings are in [the Runner window](#the-runner-window).

## The runner

The app runs a [self-hosted runner](/guides/self-hosted-runners/) for
you while it is open: your workspace's jobs that ask for `self-hosted`
run on your computer, at no cost, and nothing has to be downloaded,
registered or started by hand. It starts a few seconds after the window
opens, and stops when g1t quits. Time on it is free, as on any of your
runners.

To stop it, press **Stop running jobs** in the tray; it starts again with
**Start running jobs**, or the next time g1t opens. To keep it off, turn
off **Run jobs on this computer while g1t is open** in
[the Runner window](#the-runner-window).

Sandboxed, each kind of job is a card of its own in the Runner window, **Linux jobs** and **Windows jobs**, each with its own **Stop**
and **Start**. Stopping Windows jobs leaves Linux jobs running, and the
other way round; a kind you stop stays stopped, across restarts, until you
start it again. Both are on until you stop one.

A job still runs only on a runner with every label it names. The app's
runner has `self-hosted`, its OS and architecture (`linux` for a runner
whose jobs run in containers, whatever the computer is), and `desktop`.
It is named after your computer, and a new registration from the same
computer takes the place of the old one. Sandboxed, the computer has a
runner for each kind of job it can run, named after it with `-linux` or
`-windows`: `build-box-linux` has `linux`, and `build-box-windows` has
`windows`, on a Windows computer with Windows Sandbox.

### The Runner window

The runner has a window of its own, apart from the settings, as Docker
Desktop has for its engine: open it from the chip beside **Settings** in
the title bar, from the runner's row in the tray, or with **Open runner**
in the settings. It shows what the runner is doing as it happens, and keeps
its settings:

| Setting | Default | What it does |
| --- | --- | --- |
| **Run jobs on this computer while g1t is open** | On | Starts the runner a few seconds after the window. Off, nothing runs. |
| **How jobs run** | Sandboxed | Sandboxed, in Docker, or directly on this computer. See [how jobs run](#how-jobs-run). |
| **Linux jobs**, **Windows jobs** (sandboxed) | Both on | Each kind of job's card has its own **Stop** and **Start**, which leave the other kind as it is. |
| **Workspace** | The one you were in when it first registered | The workspace whose jobs the runner runs. Lists the workspaces you own. |

[Seeing it](#seeing-it) says what else it shows.

### How jobs run

**How jobs run** in the Runner window decides what a job on your computer can
reach. The app never changes it by itself: when the one you chose cannot
start, it says why and runs nothing.

| Choice | How | [Isolation](/guides/self-hosted-runners/#isolation) | What a job can reach |
| --- | --- | --- | --- |
| **Sandboxed** (the default) | [The sandbox](/guides/self-hosted-runners/#sandbox-on-your-computer), which the app sets up and starts itself. Linux jobs run in a small Linux VM of the runner's own, each in a container inside it: a WSL 2 distribution on Windows, a VM under Apple's Virtualization framework on macOS, and on Linux the runner's image under [Sysbox](https://github.com/nestybox/sysbox), or a VM under QEMU with KVM. On Windows 11 Pro, Enterprise and Education, Windows jobs run too, each in a Windows Sandbox of its own. | `nested-container`; `vm` for Windows jobs | Its own container, or its own Windows Sandbox. Not your computer. |
| **In Docker** | `g1t-runner` on your computer, driving your Docker. Each job is a container of its own. | `container` | Its own container; but the runner controls your Docker, which can reach your files (Docker Desktop shares your home folder with its VM), so this is not a sandbox. |
| **Directly on this computer** | `g1t-runner` on your computer, each job a process in a folder of its own. For jobs that need the system itself, such as building a Windows installer. | `host` | Everything your account can: your files, your keys, what an earlier job left. Not a sandbox. Never given a public repository's work. |

What the sandbox needs on each computer:

| Computer | Linux jobs | Windows jobs |
| --- | --- | --- |
| Windows 11, any edition | WSL, installed once: `wsl --install --no-distribution` in an admin terminal, then a restart. The app's **Copy command** button copies it. | Windows Sandbox, on Pro, Enterprise and Education, version 24H2 or later, turned on in Windows features. Home has none, and Linux jobs still run. |
| macOS 13 or later | [vfkit](https://github.com/crc-org/vfkit): `brew install vfkit` | Not released yet |
| Linux | Sysbox 0.7 or later in Docker, or QEMU with KVM | None: Linux jobs are native |

The sandbox also needs virtualization turned on in your computer's
firmware (Intel VT-x or AMD-V), which most computers have on.

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

| When | The app runs |
| --- | --- |
| A few seconds after g1t opens | `g1t-runner sandbox up --json --state-dir <data folder>/sandbox --url <server> --name <computer> --labels desktop`, with the registration token the first time only, in its environment as `G1T_RUNNER_TOKEN`, never on its command line, where anyone on the computer could read it. The first `up` downloads and checks the sandbox's image and makes the VM, which takes a few minutes. |
| Every few seconds while it runs | `g1t-runner sandbox status --json`, for the tray, the settings and the Runners page. |
| When g1t quits, or you press **Stop running jobs** | `g1t-runner sandbox down`: a job that is running is cut short. |
| When you press **Stop** on one kind of job's card | `g1t-runner sandbox down --only windows` (or `linux`): that kind stops, a job of its own cut short, and stays off; the other runs on. Every `up` names the kinds that are on, `--only linux,windows`, so one you stopped never starts by itself. |
| When you press **Start** on one kind of job's card | `g1t-runner sandbox up --only windows` (or `linux`), leaving the other as it is. A kind never registered is registered first, with a token as above. |
| While one kind of job runs and the other should and doesn't | `g1t-runner sandbox up --only` it again, by itself: every five minutes while the newest release has no sandbox images, else after a wait that grows each time, up to ten minutes. **Retry** or **Check now** tries at once. |
| When you choose another way of running jobs | `g1t-runner sandbox down --drain`, once the job that is running ends. The sandbox keeps its registration, so choosing Sandboxed again needs no new one. |
| With a new release, once Linux jobs have no job | `g1t-runner sandbox update`: the newest signed image, the same registration. Windows jobs run on meanwhile. |
| With a new release, once Windows jobs have no job | `g1t-runner sandbox down --only windows --drain`, the new `g1t-runner` put in place, then `g1t-runner sandbox up --only windows`. Their runner is `g1t-runner` itself, so they stop while it is replaced, a few seconds; Linux jobs run on meanwhile. |

The other two choices run `g1t-runner` from the same data folder, with
each one's registration beside it.

On Windows the sandbox is the WSL distribution `g1t-sandbox`, of which a
computer has one. If you made one yourself with `g1t-runner sandbox up`,
the app leaves it alone and says *this computer has another sandbox*:
remove it with `g1t-runner sandbox down --delete` for the app to make its
own, or keep it and turn the app's runner off.

### Registering

The first time, and whenever you change the workspace or how jobs run,
the app registers your computer with the workspace. It needs you signed
in to g1t in the app as an owner of the workspace, since only owners add
runners: the page you are on makes a registration token, which lasts an
hour, and hands it to the app, which gives it to the runner once. The
token is never shown, and is not kept. From then on the runner starts
from its registration, signed in or not.

The workspace is the one you were in when it first registered; choose
another under **Workspace** in the Runner window. Changing it, or how jobs
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
   *Update refused: not signed by g1t* and keeps the runner it has.
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

Meanwhile each card says what is waiting: *0.3.2 ready, installs after
this job*. **Check for runner updates**, beside your computer's name in
the Runner window, looks at once, and installs what it finds the same way. An
update that fails leaves the runner as it was, and the next hour's look
tries again. Turning off **Download updates by themselves** stops the
hourly look; **Check for runner updates** still looks, and installs.

### Seeing it

| Where | What it shows |
| --- | --- |
| The title bar | Its chip, beside **Settings**: *Runner running*, *Running a job*, with a dot in its colour, which opens the Runner window. |
| The tray | A row with what the runner is doing, *Runner: Waiting for jobs*, which opens the Runner window; **Stop running jobs** or **Start running jobs** under it. The icon's hover text says it too. |
| [The Runner window](#the-runner-window) | At the top, what the whole runner is doing, as the chip says it, with what it is running, its version and workspace, and its own **Stop** or **Start**. Below, sandboxed, a card for each kind of job this computer can have, side by side: its state (*Running a job*, *Waiting for jobs*, *Starting*, *Downloading image* with how far, *Updating*, *Waiting for image*, *Stopped*, *Not available*, *Problem*), what it is, the job it is running with a link to it, and when it isn't running why and the fix, with the fix's buttons and its own **Stop** or **Start**; below, its runner's name on g1t, version, updates (when the app last looked, *Checked 12 min ago*, and a newer one waiting for it, *0.3.2 ready, installs after this job*) and isolation. Above the cards, only what is about the whole runner: signed out, no workspace, turned off, stopped, the sandbox down. Then its setup: **Run jobs on this computer while g1t is open**, how jobs run, the workspace, and your computer's name, the runner's version and when the app last looked for a newer one, with **Check for runner updates** and **View on g1t**. Last, its log, following along as it is written, with **Open the whole log**. In Docker or directly on this computer, one line says what it is doing, or why it isn't running and the fix. |
| The workspace's [Runners page](/guides/self-hosted-runners/#the-runners-page) | **Desktops**: every computer with the app in the workspace, with what each is doing, or why it isn't running and the fix, in the same words; a sandboxed one's kinds of job as cards of their own, as in the settings, with a link to the run each is running, its version, when the app last looked for updates and a newer one waiting. Inside the app, this computer comes first, live, with its buttons, each kind's **Stop** or **Start** and **Check for runner updates** among them. A computer whose g1t is closed says *g1t is closed on* its name. |

### When it isn't running

Each state says why, and how to fix it, in the same words in the tray,
the settings and the Runners page.

| It says | Why | What to do |
| --- | --- | --- |
| *Waiting for jobs* | It is registered and listening. | Nothing. |
| *Running* a job | It is running that job. | Nothing; the Runners page links to its run. |
| *Starting*, *Registering with* a workspace, *Updating* | It is on its way. | Wait a few seconds. |
| *Not running: turned off* | **Run jobs on this computer while g1t is open** is off. | **Turn on**. |
| *Not running: stopped* | You pressed **Stop running jobs** in the tray. | **Start**, or open g1t again. |
| *Not running: every kind of job is stopped* | You stopped Linux jobs and Windows jobs, each on its card. | **Start** on one. |
| *Linux jobs: Stopped*, *Windows jobs: Stopped*, *You stopped* them | You pressed **Stop** on that card. The other kind runs on. | **Start** on the card. |
| *Linux jobs: Waiting for image*: *Waiting for the sandbox's image* | The newest `g1t-runner` is published without the sandbox's images yet (or without this kind of computer's), so there is nothing to download. | Nothing: g1t looks again every five minutes and starts Linux jobs once they're out. **Check now** looks at once. |
| *Not running: signed out* | It isn't registered yet, and registering needs you signed in. | **Sign in**, as an owner of the workspace. |
| *Not running: no workspace to run jobs for* | You don't own a workspace, and only owners add runners. | Ask an owner, or **Create a workspace**. |
| *Couldn't register with* a workspace: *only its owners can* | You aren't an owner of it. | Ask an owner to make you one, or **Choose workspace**. |
| *Couldn't register with* a workspace, with g1t's reason | g1t refused the registration, such as for too many tokens in an hour. | **Retry**; it also tries again by itself. |
| *Not running: Docker isn't running* | Running jobs in Docker needs Docker, and it isn't running or isn't installed. | **Open Docker** (Docker Desktop), or **Get Docker**. It starts by itself once Docker answers. |
| *Not running: WSL isn't installed* | Windows: Linux jobs run in a WSL distribution of the runner's own. | Run `wsl --install --no-distribution` in an admin terminal (**Copy command**), then restart Windows. Every edition of Windows 11 has it, Home included. |
| *Not running: WSL uses mirrored networking* | `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig` lets Linux reach your computer's own `localhost`. | Remove it, run `wsl --shutdown`, then **Retry**. |
| *Not running: virtualization is off* | The sandbox is a small VM, and virtualization is off in your computer's firmware, or Virtual Machine Platform is off in Windows features. | Turn them on (**Open Windows features** on Windows), then restart. |
| *Not running: vfkit isn't installed* | macOS: the sandbox's VM runs under vfkit. | Run `brew install vfkit` (**Copy command**). It starts by itself once vfkit is there. |
| *Not running: no Sysbox or KVM* | Linux: the sandbox needs Sysbox in Docker, or QEMU with KVM. | **Install Sysbox**, or turn on virtualization and install QEMU. |
| *Not running: the sandbox's image didn't download* | The image couldn't be fetched from g1t, with the reason. | It tries again by itself, waiting longer each time; check that your computer can reach g1t. **Retry** tries now. |
| *Not running: the sandbox's image didn't check out* | The image that downloaded isn't the one the release signed (its signature or SHA-256), so it wasn't used. | It downloads it again by itself. If it keeps happening, something between your computer and g1t, such as a proxy or antivirus, is changing downloads: **Report** it. |
| *Not running: the sandbox can't run here* | Something else the sandbox needs, in its own words. | What it says. |
| *Not running: the sandbox failed* | The sandbox stopped, or didn't start, with its reason. | It starts again by itself, waiting longer each time. **Retry**, or **View log**. |
| *Not running: this computer has another sandbox* | A sandbox you made with `g1t-runner sandbox up`; a computer has one. | Remove it with `g1t-runner sandbox down --delete`, then **Retry**; or keep it, and turn the app's runner off. |
| *Not running: this g1t-runner has no sandbox* | The app's `g1t-runner` is from before the sandbox. | It downloads a newer one by itself; **Retry** looks now. |
| *Windows jobs: Not available*: *Windows Sandbox is off*, *Windows needs an update* | Windows Sandbox is off, this Windows is Home, or it is older than 24H2. Linux jobs still run. | On Pro, Enterprise or Education, turn on Windows Sandbox (**Open Windows features**) and restart, or update Windows. |
| *Windows jobs: Problem*: *Its runner didn't start* or *Its runner stopped* | The runner for Windows jobs didn't start, with why, or stopped by itself, while Linux jobs run. | It is started again by itself in a few minutes; **Retry** now, or **View log**. |
| *macOS jobs: Not available*: *Not released yet* | Sandboxed macOS jobs aren't released. | Nothing: they come with a `g1t-runner` update, which the app downloads by itself. |
| *Offline:* the server *unreachable* | Your computer can't reach g1t. | Check the connection; it carries on by itself. **Retry** tries now. |
| *0.3.2 ready, installs after this job*, on a card | A newer `g1t-runner` is downloaded and checked, and that kind of job is running a job. | Nothing: it goes in as soon as the job ends, and the other kind runs on meanwhile. |
| *Update failed* | A new version couldn't be downloaded, its SHA-256 wasn't the release's, or the sandbox's image couldn't be updated. | It keeps running the version it has, and tries again within the hour. **Check again** now; **Report** it if it keeps failing. |
| *Update refused: not signed by g1t* | The newest release's manifest has no signature, or one that isn't g1t's release key's, so nothing in it was used. | Nothing to fix on your side: it keeps running the version it has, and looks again within the hour (**Check again** looks now). If it keeps happening, something between your computer and g1t, such as a proxy or antivirus, is changing downloads: **Report** it. |
| *Not running: the runner's release isn't signed by g1t* | As above, before any `g1t-runner` was installed, so there is none to run. | It tries again by itself in a few minutes; **Retry** now, or **Report** it if it keeps happening. |
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
as it starts and every hour, and downloads one in the background.

- **As it starts**, a newer version is installed straight away, and g1t
  opens again on it a moment later, before you have begun working in it.
  If something in the app misbehaves, quitting and opening g1t again is
  enough to be on the newest version. The one exception is your runner
  in the middle of a job, which is never cut short: then the update waits
  like any other.
- **Later on**, it never installs under you: a notification and the
  tray's **Restart to update** say it is ready, and the restart, or
  quitting, installs it.

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

- **Windows jobs on a Mac.** Sandboxed macOS jobs are designed, not
  released, so a Mac's sandbox runs Linux jobs only.
- **Choosing the sandbox's share of the computer.** It takes half the
  CPUs (at most 8) and a quarter of the memory (2 to 8 GB); the app has no
  setting for it yet.
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
| The runner's release key | The app trusts a `g1t-runner` release only when its manifest is signed with g1t's runner release key, whose public half (the repository variable `RUNNER_RELEASE_PUBLIC_KEY`) is built into the app, in `src-tauri/src/runner/native.rs`. To build the app for a g1t of your own, whose runner releases you sign with your own key, set `G1T_RUNNER_RELEASE_KEY` to its public key, base64, when you build it. |
| The updater's signing key | `node scripts/desktop-release.mjs keygen`, once. The private key is the repository secret `DESKTOP_SIGNING_KEY`; the public key is `plugins.updater.pubkey` in `tauri.conf.json`. Losing the private key means every installed app stops updating: keep it. |
| Linux builds | g1t's own Linux machines, in every release. |
| Windows builds | Either a Windows machine registered as a [self-hosted runner](/guides/self-hosted-runners/) with the labels `self-hosted` and `windows` (Rust, Node and the Visual Studio build tools on it) and the repository variable `DESKTOP_WINDOWS_RUNNER` set to `true`; or, with no Windows machine, `DESKTOP_WINDOWS_FROM_LINUX` set to `true`, which cross-builds on Linux with `cargo-xwin` and NSIS and needs `aka.ms` and `download.visualstudio.microsoft.com` among the project's [workflow-only domains](/guides/guardrails/#workflow-only-domains) for `desktop-release.yml` in `production`, where the MSVC runtime is fetched from. |
| macOS builds | A Mac, registered as a self-hosted runner with the labels `self-hosted` and `macos`, and the repository variable `DESKTOP_MACOS_RUNNER` set to `true`. |
| A platform with no machine | Its job is skipped and the release goes out with the rest; the download page says which platforms a release lacks, and the next release fills them in. |
| Where releases are served | `g1t.sh/downloads/desktop/<version>/<file>`, from the same bucket as the runner's and the CLI's releases. |

A self-hosted g1t does not serve the app's releases: the app always
updates from g1t.sh, and `g1t.sh/download` is where to send people.
