/**
 * Turns a card into a PNG: satori lays it out as SVG, with the text as
 * outlines, and resvg rasterises that. Both run as WebAssembly, which the
 * caller hands in: as modules in the Worker, as bytes in Node.
 */
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import satori, { init as initYoga, type Font } from "satori/standalone";

import { HEIGHT, WIDTH, cardTree } from "./card.ts";
import type { Card } from "./resolve.ts";

export type Assets = {
  yoga: WebAssembly.Module | ArrayBuffer | Uint8Array;
  resvg: WebAssembly.Module | ArrayBuffer | Uint8Array;
  fonts: Font[];
};

let ready: Promise<void> | null = null;

function start(assets: Assets): Promise<void> {
  ready ??= Promise.all([initYoga(assets.yoga), initWasm(assets.resvg)]).then(
    () => undefined,
    (error) => {
      ready = null;
      throw error;
    },
  );
  return ready;
}

/** The card as SVG, for tests and for looking at without rasterising. */
export async function cardSvg(card: Card, assets: Assets): Promise<string> {
  await start(assets);
  // Satori takes React elements; the tree is the same shape without React.
  return satori(cardTree(card) as unknown as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: assets.fonts,
  });
}

export async function cardPng(card: Card, assets: Assets): Promise<Uint8Array> {
  const svg = await cardSvg(card, assets);
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH }, font: { loadSystemFonts: false } });
  try {
    return resvg.render().asPng();
  } finally {
    resvg.free();
  }
}
