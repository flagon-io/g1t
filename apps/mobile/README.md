# g1t for Android and iOS

The phone app: [Expo](https://expo.dev) (SDK 57, React Native 0.86) with
Expo Router, in TypeScript. Work, Chat and Code, signed in with g1t's
own OAuth. Android is the first target. What it does for people is in the
guide, [The phone app](../docs/src/content/docs/guides/mobile.md).

## Layout

```text
app.config.ts        name, ids and icons per build variant (APP_VARIANT)
eas.json             EAS Build profiles: development, preview, production
metro.config.js      one React for the app in the monorepo
scripts/icons.mjs    draws the icons from packages/theme/mark.svg
src/
  app/               the screens (Expo Router: one file, one route)
    sign-in.tsx        Sign in with g1t, an access token, or another server
    oauth/callback.tsx where the site sends sign-in back (g1t://oauth/callback)
    (app)/             signed in: the tabs
      work/            the workspace's work items: the list, an item, new
      chat/            the list, a conversation, a thread, new, browse
      code/            repositories, pull requests, diffs (opened from More)
      more/            Code, notifications, workspaces, sign out
      home/, notifications/  coming: they open the site
    ref.tsx            what #N names (a work item or a pull request), opened
    +native-intent.tsx g1t:// and https links to screens (lib/links.ts)
  components/        the building blocks, themed (ui.tsx); chat/, Code's and Work's
  lib/
    server.ts          which g1t: site and API addresses
    oauth.ts           OAuth 2.1 with PKCE against the server's metadata
    credentials.ts     the server and credentials, in the phone's keystore
    client.ts          every request: refresh, errors, the site or the API
    session.tsx        who is signed in, to which workspace
    chat.ts, code.ts, work.ts  the data for Chat, Code and Work (TanStack Query)
    live.ts            the site's live sockets, with tickets, kept open
    feed.tsx           counts, banners and presence while the app is open
    push.ts            notifications on the phone
  theme/             packages/theme/tokens.css's colours, for React Native
```

Shared types and catalogs come from `@g1t/contracts` (by subpath, such as
`@g1t/contracts/oauth`, so the app does not bundle every module).

## How it talks to g1t

| What                         | Where                                                                                         | How it is signed in                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Who you are, your workspaces | `GET {api}/user`                                                                              | `Authorization: Bearer g1t_…`                                                                                                   |
| Work                         | `{api}/workspaces/<workspace>/work…`, `…/labels`, `…/milestones` REST                         | the same                                                                                                                        |
| Code                         | `{api}/repos…` REST                                                                           | the same                                                                                                                        |
| Chat                         | `{site}/<workspace>/-/chat/api` and its live socket, as the site's own pages use them         | the same header, with `chat:*` ([below](#chat-with-the-apps-sign-in)); a socket gets a ticket from `{site}/-/live/ticket` first |
| Notifications                | `{site}/-/notify` and the feed socket `{site}/-/live`                                         | the same, with `notifications:*`                                                                                                |
| Sign-in                      | `{api}/.well-known/oauth-authorization-server`, `{site}/oauth/authorize`, `{api}/oauth/token` | OAuth 2.1, PKCE (S256), public client                                                                                           |

The OAuth client is not registered anywhere: its id encodes its name and
redirect (`encodeOAuthClient`), so `g1t for Android` with
`g1t://oauth/callback` is the same client on every phone. Access tokens
last 30 days and are refreshed a minute before they expire; a refresh
token works once, so `lib/client.ts` shares one refresh between
requests.

### Chat with the app's sign-in

Chat has no REST API: the app uses the site's own chat routes. The app
asks for `chat:read`, `chat:write`, `notifications:read` and
`notifications:write`, and the site takes a token holding them by name
(OAuth or personal, without "Use the website as you") on these alone
(`apps/web/app/lib/website-token.ts`, `scopedRoute` and `socketUser`):

| Route                                                      | Needs                                       |
| ---------------------------------------------------------- | ------------------------------------------- |
| `GET`, `POST /<ws>/-/chat/api`                             | `chat:read`, `chat:write`                   |
| `GET /<ws>/-/chat/person/<username>`                       | `chat:read`                                 |
| `GET /-/live/ticket` for `/<ws>/-/chat/live` and `/-/live` | `chat:read`                                 |
| `GET`, `POST /-/notify`                                    | `notifications:read`, `notifications:write` |

A full-access token does not count: it reaches Chat only with the website
permission.

### Live, and notifications

- **A conversation's socket** (`lib/chat.ts`, `useChannelLive`) brings new,
  changed and deleted messages, reactions and typing, and takes the
  app's own typing.
- **The feed** (`lib/feed.tsx`), the socket every tab of the site keeps,
  is open while the app is in front: unread counts, notifications (a
  banner, `components/chat/banner.tsx`) and presence. It tells g1t the app
  is focused, so nothing is pushed to the phone while it is in use; in the
  background it closes.
- **Push** (`lib/push.ts`): the app registers its Expo push token with
  `POST /-/notify` `{ intent: "register_device", device: { token, platform, name } }`
  and takes it back on signing out (`unregister_device`). The notify
  service sends through Expo's push service on the Android channel
  `messages`, with `data` `{ href, workspace, kind, tag, channel_id, thread_root, card }`;
  tapping one opens its thread or conversation.

## Run it

You need Node 24 (the repository's `.nvmrc`; EAS builds on 24.21.0, `eas.json`).

### In Expo Go (quickest)

Everything the app uses is in Expo Go for SDK 57, so no native build is
needed:

```sh
npm install                      # at the repository's root: one workspace
cd apps/mobile
npx expo start --go              # then scan the QR code with Expo Go
```

Install [Expo Go](https://expo.dev/go) on the phone, or press `a` for an
Android emulator. The phone and the computer must be on the same network
(or use `npx expo start --tunnel`).

Signing in works in Go: the site sends you back to Go's own address,
`exp://<your computer>:8081/--/oauth/callback`, which g1t accepts as an
application's own scheme. The approval page and Connected applications
call it **g1t in Expo Go**. Its client id encodes that address, so a new
network makes a new client: the app keeps the id it signed in with for
refreshing, and signing in again after a move just adds a new entry to
Connected applications. Chat works in Go in full, live, with banners
while the app is open. What Go can't do: notifications on an Android
phone (Expo took push out of Go there), open from `g1t://` links (they go
to an installed build), and show the app's own name and icon.

To develop against a g1t running on your computer, choose **Server** on
the sign-in screen and give its address on your network, such as
`http://192.168.1.20:5173` and the API's `http://192.168.1.20:8789`
(`localhost` on a phone is the phone). Run that g1t with its `SITE_URL`
and `API_URL` set to those addresses too: the API's OAuth metadata
names the sign-in page by `SITE_URL`, and the phone opens what it names.

### In a development build

For `g1t://` links, the app's own icon and name, and anything native Go
lacks later (push notifications):

```sh
npm run build:android:dev        # EAS builds g1t (dev) in the cloud: install it from the link
npx expo start                   # then open g1t (dev) on the phone; it finds this computer
```

The development build is `g1t (dev)` (`sh.g1t.app.dev`), with
`expo-dev-client`: it loads the app's code from `npx expo start` on your
computer, signs in through `g1t://oauth/callback`, and gets notifications
once Firebase is set up ([below](#push-notifications-on-android)). Build
it again only when a native module or `app.config.ts` changes; code
changes reload live. `.g1t/workflows/mobile-build.yml` builds it by hand
(Run workflow, `development`); its default, `preview`, is what testers
install, and main builds that again when the native side changes. The
run's summary links the build on expo.dev, whose QR code installs it. With Android Studio, `APP_VARIANT=development npx expo
run:android` builds the same app on your computer instead (it makes
`android/`, ignored by git).

Checks, which CI runs from the root (`npm run typecheck`, `npm test`):

```sh
npm run typecheck -w @g1t/mobile
npm test -w @g1t/mobile          # lib/*.test.ts under Node
```

## Set up EAS and ship Android

Once, by someone with access to the Expo account and Google Play:

1. `npm install -g eas-cli`, then `eas login`.
2. The EAS project exists (`35fb457b-…`, `EAS_PROJECT` in
   `app.config.ts`); `eas whoami` should be an account with access to it.
   Set `EAS_OWNER` in your shell if it belongs to an organization. On
   expo.dev, the project's GitHub settings take `apps/mobile` as the base
   directory.
3. `eas build --profile preview --platform android`. EAS makes and keeps
   the upload keystore the first time; say yes. The build ends with a link
   and a QR code to install the APK.
4. In the [Google Play Console](https://play.google.com/console), create
   the app with the package `sh.g1t.app`, and turn on Play App Signing.
5. `npm run build:android` makes the production App Bundle. Upload the
   first one by hand on Play's **Internal testing** track: Google requires
   that before its API accepts uploads.
6. For `eas submit`, make a Google Cloud service account with access to
   the app in the Play Console, download its JSON key, and add it to the
   EAS project's credentials (`eas credentials`). From then on,
   `eas submit --platform android --latest` sends a build to internal
   testing as a draft (`eas.json`'s `submit.production`).

iOS is the same with `--platform ios`, an Apple Developer account and the
bundle id `sh.g1t.app`; EAS makes the certificates.

### Releasing on g1t.sh/download (until Google Play)

Google Play and the App Store wait on Flagon's D-U-N-S number. Until then
the `preview` build, `g1t`, is what people install, from
g1t.sh/download:

```sh
# a new native side or version: bump `version` in app.config.ts, then
git tag mobile-v0.1.0 && git push origin mobile-v0.1.0   # .g1t/workflows/mobile-release.yml
# or by hand, from the repository's root:
node scripts/mobile-release.mjs build      # EAS builds the APK
node scripts/mobile-release.mjs fetch      # the newest finished preview build
node scripts/mobile-release.mjs manifest
node scripts/mobile-release.mjs publish    # to g1t.sh/downloads/mobile/, latest.json last

# code alone: over the air to every installed copy of this version
cd apps/mobile && npx eas-cli update --channel preview --message "What changed"
```

The workflow needs `EXPO_TOKEN` (expo.dev → Access tokens) beside the
deploy's Cloudflare secrets. Preview builds count their own versionCode
(`autoIncrement`), so each installs over the last.

### Push notifications on Android

Expo's push service sends to Android through Firebase Cloud Messaging,
which needs a Firebase project. Once:

1. In the [Firebase console](https://console.firebase.google.com), make a
   project, and in it an Android app for each package: `sh.g1t.app`,
   `sh.g1t.app.preview` and `sh.g1t.app.dev`. Download
   `google-services.json` (one file lists all three).
2. Give it to EAS as a file variable:
   `eas env:create --scope project --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret --environment production --environment preview --environment development`.
   `app.config.ts` reads it from there, or a `google-services.json` beside
   it locally (ignored by git).
3. In Firebase, **Project settings → Service accounts → Generate new private
   key**, then `eas credentials` → Android → the production build's package →
   **Google Service Account → Push Notifications (FCM V1)**, and upload that
   key. Repeat for `sh.g1t.app.preview` and `sh.g1t.app.dev`.
4. Build again. Pushes need a build: Expo Go on Android has none.

`EXPO_ACCESS_TOKEN` on the notify Worker is needed only if the Expo
project turns on **Enhanced push security**. Leave that off: self-hosted
g1ts push to this same app through this same project, without g1t's
token, and turning it on stops their notifications.

### Self-hosted g1t

The app works with any g1t (docs: the phone app guide's "Your own g1t",
and self-hosting's "The phone app"):

- `GET <site>/.well-known/g1t.json` (`@g1t/contracts/discovery`,
  `apps/web/app/routes/well-known-g1t.ts`) says where the API is and
  whether the g1t sends phones notifications (`PHONE_PUSH`). The app reads
  it in `lib/discover.ts`, and falls back to `api.<host>` for an older g1t.
- `g1t://connect?server=<site>` (`app/connect.tsx`) points the app at a
  g1t after asking; a self-hosted g1t's `/download` shows it as a QR code.
- On g1t.sh none of it shows: the sign-in screen has one button, and a
  quiet "Using your own g1t?" at its foot.
- Store builds open `https` only (Android blocks cleartext); development
  builds also open `http`, for a g1t on your network.

### Before the first store release

- **App Links**: `https://g1t.sh/.well-known/assetlinks.json` naming
  `sh.g1t.app` and Play's signing certificate's SHA-256, then an
  `intentFilters` entry with `autoVerify` in `app.config.ts`, so g1t.sh
  links open the app. iOS needs `apple-app-site-association` the same way.
- **The brand's faces**: TTF copies of Hanken Grotesk, Bricolage
  Grotesque and IBM Plex Mono (packages/theme ships woff2), loaded with
  `expo-font`.
- **The store listing**: screenshots, a privacy policy URL, and Play's
  data safety form (the app keeps the server and credentials in the
  keystore, registers a push token with the g1t it is pointed at, and
  sends nothing anywhere else).

## Notes

- **React is pinned.** The site uses a newer React than React Native 0.86
  allows, so the app has its own `react` (19.2.3) and `metro.config.js`
  resolves every `react` import to it. `expo-doctor` reports the root's
  copy as a duplicate; that is expected here, and the bundle has one.
  The doctor has no way to allow one duplicate, so EAS builds skip it
  (`EAS_BUILD_DISABLE_EXPO_DOCTOR_STEP` in `eas.json`); `npm run doctor`
  still runs it.
- **Icons** are drawn from the mark: `npm run icons -w @g1t/mobile`.
- **Versions**: `version` in `app.config.ts` is what people see;
  EAS counts build numbers itself (`appVersionSource: remote`). Over-the-air
  updates go to builds of the same `version` (`runtimeVersion`).
