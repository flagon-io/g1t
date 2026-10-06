# How g1t.sh ships CSS

Internal research, 2026-10-06. Prompted by GitHub's "Improving site
performance by shipping more CSS" (github.blog, engineering). Read-only:
nothing here is applied yet. The measurements can be repeated with the
commands at the end.

## Verdict

- **The article's technique does not apply to us. We already ship CSS the
  way GitHub moved to.** GitHub replaced runtime CSS-in-JS
  (styled-components) with static CSS Modules and got faster server
  rendering. apps/web has no CSS-in-JS. Tailwind v4 compiles to one static
  stylesheet at build time. Nothing runs at render time to produce styles,
  and no `<style>` tags are injected.
- **We do have a CSS delivery problem, and it is a small fix.** The one
  stylesheet is the **last** element in `<head>`. It comes after 2 font
  preloads and 38 to 58 `modulepreload` links. On a slow mobile link it
  shares bandwidth with roughly 400 KB of JavaScript and fonts, and first
  paint waits for it. Under real (DevTools) slow-4G throttling, the
  stylesheet finished at 2.9 to 3.3 s. First paint followed at 3.5 s. TBT
  was 0 and the document had arrived at 0.7 s.
- **Recommended:** (1) emit the stylesheet first in `<head>`, ahead of the
  module preloads. (2) Send it as a `Link: rel=preload` response header, so
  Cloudflare Early Hints can start it during server think time. Expected
  gain: roughly 0.3 to 0.4 s off FCP/LCP on mobile in the Lighthouse model,
  and up to the CSS's whole load time (1 s or more) on pages with slow
  loaders, for first visits. Repeat visits gain nothing, because the CSS is
  cached immutable for a year. Risk is low; the details are under
  [Patches](#patches).
- **Not recommended:** per-route CSS splitting, critical-CSS inlining and
  CSS Modules. They would add requests, HTML weight or complexity for about
  15 KB (brotli) that is already cached across every page.

## The article

GitHub's Primer design system and github.com styled React components with
styled-components (CSS-in-JS). That had three costs:

- Styles were computed and injected at runtime, on the server during SSR
  and on the client during hydration.
- SSR spent time collecting styles.
- The overhead grew with the number of components on a page.

The fix was CSS Modules: plain `.module.css` files colocated with
components and compiled to static stylesheets "sent as part of the HTML
for a page", with no client or server runtime. The title's "shipping more
CSS" means more static CSS bytes in exchange for no runtime styling work.

How they did it:

1. **Primer, 2023 to 2024.** CSS Module files beside each component,
   feature-flagged old/new styles, visual regression tests, rolled out to
   the team, then staff, then everyone.
2. **github.com, 2025 to 2026.** A `@primer/styled-react` bridge kept the
   legacy `sx` prop working. They migrated about 7,760 `sx` props:
   - 6,419 by May 2026, with a VS Code extension (sx-to-css) and a codemod;
   - the last 895 by Copilot agents in three weeks.
3. **Theming, 2026.** They moved off styled-components theme utilities to
   CSS variables (`@primer/css`).

Measured results (server-side only; the post gives no client metrics such
as LCP, INP or CLS, and no byte counts):

- Primer migration (Dec 2024): **55% less time to server-render a page**
  and **25% less time for components to initialize**.
- github.com migration: SSR improvements **from 1% up to about 22%** per
  page; the best controller improved by 21.97%.
- 100% CSS Modules as of June 2026.

What we take from it: the expensive thing was *runtime* styling. GitHub's
end state is static CSS in a stylesheet, which is where apps/web already
is.

## How apps/web ships CSS today

| Question | Answer |
|---|---|
| Styling system | Tailwind v4 via `@tailwindcss/vite`. Tokens and fonts come from `@g1t/theme`. Custom CSS (keyframes, `art-*` drawings, markdown) is in `app/app.css`. |
| CSS-in-JS | None: no styled-components, emotion, stitches or runtime `<style>` injection. `style=""` attributes are CSS variables on drawings (114 on `/`, 1 to 38 elsewhere) and Shiki token colors in code views. |
| Files | **One** stylesheet, `assets/root-<hash>.css`, imported once in `app/root.tsx` (`import "./app.css"`). No route imports CSS, so the manifest has CSS on the root route only. |
| Size | **120,058 B raw, 18,758 B gzip -9, 15,058 B brotli -q11**. On the wire from Cloudflare: about 19.9 KB. Breakdown: Tailwind utilities 93 KB; `@property` registrations 2 KB (in a 4.5 KB block); theme 2.6 KB; base 4 KB; custom CSS outside layers about 18 KB; 7 `@font-face`, 23 `@keyframes`. |
| Caching | `cache-control: public, max-age=31536000, immutable` (hashed name). Every page shares the same file, so after the first page it costs nothing. |
| How it's loaded | A render-blocking `<link rel="stylesheet">`, which is correct. **But it is the last tag in `<head>`**: icons, then 2 font preloads, then 38 (`/pricing`) to 58 (`/flagon-io/g1t`) `modulepreload`s, then the stylesheet. There is no `preload` for it, no `Link` header, no Early Hints, and no inlined critical CSS. |
| Fonts | Hanken (22 KB) and Bricolage (66 KB) are preloaded and use `font-display: swap`, with metric-matched fallbacks (`size-adjust` and overrides), so swapping does not shift layout. Plex Mono loads on demand. |
| React Router | `<Links/>` renders the route CSS from the manifest. On client navigation, React Router loads the next routes' stylesheets before committing. With a single shared file that is already cached, navigation never waits on CSS and there is no late-loaded route stylesheet. |
| Animations | Infinite animations exist only in the landing drawings. They are paused off-screen (`[data-paused]`), promoted to their own layer (`will-change` on `[data-live]`), and stopped under `prefers-reduced-motion`. |

The order matters because the browser asks for resources in document
order and the CSS is asked for last. In the DevTools-throttled run of
`/flagon-io/g1t/pull/1` (slow 4G, 150 ms RTT, about 1.6 Mbps), all 61
subresources were requested between 645 and 664 ms. The stylesheet was the
61st. The bandwidth was then shared:

| Resource | Bytes | Requested (ms) | Finished (ms) |
|---|---:|---:|---:|
| HTML | 16,555 | 0 | 699 |
| Hanken font (preload) | 22,082 | 645 | 3,282 |
| Bricolage font (preload) | 66,554 | 646 | 4,271 |
| entry.client.js | 68,516 | 649 | 4,310 |
| 56 other modulepreloads | ~300 KB | 649 to 664 | 1,268 to 4,135 |
| **root.css** | **19,890** | **664** | **3,271** |
| First contentful paint | | | **3,515** |

Chrome gives the stylesheet top priority. Cloudflare's HTTP/3 prioritization
should favor it on a real connection more than DevTools throttling does,
so these absolute numbers are pessimistic. The direction holds either way:
nothing paints until the CSS arrives, and the CSS is queued behind about
450 KB that is not needed for first paint.

## Measurements

The build is `npm run build` in apps/web, run locally on 2026-10-06. Its
CSS hash `KP0DOluu` matches production. CSS requests are counted from the
live HTML.

| Page | HTML (decoded) | CSS requests | modulepreloads | TTFB (curl, server-timing) |
|---|---:|---:|---:|---|
| `/` | 194 KB | 1 | 42 | 462 ms (server 33 ms) |
| `/pricing` | 64 KB | 1 | 38 | 254 ms (server 180 ms) |
| `/flagon-io/g1t` | 118 KB | 1 | 58 | **1,403 ms** (server 1,311 ms, 22 service calls) |
| `/flagon-io/g1t/pull/1` | 76 KB | 1 | 57 | 234 ms (server 74 ms) |

Lighthouse 13.5.0, headless Chrome, signed out, performance only. The
default mode is simulated throttling. "CSS est." is Lighthouse's
render-blocking estimate for the stylesheet.

| Page | Mode | Score | FCP | LCP | TBT | CLS | Style+layout | CSS est. |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `/` | desktop | 82 | 1.83 s | 1.93 s | 0 | 0.000 | 145 ms | 110 ms |
| `/` | mobile | 71 | 4.30 s | 5.06 s | 0 | 0.000 | 476 ms | 420 ms |
| `/` | mobile, run 2 | 71 | 4.24 s | 5.01 s | 0 | 0.000 | | 290 ms |
| `/` | mobile, DevTools throttling | 83 | 3.51 s | 3.51 s | 0 | 0.000 | | 100 ms |
| `/pricing` | desktop | 95 | 1.08 s | 1.19 s | 0 | 0.000 | 63 ms | 50 ms |
| `/pricing` | mobile | 76 | 3.85 s | 4.40 s | 0 | 0.000 | 189 ms | 330 ms |
| `/flagon-io/g1t` | desktop | 86 | 1.61 s | 1.69 s | 0 | 0.000 | 36 ms | 80 ms |
| `/flagon-io/g1t` | mobile | 64 | 5.43 s | 6.21 s | 0 | 0.000 | 131 ms | 410 ms |
| `/flagon-io/g1t/pull/1` | desktop | 89 | 1.46 s | 1.57 s | 0 | 0.001 | 28 ms | 40 ms |
| `/flagon-io/g1t/pull/1` | mobile | 64 | 5.44 s | 6.30 s | 0 | 0.000 | 151 ms | 420 ms |
| `/flagon-io/g1t/pull/1` | mobile, run 2 | 65 | 5.32 s | 6.05 s | 0 | 0.001 | | 430 ms |
| `/flagon-io/g1t/pull/1` | mobile, DevTools throttling | 83 | 3.52 s | 3.52 s | 1 | 0.001 | | 170 ms |

What the numbers say:

- **Layout shift is solved.** CLS is 0.000 to 0.001 everywhere. The only
  shifts recorded were a `<time>` element and a muted caption on the pull
  request page, both under 0.001.
- **No main-thread problem.** TBT is 0 and no task is over 50 ms on any
  page. A lab tool can't measure INP, but with no long tasks and small DOMs
  (358 to 1,474 nodes) nothing points to an INP issue. Style recalculation
  and layout cost 28 to 151 ms per load. The exception is `/` on mobile at
  476 ms under 4x CPU slowdown, which comes from DOM size (1,474 nodes)
  and the landing drawings, not from selector cost: Tailwind selectors are
  single classes. Paint on `/` (765 ms simulated mobile) is the animated
  drawings, already layered and paused off-screen.
- **Unused CSS passes.** Lighthouse's unused-CSS audit passes on all four
  pages. A 15 KB brotli file is not worth splitting.
- **The lost time is network and ordering.** Mobile FCP is 3.5 to 5.4 s
  while the document arrives in about 0.1 to 0.7 s and the main thread is
  idle. Lighthouse's render-blocking estimate for the stylesheet is 290 to
  430 ms on mobile (simulated), and the waterfall above shows why.
- The simulated mobile LCP has an extra 1.1 s of "render delay" on the
  repo and pull request pages. It did not reproduce under DevTools
  throttling (FCP = LCP = 3.5 s), so it looks like a simulation artifact of
  the long modulepreload list rather than a real delay. It is worth
  re-checking after the patches.

## Patches

Neither patch is applied. Both are small.

### 1. Stylesheet first in `<head>` (apps/web/app/root.tsx)

Import the stylesheet as a URL and make it the first link, with a React 19
`precedence`. React then hoists it into the stylesheet section of the
head, which it writes before bulk preloads such as `modulepreload`. Nothing
else changes, and React dedupes it on the client.

```diff
-import "./app.css";
+import stylesheet from "./app.css?url";
 ...
 export const links: Route.LinksFunction = () => [
+  // First, so it is asked for before the fonts and the module preloads:
+  // nothing on the page paints until it arrives.
+  { rel: "stylesheet", href: stylesheet, precedence: "default" },
   { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
```

Verify before shipping:

1. Run `npm run build`. Then check that `build/client/assets` still has
   exactly one CSS file, and that the server-rendered `<head>` has the
   stylesheet before the first `modulepreload` (curl a local `wrangler dev`
   or a preview).
2. Check that Tailwind's Vite plugin still processes `app.css` imported
   with `?url` in dev. React Router's own templates use this pattern; if
   HMR for styles regresses in dev, keep the side-effect import for dev
   only.
3. If React does not hoist it as expected, a fallback gets the same
   ordering: drop `precedence` and render
   `<link rel="stylesheet" href={stylesheet} />` directly in `Layout`
   before `<Meta />`.

Expected gain: the stylesheet goes from the 61st request to the 1st. On a
bandwidth-limited first visit it then finishes before most of the JS
rather than among it. That means about 0.3 to 0.4 s off mobile FCP/LCP
(Lighthouse's render-blocking estimate), and more on slower real
connections. There is no change on desktop broadband or repeat visits.

Risk: low. The same file, the same blocking semantics, a different
position. The only real risk is the dev-mode `?url` behaviour above.

### 2. `Link` preload header for Early Hints (apps/web/app/entry.server.tsx)

In `handleRequest`, before the response is built:

```ts
// The stylesheet, announced in the headers: with Early Hints on, the
// browser fetches it while loaders are still running.
const css = routerContext.manifest.routes.root?.css ?? [];
if (css.length > 0) {
  responseHeaders.append("Link", css.map((href) => `<${href}>; rel=preload; as=style`).join(", "));
}
```

Turn on **Early Hints** for the g1t.sh zone (Speed > Optimization >
Content Optimization, or `early_hints` in the zone settings API). It needs
a line in `scripts/cloudflare-setup.py` and a note in
docs/SELF_HOSTING.md: self-hosted installs ignore it harmlessly, because a
`Link` header is just a header.

Cloudflare remembers `Link: rel=preload` headers from HTML responses and
sends them as a `103` before the Worker answers the next request for that
URL. Today g1t.sh sends no `Link` header (checked 2026-10-06). The gain is
largest exactly where we are slowest: `/flagon-io/g1t` spent 1.3 s in
loaders, all of which could overlap with fetching the CSS (and, if we
choose, the two preloaded fonts) on a first visit. Even without a 103, the
header lets the browser start the CSS as soon as the response headers
arrive, before parsing any HTML.

Risk: low.

- The asset names are content-hashed, so a cached hint can never point at
  a stale file. At worst, right after a deploy, a hint names an old hash
  that still exists in the asset store until it rotates.
- Early Hints apply only over HTTP/2 and HTTP/3.

### 3. Optional follow-ups

- **Trim what competes with first paint.** The two preloaded fonts (88 KB)
  are requested before the CSS. With `font-display: swap` and
  metric-matched fallbacks they never block paint, so their preloads could
  move after the stylesheet (patch 1 does this). Alternatively, preload
  only Hanken and let Bricolage (66 KB, headlines only) load from the CSS.
- **Fewer modulepreloads.** 38 to 58 per page, many under 1 KB (`dist-*`,
  `access-*`, `skeleton-*`). Grouping small shared chunks in
  `vite.config.ts` (as `icons` already is) would cut request overhead on
  first visits. This is a JS question and outside this note.

## Repeat the measurements

```sh
cd apps/web && npm run build                              # CSS size: build/client/assets/*.css
npx lighthouse https://g1t.sh/<page> --preset=desktop --only-categories=performance --output=json
npx lighthouse https://g1t.sh/<page> --only-categories=performance --output=json                          # mobile, simulated
npx lighthouse https://g1t.sh/<page> --throttling-method=devtools --only-categories=performance --output=json  # mobile, real throttling
```

The waterfall is `audits["network-requests"]` in the JSON. The
render-blocking estimate is `audits["render-blocking-insight"]`.
