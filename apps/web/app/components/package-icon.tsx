import { Boxes, Container, Feather, Gem, Layers, Package } from "lucide-react";

import type { Ecosystem } from "@g1t/contracts";

import { cn } from "../lib/cn";

/** Each registry's colour, as its own tools use it, so a list reads at a glance. */
const TINT: Record<Ecosystem, string> = {
  container: "#2496ed",
  npm: "#cb3837",
  composer: "#c08a5b",
  go: "#00add8",
  cargo: "#dea584",
  maven: "#e8762b",
  nuget: "#3d8fd6",
  rubygems: "#e9573f",
};

/** A small tile marking which registry a package is in. */
export function PackageIcon({ ecosystem, size = 28, className }: { ecosystem: Ecosystem; size?: number; className?: string }) {
  const tint = TINT[ecosystem];
  const glyph = Math.round(size * 0.55);
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center rounded-md font-bold", className)}
      style={{ width: size, height: size, color: tint, background: `color-mix(in oklab, ${tint} 16%, transparent)` }}
    >
      {ecosystem === "container" && <Container size={glyph} />}
      {ecosystem === "composer" && <Layers size={glyph} />}
      {ecosystem === "cargo" && <Package size={glyph} />}
      {ecosystem === "maven" && <Feather size={glyph} />}
      {ecosystem === "nuget" && <Boxes size={glyph} />}
      {ecosystem === "rubygems" && <Gem size={glyph} />}
      {ecosystem === "npm" && <span style={{ fontSize: glyph }}>n</span>}
      {ecosystem === "go" && <span style={{ fontSize: Math.round(size * 0.38) }}>GO</span>}
    </span>
  );
}
