/**
 * The brand, as SVG for satori: the Fleet mark and the "g1t" wordmark, the
 * same shapes as `.g1t/brand/svg/logo.svg`. The wordmark is outlined, so
 * the card needs no ExtraBold font.
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

/** The mark's shapes, in its 32-unit box. */
function markShapes(front: string, behind: string): string {
  return (
    `<g transform="translate(0.7 0.5)">` +
    `<rect x="6.2" y="9.5" width="4.4" height="17" rx="2.2" fill="${behind}" fill-opacity="0.35"/>` +
    `<rect x="12.4" y="7" width="4.8" height="19.5" rx="2.4" fill="${behind}" fill-opacity="0.65"/>` +
    `<rect x="19" y="4.5" width="5.4" height="22" rx="2.7" fill="${front}"/>` +
    `<path d="M21.7 7.2 17.6 10.9" fill="none" stroke="${front}" stroke-width="4.6" stroke-linecap="round"/>` +
    `</g>`
  );
}

const WORDMARK =
  "M30.42 21.29Q22.8 21.29 17.5 19.26Q12.21 17.24 9.16 13.67Q6.1 10.11 5.22 5.42L20.75 4.1Q21.19 5.66 22.46 6.86Q23.73 8.06 25.71 8.74Q27.69 9.42 30.37 9.42Q35.3 9.42 37.89 6.93Q40.48 4.44 40.48 -0.59V-9.28H39.89Q38.72 -6.54 36.65 -4.57Q34.57 -2.59 31.67 -1.56Q28.76 -0.54 25.1 -0.54Q18.7 -0.54 13.7 -3.64Q8.69 -6.74 5.83 -12.6Q2.98 -18.46 2.98 -26.76Q2.98 -35.3 5.91 -41.36Q8.84 -47.41 13.82 -50.63Q18.8 -53.86 25 -53.86Q28.81 -53.86 31.71 -52.66Q34.62 -51.46 36.77 -49.41Q38.92 -47.36 40.23 -44.73H40.48V-52.93H57.23V-2.1Q57.23 5.91 53.91 11.08Q50.59 16.26 44.56 18.77Q38.53 21.29 30.42 21.29ZM30.32 -13.38Q33.54 -13.38 35.89 -15.01Q38.23 -16.65 39.53 -19.7Q40.82 -22.75 40.82 -26.95Q40.82 -31.15 39.53 -34.23Q38.23 -37.3 35.89 -38.99Q33.54 -40.67 30.32 -40.67Q27.15 -40.67 24.88 -38.99Q22.61 -37.3 21.41 -34.23Q20.21 -31.15 20.21 -26.95Q20.21 -22.71 21.41 -19.65Q22.61 -16.6 24.88 -14.99Q27.15 -13.38 30.32 -13.38ZM94.12 -72.75V0H77.08V-57.37H76.84L60.33 -46.53V-61.57L77.47 -72.75ZM130.48 -52.93V-40.09H95.18V-52.93ZM103.28 -66.5H120.22V-17.04Q120.22 -14.75 121.23 -13.75Q122.23 -12.74 124.81 -12.74Q125.89 -12.74 127.62 -12.84Q129.36 -12.94 130.14 -13.04L131.11 -0.29Q129.11 0.1 126.43 0.22Q123.74 0.34 121.1 0.34Q112.07 0.34 107.68 -3.42Q103.28 -7.18 103.28 -14.79Z";

/**
 * The lockup: the mark as tall as the wordmark's capitals, standing on its
 * baseline. Its box is 233 by 95; the baseline is at 72.75.
 */
export const LOCKUP_BOX = { width: 233, height: 95, baseline: 72.75 } as const;

export function lockupSvg(front: string = COLOR.fg, behind: string = COLOR.lavender): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOCKUP_BOX.width} ${LOCKUP_BOX.height}">` +
    `<g transform="translate(-22.77 -16.35) scale(3.3)">${markShapes(front, behind)}</g>` +
    `<path transform="translate(101.08 72.75)" fill="${front}" d="${WORDMARK}"/>` +
    `</svg>`
  );
}

/** The mark alone, cropped to the figure: 18.2 by 22. */
export function markSvg(front: string = COLOR.fg, behind: string = COLOR.lavender): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6.9 5 18.2 22">${markShapes(front, behind)}</svg>`
  );
}

/** As an image source; base64, which both satori and resvg read. The SVG is ASCII. */
/**
 * The card's backdrop: the brand card's dot grid, lavender light from the
 * top right, and the fleet standing large off the right edge, its 1s
 * fading downwards into the dark. Darker towards the bottom, where the
 * facts sit.
 */
export function backdropSvg(width: number, height: number, withFleet: boolean): string {
  // The fleet at 24 times its 32-unit size, its front 1 cut by the edge.
  const scale = 24;
  // Drawn solid and faded as a whole, so the flag and the bar it joins
  // read as one shape.
  const fleet = withFleet
    ? `<g mask="url(#fleetFade)" opacity="0.34">` +
      `<g transform="translate(${width - 22.4 * scale} ${height - 27.5 * scale + 40}) scale(${scale})">` +
      markShapes(COLOR.lavender, COLOR.lavender) +
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
    `<mask id="fleetFade" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="url(#fadeMask)"/></mask>` +
    `</defs>` +
    `<rect width="${width}" height="${height}" fill="${COLOR.bg}"/>` +
    `<rect width="${width}" height="${height}" fill="url(#dots)"/>` +
    `<rect width="${width}" height="${height}" fill="url(#light)"/>` +
    fleet +
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
