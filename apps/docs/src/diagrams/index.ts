/**
 * Every diagram in the docs, by the name a page gives <Diagram name="...">.
 * Each file holds the diagrams of one part of the docs.
 */
import type { Spec } from './engine.ts';
import { ARCHITECTURE } from './architecture.ts';

export const DIAGRAMS: Record<string, Spec> = {
	...ARCHITECTURE,
};
