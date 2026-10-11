# g1t for Android and iOS

The phone app: [Expo](https://expo.dev) (SDK 57, React Native 0.86) with
Expo Router, in TypeScript. Chat, Code and Customize, signed in with g1t's
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
      chat/            conversations, and one conversation, live
      code/            repositories, pull requests, issues, diffs
      customize/       Skills, Connectors, Plugins
      you/             workspaces, how you signed in, sign out
    +native-intent.tsx g1t:// links to screens (lib/links.ts)
  components/        the building blocks, themed (ui.tsx), and Code's
  lib/
    server.ts          which g1t: site and API addresses
    oauth.ts           OAuth 2.1 with PKCE against the server's metadata
    credentials.ts     the server and credentials, in the phone's keystore
    client.ts          every request: refresh, errors, the site or the API
    session.tsx        who is signed in, to which workspace
    chat.ts, code.ts   the data for Chat and Code (TanStack Query)
    customize.ts       Customize's listings, from @g1t/contracts' catalogs
  theme/             packages/theme/tokens.css's colours, for React Native
```

Shared types and catalogs come from `@g1t/contracts` (by subpath, such as
`@g1t/contracts/oauth`, so the app does not bundle every module).
Customize's three parts are defined there too (`customize.ts`), so the
site can move the Marketplace onto the same model.

## How it talks to g1t

| What | Where | How it is signed in |
| --- | --- | --- |
| Who you are, your workspaces | `GET {api}/user` | `Authorization: Bearer g1t_…` |
| Code | `{api}/repos…` REST | the same |
| Chat | `{site}/<workspace>/-/chat/api` and its live socket, as the site's own pages use them | the same header, which the site takes only from a token with **Use the website as you**; the socket gets a ticket from `{site}/-/live/ticket` first |
| Sign-in | `{api}/.well-known/oauth-authorization-server`, `{site}/oauth/authorize`, `{api}/oauth/token` | OAuth 2.1, PKCE (S256), public client |

The OAuth client is not registered anywhere: its id encodes its name and
redirect (`encodeOAuthClient`), so `g1t for Android` with
`g1t://oauth/callback` is the same client on every phone. Access tokens
last 30 days and are refreshed a minute before they expire; a refresh
token works once, so `lib/client.ts` shares one refresh between
requests.

### Open: Chat with the app's OAuth sign-in

OAuth tokens are made without the website permission
(`services/identity/src/oauth.rs` → `issue_oauth_tokens`), and Chat is
only on the site, so **an OAuth sign-in reaches Code but not Chat**. The
app says so on Chat and offers an access-token sign-in, which works today
with a token that has **Use the website as you**. The server needs one of
these before the app ships:

1. **Chat in the REST API** (recommended): `GET/POST /workspaces/:ws/chat…`
   in `apps/api` with `chat:read` and `chat:write` scopes, calling the chat
   service as the site does, and a socket ticket the API can mint. It is
   what the API and MCP will want anyway; the app moves its three calls
   in `lib/chat.ts` over.
2. **Let the site take OAuth tokens for Chat's routes alone**:
   `website-token.ts` accepts a token without `website` on
   `/<ws>/-/chat/api`, `/<ws>/-/chat/live` and `/-/live/ticket` when it
   has new `chat:*` scopes. Smaller, but it widens what the site accepts.

Turning `website` on for every OAuth token is not one of them: it would
let any approved application use the whole site as the person.

## Run it

You need Node 22 (the repository's).

### In Expo Go (quickest)

Everything the app uses is in Expo Go for SDK 57, so no native build is
needed:

```sh
npm install                      # at the repository's root: one workspace
cd apps/mobile
npx expo start                   # then scan the QR code with Expo Go
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
Connected applications. What Go can't do: open from `g1t://` links (they
go to an installed build) and show the app's own name and icon.

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
npx expo run:android             # builds g1t (dev) and starts Metro
```

`expo run:android` makes the native project (`android/`, ignored by git)
and installs `g1t (dev)`, which signs in through `g1t://oauth/callback`.
After the first build, `npx expo start` and the installed app are enough
until a native module changes. `eas build --profile development` makes
the same build in the cloud.

Checks, which CI runs from the root (`npm run typecheck`, `npm test`):

```sh
npm run typecheck -w @g1t/mobile
npm test -w @g1t/mobile          # lib/*.test.ts under Node
```

## Set up EAS and ship Android

Once, by someone with access to the Expo account and Google Play:

1. `npm install -g eas-cli`, then `eas login`.
2. In `apps/mobile`, `eas init`. It makes the EAS project and prints its
   id: put it in `EAS_PROJECT` in `app.config.ts` (the config is code, so
   `eas init` cannot write it there). Set `EAS_OWNER` in your shell if the
   project belongs to an organization.
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

### Before the first store release

- **Chat with OAuth**, above.
- **Push notifications**: `expo-notifications`, and in `services/notify`
  a subscription kind for Expo push tokens (or FCM and APNs) beside Web
  Push, registered from the app after sign-in.
- **App Links**: `https://g1t.sh/.well-known/assetlinks.json` naming
  `sh.g1t.app` and Play's signing certificate's SHA-256, then an
  `intentFilters` entry with `autoVerify` in `app.config.ts`, so g1t.sh
  links open the app. iOS needs `apple-app-site-association` the same way.
- **The brand's faces**: TTF copies of Hanken Grotesk, Bricolage
  Grotesque and IBM Plex Mono (packages/theme ships woff2), loaded with
  `expo-font`.
- **Agents' faces**: `components/ui.tsx`'s `Avatar` draws a letter for an
  agent; the site's `AgentFace` should be shared and drawn here.
- **The store listing**: screenshots, a privacy policy URL, and Play's
  data safety form (the app keeps the server and credentials in the
  keystore, and sends nothing anywhere but the g1t it is pointed at).

## Notes

- **React is pinned.** The site uses a newer React than React Native 0.86
  allows, so the app has its own `react` (19.2.3) and `metro.config.js`
  resolves every `react` import to it. `expo-doctor` reports the root's
  copy as a duplicate; that is expected here, and the bundle has one.
- **Icons** are drawn from the mark: `npm run icons -w @g1t/mobile`.
- **Versions**: `version` in `app.config.ts` is what people see;
  EAS counts build numbers itself (`appVersionSource: remote`). Over-the-air
  updates go to builds of the same `version` (`runtimeVersion`).
