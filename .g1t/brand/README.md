# g1t brand files

The mark is "the fleet": three 1s stepping back in depth, the agents at work
behind the one change in front. The front 1 is `#ededef` (`--g1t-fg`), the two
behind it are lavender `#b6a8ff` (`--g1t-merged`) at 65% and 35%, on the very
dark gray base `#0f0f11` (`--g1t-bg`). On light backgrounds the front 1 is
`#161618` and the lavender deepens to `#6b56e8`.

These are the files to upload to Stripe and similar services. The site serves
its own copies from `apps/web/public` and `apps/docs/public`.

| File | Size | Use |
| --- | --- | --- |
| `icon-512.png` | 512×512, dark square | Stripe branding icon (square, at least 128px), Slack, GitHub app avatars |
| `icon-1024.png` | 1024×1024, dark square | App stores and anywhere asking for a large square icon |
| `icon-transparent-1024.png` | 1024×1024, transparent | Placing the mark on a dark surface of your own |
| `logo-on-dark.png` | 1056×642, dark background | Stripe branding logo (wide), docs and decks on dark |
| `logo-on-light.png` | 1056×642, white background | Invoices, receipts and anywhere the background is light |
| `og-1200x630.png` | 1200×630 | Social and Open Graph card |

## Sources

`svg/` holds the source of every file above and of the site's favicons:

| File | What it is |
| --- | --- |
| `svg/mark.svg` | The mark on transparent, for dark backgrounds (also `packages/theme/mark.svg`) |
| `svg/mark-on-light.svg` | The mark on transparent, for light backgrounds |
| `svg/mark-small.svg` | The 16px cut: pixel-aligned, with a notch between the front 1's flag and the bar behind it |
| `svg/icon-square.svg` | The mark on a full-bleed dark square (`icon-512.png`, `icon-1024.png`) |
| `svg/icon-rounded.svg` | The mark on a rounded dark tile (`favicon.ico` at 32 and 48, `brand/g1t-mark.*`) |
| `svg/icon-padded.svg` | The mark with room for a circle crop (`apple-touch-icon.png`, `icon-192.png`, `icon-512.png` in the apps) |
| `svg/favicon.svg` | The 16px cut with no tile, coloured for a light or dark browser (`favicon.svg` in the apps) |
| `svg/logo.svg`, `svg/logo-on-light.svg` | The mark and the wordmark, transparent, for dark and light backgrounds |
| `svg/logo-dark-bg.svg`, `svg/logo-light-bg.svg` | The same lockups with padding and a background |
| `svg/og.svg` | The social card; its tagline uses Inter and JetBrains Mono as live text |

The wordmark is "g1t" in Inter ExtraBold at -0.05em tracking, outlined to paths
so the files need no font.

## On the web

`apps/web/public/brand/` is served at `https://g1t.sh/brand/` for emails and
anything that links to the mark:

- `g1t-mark.svg`, `g1t-mark.png` (256px): the mark on a rounded dark tile, readable on any background
- `g1t-logo.svg`, `g1t-logo.png`: the lockup for light backgrounds, used in g1t's emails
- `g1t-logo-on-dark.svg`, `g1t-logo-on-dark.png`: the lockup for dark backgrounds
