# g1t brand files

The logo is G1T in 5×7 pixel capitals, the 1 in lavender; the icon is the 1.

- **Letters:** one-pixel strokes on a 5×7 grid. The G sits at column 0, the 1
  at column 6 and the T at column 10, one column closer than the usual
  advance, so the T's bar sits above the end of the 1's foot without
  touching it. The wordmark is 15 by 7 cells.
- **Pixels:** each is its own square, 0.8 of its cell, centred, with square
  corners.
- **Colour:** G and T are `#ededef` (`--g1t-fg`) and the 1 is lavender
  `#b6a8ff` (`--g1t-merged`), on the very dark gray base `#0f0f11`
  (`--g1t-bg`). On light backgrounds the letters are `#161618` and the 1 is
  `#6b56e8`. Printed in one ink, everything is that ink.
- **Icon:** the 1 alone, centred in a square, for favicons, app icons and
  the app's sidebar.
- **Name:** the product is "g1t" in lowercase in text. Only the artwork is
  capitals.

Vectors scale the pixels freely, which blurs them at small sizes, so the
small files are hand-fitted cuts on whole device pixels: at 16px each cell is
2px with no gap, at 32px 4px with a 1px gap, at 48px 5px with a 1px gap. The
PNGs are drawn with every pixel edge on a device pixel.

These are the files to upload to Stripe and similar services. The site serves
its own copies from `apps/web/public` and `apps/docs/public`.

| File | Size | Use |
| --- | --- | --- |
| `icon-512.png` | 512×512, dark square | Stripe branding icon (square, at least 128px), Slack, GitHub app avatars |
| `icon-1024.png` | 1024×1024, dark square | App stores and anywhere asking for a large square icon |
| `icon-transparent-1024.png` | 1024×1024, transparent | Placing the icon on a dark surface of your own |
| `logo-on-dark.png` | 1056×642, dark background | Stripe branding logo (wide), docs and decks on dark |
| `logo-on-light.png` | 1056×642, white background | Invoices, receipts and anywhere the background is light |

## Sources

`svg/` holds the source of every file above and of the site's favicons:

| File | What it is |
| --- | --- |
| `svg/mark.svg` | The icon, the pixel 1, centred in a transparent square, for dark backgrounds (also `packages/theme/mark.svg`) |
| `svg/mark-on-light.svg` | The icon on transparent, for light backgrounds |
| `svg/mark-small.svg` | The 16px cut: each cell 2px, no gap |
| `svg/icon-square.svg` | The icon on a full-bleed dark square, 1024 box on 100-unit cells (`icon-512.png`, `icon-1024.png`) |
| `svg/icon-rounded.svg` | The icon on a rounded dark tile, the 256px cut (`brand/g1t-mark.*`) |
| `svg/icon-padded.svg` | The icon with room for a circle crop, the 512px cut (`icon-512.png` in the apps; `apple-touch-icon.png` and `icon-192.png` are cut the same way at their own sizes) |
| `svg/favicon.svg` | The 16px cut with no tile, coloured for a light or dark browser (`favicon.svg` in the apps and `packages/theme`) |
| `svg/logo.svg`, `svg/logo-on-light.svg` | The wordmark, transparent and cropped to its ink, for dark and light backgrounds |
| `svg/logo-dark-bg.svg`, `svg/logo-light-bg.svg` | The wordmark with padding and a background, on 40px cells |

`favicon.ico` in the apps holds the 16, 32 and 48px cuts of the icon on a
rounded dark tile. The pixels are squares, so no file needs a font.

## On the web

`apps/web/public/brand/` is served at `https://g1t.sh/brand/` for emails and
anything that links to the mark:

- `g1t-mark.svg`, `g1t-mark.png` (256px): the icon on a rounded dark tile, readable on any background
- `g1t-logo.svg`, `g1t-logo.png` (300×140, shown at 60×28): the wordmark for light backgrounds, used in g1t's emails
- `g1t-logo-on-dark.svg`, `g1t-logo-on-dark.png` (300×140): the wordmark for dark backgrounds

## Social cards

Every page of g1t.sh and docs.g1t.sh links to its own card at `https://og.g1t.sh`,
drawn by `services/og` in the same colours, type and pixels: the wordmark and
the page's address along the top, its subject in the middle, its facts along
the bottom, the pixel 1 standing large and faded off the right edge.

There is no static social card. The brand card, the one for g1t.sh itself
and for any page without a card of its own, is `https://og.g1t.sh/image?path=%2F`,
with the lockup and the line "Where people and agents ship software
together." When a card cannot be drawn, og draws the brand card instead.

Every card's address carries the render version in its `v` parameter
(`OG_RENDER_VERSION` in `packages/contracts/src/og.ts`), which is also part
of og's cache key. Bump it in the same change as any change to the cards'
design, the logo or the brand line: otherwise og, browsers and every site
that has fetched a card keep showing the old one.
