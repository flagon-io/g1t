/**
 * A trace's spans in the order a waterfall shows them: each span under
 * its parent, children by start time. A span whose parent never arrived
 * (sent by software that does not report here, or lost) starts a root of
 * its own, so nothing is hidden.
 */
import type { TelemetrySpan } from "@g1t/contracts";

export function spanTree(spans: TelemetrySpan[]): { span: TelemetrySpan; depth: number }[] {
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string | null, TelemetrySpan[]>();
  for (const s of spans) {
    const parent = s.parent_span_id && ids.has(s.parent_span_id) && s.parent_span_id !== s.span_id ? s.parent_span_id : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  for (const list of children.values()) list.sort((a, b) => a.start_us - b.start_us);
  const out: { span: TelemetrySpan; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const s of children.get(parent) ?? []) {
      if (seen.has(s.span_id)) continue;
      seen.add(s.span_id);
      out.push({ span: s, depth });
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);
  // Spans in a loop of parents, which no root reaches.
  for (const s of spans) if (!seen.has(s.span_id)) out.push({ span: s, depth: 0 });
  return out;
}
