/**
 * The brand, as SVG for satori: G1T in 5×7 pixel capitals, the 1 in
 * lavender, the same shapes as `.g1t/brand/svg/logo.svg`. Pixels need no
 * font.
 */

export const COLOR = {
  bg: "#0f0f11",
  surface: "#161618",
  raised: "#1e1e21",
  line: "#28282c",
  lineStrong: "#38383e",
  fg: "#ededef",
  fgSoft: "#dcdce0",
  muted: "#a0a0a8",
  faint: "#6a6a72",
  /** Lavender: the accent. */
  lavender: "#b6a8ff",
  lavenderDeep: "#6b56e8",
  /** Status colours, from the site's tokens. */
  mint: "#86efc4",
  danger: "#ff8394",
} as const;

const G = [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."];
const ONE = ["..#..", ".##..", "#.#..", "..#..", "..#..", "..#..", "#####"];
const T = ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."];

type Pixel = { x: number; y: number; one: boolean };

function pixels(rows: string[], dx: number, one: boolean): Pixel[] {
  return rows.flatMap((row, y) => [...row].flatMap((c, x) => (c === "#" ? [{ x: dx + x, y, one }] : [])));
}

/** G at 0, the 1 at 6, the T at 10, its bar tucked in over the 1's foot. */
const WORD = [...pixels(G, 0, false), ...pixels(ONE, 6, true), ...pixels(T, 10, false)];
const THE_ONE = pixels(ONE, 0, true);

/** Pixels on cells of 10 units, each a square of 8, centred. */
function pixelShapes(of: Pixel[], ink: string, accent: string): string {
  return of
    .map((p) => `<rect x="${p.x * 10 + 1}" y="${p.y * 10 + 1}" width="8" height="8" fill="${p.one ? accent : ink}"/>`)
    .join("");
}

/**
 * The wordmark, cropped to its ink: 148 by 68, standing on its baseline,
 * which is its bottom edge.
 */
export const LOCKUP_BOX = { width: 148, height: 68, baseline: 68 } as const;

export function lockupSvg(ink: string = COLOR.fg, accent: string = COLOR.lavender): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 1 ${LOCKUP_BOX.width} ${LOCKUP_BOX.height}">` +
    pixelShapes(WORD, ink, accent) +
    `</svg>`
  );
}

/** The icon alone, the pixel 1, cropped to its ink: 48 by 68. */
export function markSvg(accent: string = COLOR.lavender): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1 1 48 68">${pixelShapes(THE_ONE, accent, accent)}</svg>`;
}

/** As an image source; base64, which both satori and resvg read. The SVG is ASCII. */
/**
 * The card's backdrop: the brand card's dot grid, lavender light from the
 * top right, and the pixel 1 standing large off the right edge, fading
 * downwards into the dark. Darker towards the bottom, where the facts sit.
 */
export function backdropSvg(width: number, height: number, withOne: boolean): string {
  // The 1 on 90px cells, its stem cut by the right edge and its foot by the
  // bottom; its flag starts below the address in the top right.
  const cell = 90;
  const one = withOne
    ? `<g mask="url(#oneFade)" opacity="0.34">` +
      `<g transform="translate(${width - 2.75 * cell} ${height - 6.3 * cell}) scale(${cell / 10})">` +
      pixelShapes(THE_ONE, COLOR.lavender, COLOR.lavender) +
      `</g></g>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>` +
    `<pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">` +
    `<circle cx="20" cy="15" r="1.4" fill="#2a2a30"/></pattern>` +
    `<radialGradient id="light" cx="${width - 160}" cy="-40" r="760" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="${COLOR.lavenderDeep}" stop-opacity="0.30"/>` +
    `<stop offset="0.45" stop-color="${COLOR.lavenderDeep}" stop-opacity="0.09"/>` +
    `<stop offset="1" stop-color="${COLOR.lavenderDeep}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0.5" stop-color="${COLOR.bg}" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="${COLOR.bg}" stop-opacity="0.9"/></linearGradient>` +
    `<linearGradient id="fadeMask" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0.1" stop-color="#fff"/>` +
    `<stop offset="0.95" stop-color="#000"/></linearGradient>` +
    `<mask id="oneFade" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="url(#fadeMask)"/></mask>` +
    `</defs>` +
    `<rect width="${width}" height="${height}" fill="${COLOR.bg}"/>` +
    `<rect width="${width}" height="${height}" fill="url(#dots)"/>` +
    `<rect width="${width}" height="${height}" fill="url(#light)"/>` +
    one +
    `<rect width="${width}" height="${height}" fill="url(#dusk)"/>` +
    `</svg>`
  );
}

export function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

/** Lucide's icons, as the site uses them, at 24 units. */
export const ICON = {
  issue: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>`,
  issueDone: `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`,
  issueNotPlanned: `<circle cx="12" cy="12" r="10"/><line x1="9" x2="15" y1="15" y2="9"/>`,
  pull: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  pullDraft: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 6V5"/><path d="M18 11v-1"/><line x1="6" x2="6" y1="9" y2="21"/>`,
  merged: `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
  pullClosed: `<circle cx="6" cy="6" r="3"/><path d="M6 9v12"/><path d="m21 3-6 6"/><path d="m21 9-6-6"/><path d="M18 11.5V15"/><circle cx="18" cy="18" r="3"/>`,
  box: `<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
  sparkles: `<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>`,
  book: `<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>`,
  user: `<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>`,
  globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
} as const;

export function iconSvg(shapes: string, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`
  );
}
