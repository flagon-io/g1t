/**
 * Colour in a job's log, as a terminal draws it. Tools colour their output
 * when they see `GITHUB_ACTIONS=true` (chalk, cargo, pytest and the like),
 * with SGR escape codes: bold, dim, italic, underline, the 16 colours, the
 * 256-colour palette and 24-bit colour, for text and its background. Those
 * are read into styled spans; every other escape sequence (moving the
 * cursor, clearing the line, setting the window's title) is dropped, and a
 * hyperlink (OSC 8) keeps its text. The 16 colours are theme tokens
 * (`ansi-fg-N` and `ansi-bg-N` in app.css), so they read in light and dark.
 */

/** A colour: one of the 256 of the palette, or red, green and blue. */
export type AnsiColor = { palette: number } | { rgb: [number, number, number] };

export type AnsiStyle = {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  fg?: AnsiColor;
  bg?: AnsiColor;
};

export type AnsiSpan = { text: string; style: AnsiStyle };

const ESC = "\u001b";

/** Whether `text` holds an escape sequence or another control character worth reading out. */
export function hasEscapes(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/.test(text);
}

/** `text` without its escape sequences: what a search reads and a copy takes. */
export function stripAnsi(text: string): string {
  if (!hasEscapes(text)) return text;
  return parseAnsi(text)
    .map((span) => span.text)
    .join("");
}

/**
 * A parameter in ITU's colon form as its `;` form: `38:5:n`, `38:2::r:g:b`
 * (the empty one names the colour space), and `4:3`, a curly underline,
 * as an underline.
 */
function colonForm(part: string): string[] {
  if (!part.includes(":")) return [part];
  const pieces = part.split(":");
  if ((pieces[0] === "38" || pieces[0] === "48") && pieces[1] === "2" && pieces.length >= 6) return [pieces[0], "2", ...pieces.slice(3, 6)];
  if (pieces[0] === "4") return [pieces[1] === "0" ? "24" : "4"];
  return pieces;
}

/** Reads one SGR sequence's parameters into `style`, in place. */
function applySgr(style: AnsiStyle, params: string): void {
  const codes = (params === "" ? "0" : params)
    .split(";")
    .flatMap(colonForm)
    .map((part) => (part === "" ? 0 : Number(part)));
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!;
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      for (const key of Object.keys(style) as (keyof AnsiStyle)[]) delete style[key];
    } else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4 || code === 21) style.underline = true;
    else if (code === 7) style.inverse = true;
    else if (code === 9) style.strike = true;
    else if (code === 22) {
      delete style.bold;
      delete style.dim;
    } else if (code === 23) delete style.italic;
    else if (code === 24) delete style.underline;
    else if (code === 27) delete style.inverse;
    else if (code === 29) delete style.strike;
    else if (code >= 30 && code <= 37) style.fg = { palette: code - 30 };
    else if (code === 39) delete style.fg;
    else if (code >= 40 && code <= 47) style.bg = { palette: code - 40 };
    else if (code === 49) delete style.bg;
    else if (code >= 90 && code <= 97) style.fg = { palette: code - 90 + 8 };
    else if (code >= 100 && code <= 107) style.bg = { palette: code - 100 + 8 };
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      const kind = codes[i + 1];
      if (kind === 5) {
        const n = codes[i + 2];
        if (n !== undefined && n >= 0 && n <= 255) style[key] = { palette: n };
        i += 2;
      } else if (kind === 2) {
        const [r, g, b] = [codes[i + 2], codes[i + 3], codes[i + 4]];
        if ([r, g, b].every((n) => n !== undefined && n >= 0 && n <= 255)) style[key] = { rgb: [r!, g!, b!] };
        i += 4;
      }
    }
  }
}

/**
 * One line of a log as styled spans, in order, with every escape
 * sequence read or dropped. A line starts unstyled, as each line of
 * GitHub's log does.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const style: AnsiStyle = {};
  let pending = "";
  const push = () => {
    if (!pending) return;
    const last = spans[spans.length - 1];
    if (last && sameStyle(last.style, style)) last.text += pending;
    else spans.push({ text: pending, style: { ...style } });
    pending = "";
  };
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const code = char.charCodeAt(0);
    if (char === ESC || code === 0x9b) {
      const csi = code === 0x9b || text[i + 1] === "[";
      if (csi) {
        // CSI: parameters, intermediates, then one final byte.
        let j = i + (code === 0x9b ? 1 : 2);
        const start = j;
        while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
        const params = text.slice(start, j);
        while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
        const final = text[j];
        if (final === "m" && /^[\d;:]*$/.test(params)) {
          push();
          applySgr(style, params);
        }
        i = final === undefined ? j : j + 1;
        continue;
      }
      const next = text[i + 1];
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        // OSC and the other strings: to BEL or ESC \. An OSC 8 hyperlink
        // is two of these around its text, which stays.
        let j = i + 2;
        while (j < text.length && text[j] !== "\u0007" && !(text[j] === ESC && text[j + 1] === "\\")) j++;
        i = j >= text.length ? j : text[j] === "\u0007" ? j + 1 : j + 2;
        continue;
      }
      // ESC ( B and its kin pick a character set: three characters.
      if (next !== undefined && "()*+-./#%".includes(next)) {
        i += 3;
        continue;
      }
      // Any other escape is two characters (ESC 7, ESC =, ESC M…).
      i += next === undefined ? 1 : 2;
      continue;
    }
    // Other control characters (a bell, a backspace) draw nothing; a tab stays.
    if ((code < 0x20 && char !== "\t") || code === 0x7f) {
      i++;
      continue;
    }
    pending += char;
    i++;
  }
  push();
  return spans;
}

function sameColor(a: AnsiColor | undefined, b: AnsiColor | undefined): boolean {
  if (!a || !b) return a === b;
  if ("palette" in a) return "palette" in b && a.palette === b.palette;
  return "rgb" in b && a.rgb.every((n, index) => n === b.rgb[index]);
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    !!a.inverse === !!b.inverse &&
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg)
  );
}

/** A colour of the 256-colour palette past the first 16, as red, green and blue. */
export function paletteRgb(n: number): [number, number, number] {
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return [level, level, level];
  }
  const index = n - 16;
  const step = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return [step(Math.floor(index / 36)), step(Math.floor(index / 6) % 6), step(index % 6)];
}

function cssColor(color: AnsiColor): { token: number } | { css: string } {
  if ("palette" in color) {
    if (color.palette < 16) return { token: color.palette };
    const [r, g, b] = paletteRgb(color.palette);
    return { css: `rgb(${r}, ${g}, ${b})` };
  }
  return { css: `rgb(${color.rgb.join(", ")})` };
}

/**
 * How a span draws: classes for what the theme decides (the 16 colours,
 * weight, slant, lines) and inline colours for the rest.
 */
export function spanLook(style: AnsiStyle): { className: string; style?: { color?: string; backgroundColor?: string } } {
  const classes: string[] = [];
  const inline: { color?: string; backgroundColor?: string } = {};
  const [fg, bg] = style.inverse ? [style.bg, style.fg] : [style.fg, style.bg];
  if (fg) {
    const look = cssColor(fg);
    if ("token" in look) classes.push(`ansi-fg-${look.token}`);
    else inline.color = look.css;
  } else if (style.inverse) classes.push("ansi-fg-inverse");
  if (bg) {
    const look = cssColor(bg);
    if ("token" in look) classes.push(`ansi-bg-${look.token}`);
    else inline.backgroundColor = look.css;
  } else if (style.inverse) classes.push("ansi-bg-inverse");
  if (style.bold) classes.push("font-bold");
  if (style.dim) classes.push("opacity-70");
  if (style.italic) classes.push("italic");
  if (style.underline && style.strike) classes.push("[text-decoration-line:underline_line-through]");
  else if (style.underline) classes.push("underline");
  else if (style.strike) classes.push("line-through");
  return { className: classes.join(" "), style: inline.color || inline.backgroundColor ? inline : undefined };
}

/**
 * Spans cut where `query` (any case) appears in their text taken
 * together, each piece marked as a match or not, so a search marks what
 * it found without losing the colours around it.
 */
export function markSpans(spans: AnsiSpan[], query: string): (AnsiSpan & { match: boolean })[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return spans.map((span) => ({ ...span, match: false }));
  const plain = spans.map((span) => span.text).join("");
  const lower = plain.toLowerCase();
  // Where matches start and end, in the plain text.
  const ranges: [number, number][] = [];
  for (let found = lower.indexOf(wanted); found !== -1; found = lower.indexOf(wanted, found + wanted.length)) {
    ranges.push([found, found + wanted.length]);
  }
  if (ranges.length === 0) return spans.map((span) => ({ ...span, match: false }));
  const out: (AnsiSpan & { match: boolean })[] = [];
  let at = 0;
  for (const span of spans) {
    const end = at + span.text.length;
    let cursor = at;
    while (cursor < end) {
      const inside = ranges.find(([from, to]) => cursor >= from && cursor < to);
      const nextStart = ranges.find(([from]) => from > cursor)?.[0] ?? Infinity;
      const stop = Math.min(end, inside ? inside[1] : nextStart);
      out.push({ text: plain.slice(cursor, stop), style: span.style, match: Boolean(inside) });
      cursor = stop;
    }
    at = end;
  }
  return out;
}
