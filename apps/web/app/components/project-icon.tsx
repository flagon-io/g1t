import { AppWindow, BookOpen, Box, Library, Lock, SquareTerminal } from "lucide-react";

import type { ProjectKind } from "@g1t/contracts";

/** Each kind's glyph, so a list says what each project is at a glance. */
const GLYPH: Record<ProjectKind, typeof Box> = {
  app: AppWindow,
  library: Library,
  tool: SquareTerminal,
  docs: BookOpen,
  other: Box,
};

/**
 * What a project is, as an icon: an app or site, a library, a tool, docs, or
 * a box for anything else or a kind not known. `lockPrivate` shows a lock
 * instead for a private one, where nothing else on the row says so.
 */
export function ProjectIcon({ kind, isPrivate, lockPrivate, size }: { kind?: ProjectKind | null; isPrivate?: boolean; lockPrivate?: boolean; size?: number }) {
  if (isPrivate && lockPrivate) return <Lock size={size} />;
  const Glyph = (kind && GLYPH[kind]) || Box;
  return <Glyph size={size} />;
}
