// Draws the app's icons from the g1t mark (packages/theme/mark.svg):
// `npm run icons -w @g1t/mobile` after the mark or the background changes.
//
// - icon.png: the store and iOS icon, the mark on g1t's background.
// - android-icon-foreground.png: the adaptive icon's mark, inside the
//   middle 66% Android keeps whatever the launcher's mask.
// - android-icon-monochrome.png: the same in white, for themed icons.
// - splash-icon.png: the mark alone, on the splash screen's background.
// - notification-icon.png: the mark in white on nothing, as Android draws
//   a notification's small icon (tinted with the accent).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const mark = await readFile(here("../../../packages/theme/mark.svg"), "utf8");
const BACKGROUND = "#0f0f11";

/** The mark at `scale` of a `size` square, recoloured, on `background` or nothing. */
async function draw(file, { size, scale, color, background }) {
  const inner = Math.round(size * scale);
  const svg = Buffer.from(mark.replace(/#b6a8ff/g, color ?? "#b6a8ff").replace("<svg ", `<svg width="${inner}" height="${inner}" `));
  const glyph = await sharp(svg, { density: 72 * (inner / 80) }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, gravity: "centre" }])
    .png()
    .toFile(here(`../assets/images/${file}`));
}

await draw("icon.png", { size: 1024, scale: 0.62, background: BACKGROUND });
await draw("android-icon-foreground.png", { size: 1024, scale: 0.46 });
await draw("android-icon-monochrome.png", { size: 1024, scale: 0.46, color: "#ffffff" });
await draw("splash-icon.png", { size: 512, scale: 0.9 });
await draw("notification-icon.png", { size: 96, scale: 0.8, color: "#ffffff" });
console.log("Drew icon.png, android-icon-foreground.png, android-icon-monochrome.png, splash-icon.png and notification-icon.png.");
