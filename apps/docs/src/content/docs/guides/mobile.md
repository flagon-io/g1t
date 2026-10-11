---
title: The phone app
description: g1t on Android and iOS, built with Expo. Chat, Code and Customize on your phone, signed in with g1t's own OAuth. Not in the stores yet; this is how it works and how to build it.
---

The phone app is g1t on Android and iOS, with its own screens for what
you do away from a desk: answering in Chat, reviewing what agents made in
Code, and seeing the skills, connectors and plugins your workspace can
use in Customize. Everything else opens on the site, in your phone's
browser.

It is not in Google Play or the App Store yet. Android comes first. Until
then, it is built from `apps/mobile` in
[g1t's repository](https://g1t.sh/flagon-io/g1t), as
[For operators](#for-operators-building-and-releasing) says.

| Tab | What is on it |
| --- | --- |
| **Chat** | The channels you are in and your direct messages, with unread counts. A conversation shows its messages and agents' cards, live while it is open, and you write back from the box at the bottom. |
| **Code** | The workspace's repositories, each with its pull requests and issues, open or closed. A pull request shows its description, checks, conversation and changed files, and you can approve it or ask for changes. An issue shows the pull requests made for it, and you can comment. |
| **Customize** | **Skills** (what agents know how to do), **Connectors** (the tools they can reach, the Marketplace's integrations today) and **Plugins** (what adds pages and tools, the Marketplace's extensions today). Each opens where it is set up on the site. |
| **You** | Your workspaces, to switch between them, how you signed in, and **Sign out**. |

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
issues, pull requests and notifications, recalling memory, reading
artifacts, and putting agents to work. Untick what you would rather it
could not do.

**Use an access token** signs in with a
[personal access token](/guides/authentication/#access-tokens) you paste
in instead. The token stays on your phone, in its keystore.

### Chat and the app's sign-in

Chat is served by the site, and the site takes only a browser's session
or a token with **Use the website as you** turned on. The app's OAuth
sign-in is neither yet, so with it Code and Customize work and Chat says
it needs another sign-in. Until the app's sign-in opens Chat, sign in
with **Use an access token** and a token with
[Use the website as you](/guides/authentication/#use-a-token-on-the-website)
turned on. Keep that token as safe as your password: on the website it can
do anything you can.

## Links

A `g1t://` link opens the app, as it opens [the desktop app](/guides/desktop/#links):
`g1t://acme/-/chat/dm/chn_1` is that conversation. The app shows the
pages it has screens for:

| Link | Opens |
| --- | --- |
| `g1t://<workspace>/-/chat`, `…/-/chat/<channel>`, `…/-/chat/dm/<id>` | Chat, or the conversation, in that workspace |
| `g1t://<owner>/<repo>` | The repository |
| `g1t://<owner>/<repo>/pull/<number>`, `…/issues/<number>` | The pull request or issue |
| `g1t://<workspace>/-/marketplace…`, `…/-/agents/skills` | Customize |

Any other page opens on the site, in the browser.

## Your own g1t

If you [run g1t yourself](/guides/self-hosting/), choose **Server** on the
sign-in screen and enter your site's address, such as
`https://g1t.example.com`. The app takes the API to be `api.` in front of
it (`https://api.g1t.example.com`); if yours is elsewhere, enter it under
**API**. **Use g1t.sh** goes back.

## What's not there yet

- **Store releases.** Google Play first, then the App Store.
- **Notifications on your phone.** g1t sends browser and desktop
  notifications today; push to phones needs g1t to send through Firebase
  and Apple, which is coming.
- **Chat with the app's own sign-in**, as [above](#chat-and-the-apps-sign-in).
- **Home, Notifications, Agents and Artifacts** as tabs of their own.
  Their pages open on the site meanwhile.
- **Formatting.** Messages, descriptions and comments show their Markdown
  as written.
- **Threads.** A message's replies are counted, and read on the site.
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
| Preview | `npm run build:android:apk -w @g1t/mobile` | An APK of `g1t (beta)` (`sh.g1t.app.preview`) to install on testers' phones. |
| Production | `npm run build:android -w @g1t/mobile` | An Android App Bundle of `g1t` (`sh.g1t.app`) for Google Play. |

The three install side by side. `eas submit --platform android` sends
the latest production build to Google Play's internal testing track as a
draft.
