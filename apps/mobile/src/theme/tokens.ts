/**
 * g1t's colours, as packages/theme/tokens.css names them, for React
 * Native, which cannot read CSS variables. Keep the two in step: a colour
 * changed there changes here.
 *
 * Dark is g1t's default, as on the site; light follows the phone's setting.
 */

export type Palette = {
  bg: string;
  surface: string;
  raised: string;
  line: string;
  lineStrong: string;
  fg: string;
  fgSoft: string;
  muted: string;
  faint: string;
  accent: string;
  accentDim: string;
  accentLow: string;
  /** Text on an accent-filled button. */
  onAccent: string;
  /** The rail and the bottom bar (apps/web app.css `--color-rail`). */
  rail: string;
  /** What marks the app you are in on the rail (`--color-sidebar-accent`). */
  railAccent: string;
  success: string;
  successLow: string;
  info: string;
  merged: string;
  warn: string;
  danger: string;
};

export const dark: Palette = {
  bg: "#0f0f11",
  surface: "#161618",
  raised: "#1e1e21",
  line: "#28282c",
  lineStrong: "#38383e",
  fg: "#ededef",
  fgSoft: "#dcdce0",
  muted: "#a0a0a8",
  faint: "#86868e",
  accent: "#b6a8ff",
  accentDim: "#8577e0",
  accentLow: "#221e38",
  onAccent: "#0f0f11",
  rail: "#050507",
  railAccent: "#1c1c20",
  success: "#86efc4",
  successLow: "#10302a",
  info: "#8ab4ff",
  merged: "#a678f5",
  warn: "#ffbd8c",
  danger: "#ff8394",
};

export const light: Palette = {
  bg: "#fbfbfa",
  surface: "#ffffff",
  raised: "#f1f1ef",
  line: "#e4e4e1",
  lineStrong: "#d2d2ce",
  fg: "#18181b",
  fgSoft: "#2e2e33",
  muted: "#5c5c66",
  faint: "#686871",
  accent: "#6b52c8",
  accentDim: "#9584dc",
  accentLow: "#ece8fb",
  onAccent: "#ffffff",
  rail: "#ffffff",
  railAccent: "#e1e1de",
  success: "#0d7a52",
  successLow: "#e2f4ec",
  info: "#2160cc",
  merged: "#7c3fd1",
  warn: "#a84f00",
  danger: "#c42a43",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 14, full: 999 } as const;

/**
 * The site's faces (Hanken Grotesk, Bricolage Grotesque, IBM Plex Mono)
 * ship as woff2, which phones cannot load; until TTF copies are bundled
 * with expo-font, the system's faces stand in.
 */
export const fonts = { mono: "monospace" } as const;
