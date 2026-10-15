---
title: The phone app
description: g1t on Android and iOS, built with Expo. Highly experimental and barely working yet. Android first, downloaded from g1t.sh while it waits for Google Play.
---

The phone app is meant to be g1t on Android and iOS, with its own
screens for what you do away from a desk: talking with your team in
Chat, with notifications on your phone, and reviewing pull requests in
Code. Everything else opens on the site, in your phone's browser.

:::caution[Highly experimental]
The phone app is early and barely works yet: expect missing screens,
rough edges and things that break. For real work, use
[the desktop app](/guides/desktop/) or g1t in your phone's browser.
:::

## Install it

Android comes first. Get it from [g1t.sh/download](https://g1t.sh/download):
the page opens on **Android** when you visit it on an Android phone, and
[g1t.sh/download?platform=android](https://g1t.sh/download?platform=android)
opens it from anywhere.

1. On your Android phone, choose **Download for Android**. On a computer,
   scan the code beside it with the phone's camera instead.
2. Open the downloaded file. Android asks once to allow your browser to
   install apps: allow it. If Play Protect warns about an unknown app,
   choose **More details**, then **Install anyway**.
3. Open **g1t** and choose **Sign in with g1t**.

Point at the file's name on the page to see its SHA-256, to check the file
you have is the one g1t published. Like every g1t build during the alpha,
the app isn't code-signed yet, which is why Android warns
([unsigned during the alpha](/guides/desktop/#unsigned-during-the-alpha)).

**Why a download, and not Google Play?** Google Play and the App Store
publish a company's apps only once it is verified with a D-U-N-S number,
and Flagon's is on its way. Until then the Android app is published on
g1t.sh, as [the desktop app](/guides/desktop/) is. It moves
into Google Play as soon as it can. iOS has no way in but the App Store,
so it follows then.

**Updates** reach the app by themselves: most arrive the next time you
open it, with nothing to install. A change that needs a new install is a
new release on the download page; installing it over the one you have
keeps you signed in.

The bar along the bottom is the site's phone bar:

| Tab | What is on it |
| --- | --- |
| **Home** | Coming. Opens Home on the site meanwhile. |
| **Chat** | Your starred conversations, channels and direct messages, with what is unread, moving live. See [Chat](#chat). |
| **Notifications** | Coming. Opens your notifications on the site meanwhile; messages to you already arrive [on the phone](#notifications). |
| **Code** | The workspace's repositories, each with its pull requests and issues. A pull request shows its description, checks, conversation and changed files, and you can approve it or ask for changes. An issue shows the pull requests made for it, and you can comment. Shown when you use Code in the workspace. |
| **More** | Whether this phone gets notifications, your workspaces, how you signed in, and **Sign out**. |

## Chat

Chat on the phone is the site's Chat: the same conversations, as they
happen.

- **Conversations** show messages as the site draws them: bold, italic,
  code, lists, quotes, tables and links, with `@mentions`, `#channels`
  and `#123` references standing out. Messages by one person a few minutes
  apart run together, and each day is marked.
- **Live.** New messages, edits, deletions and reactions appear as they
  happen, and the line above the box says who is typing. Unread counts in
  the list and on the **Chat** tab move as messages arrive anywhere.
- **Sending** shows your message at once. If it doesn't reach g1t, it
  stays, marked **Not sent**: tap it to try again.
- **Long-press a message** to react, reply in a thread, copy it, or edit
  or delete your own. Tap a reaction to add yours or take it back.
- **Threads** open from a message's replies, with the message they are
  under at the top.
- **⋯** on a conversation stars, mutes or leaves it.
- **New message** (the pen at the top of Chat) messages a person, or a few
  people together, or makes a channel. **Browse** at the
  foot of the list joins public channels.

A notification for a conversation you have open is not shown; one for
another shows as a banner at the top of the screen.

## Notifications

The phone gets the same notifications as [browser push](/guides/notifications/#on-your-phone):
messages to you, mentions and replies in threads you are in, under the
same rules. Nothing comes while you are using
g1t in a browser or in the app itself, and nothing in
[Do not disturb](/guides/chat/#sounds-and-do-not-disturb). Tapping one
opens the conversation or thread it is about.

The app asks to notify you the first time you sign in. To change it
later, use **More → Notifications on this phone**, or the phone's own
settings for g1t, where Android lists the **Messages** channel. Signing
out stops them on that phone.

## Signing in

**Sign in with g1t** opens g1t.sh in your phone's browser, where you sign
in as usual (with your password, GitHub, two-factor) and approve the app.
The browser sends you back to the app, signed in. The app never sees your
password. This is [OAuth](/guides/authentication/#signing-in-with-oauth):
the app is listed as **g1t for Android** or **g1t for iOS** in
[Settings → Connected applications](https://g1t.sh/settings/applications),
where **Change access** narrows what it can do and **Sign out** ends it at
once.

The approval page lists what the app asks for: reading your account,
workspaces, repositories, checks and workflows, reading and writing
issues, pull requests and notifications, and reading artifacts. Untick what you would rather it
could not do.

**Use an access token** signs in with a
[personal access token](/guides/authentication/#access-tokens) you paste
in instead. The token stays on your phone, in its keystore.

The app asks for `chat:read` and `chat:write` too. They let it use
Chat's routes and live connections on the site, and register for
notifications, and nothing else there: the app's sign-in cannot open the
site's pages as you.

## Links

A `g1t://` link opens the app, as it opens [the desktop app](/guides/desktop/#links):
`g1t://acme/-/chat/dm/chn_1` is that conversation. The app shows the
pages it has screens for:

| Link | Opens |
| --- | --- |
| `g1t://<workspace>/-/chat`, `…/-/chat/<channel>`, `…/-/chat/dm/<id>` | Chat, or the conversation, in that workspace |
| `g1t://<owner>/<repo>` | The repository |
| `g1t://<owner>/<repo>/pull/<number>`, `…/issues/<number>` | The pull request or issue |

Any other page opens on the site, in the browser.

## Your own g1t

The app works with a g1t you [run yourself](/guides/self-hosting/) as well
as with g1t.sh. It talks to one g1t at a time, and opens on g1t.sh unless
you point it elsewhere. Two ways to point it at yours:

- **Scan its code.** Your g1t's download page, `<your g1t>/download`, has
  a QR code under its platforms, **Use the phone app with** your g1t. Scan it with the phone's camera, or
  open the page on the phone and choose **Open in the g1t app**. The app
  asks **Use g1t.example.com?**, then signs you in there.
- **Type its address.** On the sign-in screen, choose **Using your own
  g1t? Sign in there** and enter the address you open it at in a browser,
  such as `g1t.example.com`.

Either way the app reads `<your g1t>/.well-known/g1t.json`, where your g1t
says where its API is, so you never type that. A g1t from before the phone
app has no such file: the app then takes the API to be `api.` in front of
the site, and offers **Its API is at another address** if it is not.

The sign-in screen then says **Signing in to g1t.example.com**, with
**Change** and **Use g1t.sh**. Switching signs you out of the g1t you were
on.

| Your g1t | What to know |
| --- | --- |
| Reached by the phone | `PUBLIC_URL` and `API_URL` must be addresses the phone can open. `localhost` on a phone is the phone itself: use your computer's address on the network, or a domain. |
| `https` | Store builds of the app open `https` addresses only, as Android requires. A development build also opens `http`, for a g1t on your own network. |
| Notifications | Work with no setup: your g1t sends them through Expo's push service, as g1t.sh does. To keep notifications' words off Expo's, Google's and Apple's services, set `PHONE_PUSH=off` ([self-hosting](/guides/self-hosting/#the-phone-app)); the app then says your g1t sends no notifications, and Chat still updates while it is open. |
| Older versions | A g1t from before the phone app does not let the app's sign-in into Chat. Upgrade it, or sign in with an access token that has **Use the website as you**. |

## What's not there yet

- **Google Play and the App Store**, once Flagon's D-U-N-S number
  arrives ([above](#install-it)). Until then, Android from the download
  page; iOS waits for the App Store.
- **Home, Notifications and Artifacts** as tabs of their own.
  Their pages open on the site meanwhile.
- **Formatting in Code.** Descriptions and comments show their Markdown
  as written; messages in Chat are formatted.
- **Attachments and custom emoji.** Files in messages, and a
  workspace's own `:emoji:`, show as their names.
- **Replying from a notification**, without opening the app.
- **https links.** `g1t.sh` addresses open the site in the browser, not
  the app, until g1t.sh publishes the files Android and iOS check first.

## For operators: building and releasing

The app lives in `apps/mobile`: [Expo](https://expo.dev) with Expo
Router, in TypeScript, sharing types with the site through
`@g1t/contracts`. It builds with EAS Build. `apps/mobile/README.md` has
the commands for running it on a phone and the first-time setup.

| Build | Command | What it makes |
| --- | --- | --- |
| Development | `eas build --profile development --platform android` | An APK of `g1t (dev)` (`sh.g1t.app.dev`) that loads its code from your computer. |
| Preview | `npm run build:android:apk -w @g1t/mobile` | An APK of `g1t` (`sh.g1t.app.preview`) to install on testers' phones. |
| Production | `npm run build:android -w @g1t/mobile` | An Android App Bundle of `g1t` (`sh.g1t.app`) for Google Play. |

The three install side by side. `eas submit --platform android` sends
the latest production build to Google Play's internal testing track as a
draft, once there is a Play account to send it to.

### Releasing on g1t.sh/download

Until the app is in Google Play, the `preview` build is the one people
install, from g1t.sh/download. A release is a tag `mobile-v<version>`,
where the version is `version` in `apps/mobile/app.config.ts`: push it,
and the `Mobile release` workflow (`.g1t/workflows/mobile-release.yml`)
has EAS build the APK, then publishes it to the `g1t-downloads` bucket
at `g1t.sh/downloads/mobile/<version>/` and points `mobile/latest.json`
at it, which the download page reads. `scripts/mobile-release.mjs` does
the same by hand (`build`, `fetch`, `manifest`, `publish`).

| Secret or variable | What it is |
| --- | --- |
| `EXPO_TOKEN` | An Expo access token with access to the g1t project, from expo.dev |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | As the deploy has them |

Most changes need no release: `eas update --channel preview` in
`apps/mobile` sends the app's new code to every installed copy of that
version, which takes it the next time it opens. A release is for a change
to the app's native side (a new native module, `app.config.ts`) or its
`version`, which is also what decides which updates a copy takes.
