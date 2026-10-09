/**
 * What a card may hold. Pure, so it is tested apart from the service.
 */
import type { CardAction, MessageCard } from "@g1t/contracts";

/** A card as kept, or null when what was sent is not one. */
export function cleanCard(card: unknown): MessageCard | null {
  if (!card || typeof card !== "object") return null;
  const c = card as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const kind = text(c.kind, 40);
  const title = text(c.title, 300);
  if (!kind || !title) return null;
  const href = text(c.href, 2000);
  const local = (value: string | null) => (value && value.startsWith("/") && !value.startsWith("//") ? value : null);
  const owner = c.owner === "agents" ? "agents" : null;
  const fields = Array.isArray(c.fields)
    ? c.fields
        .map((f) => (f && typeof f === "object" ? { label: text((f as Record<string, unknown>).label, 40), value: text((f as Record<string, unknown>).value, 200) } : null))
        .filter((f): f is { label: string; value: string } => !!f?.label && !!f.value)
        .slice(0, 8)
    : [];
  const actions = Array.isArray(c.actions)
    ? c.actions
        .map((raw) => {
          if (!raw || typeof raw !== "object") return null;
          const a = raw as Record<string, unknown>;
          const id = text(a.id, 40);
          const label = text(a.label, 40);
          if (!id || !label || !/^[a-z0-9_-]+$/.test(id)) return null;
          // A link that leaves the site is dropped, not turned into an action.
          const rawHref = text(a.href, 2000);
          if (rawHref && !local(rawHref)) return null;
          const input = a.input && typeof a.input === "object" ? (a.input as Record<string, unknown>) : null;
          return {
            id,
            label,
            style: a.style === "primary" || a.style === "danger" ? a.style : "default",
            confirm: text(a.confirm, 200),
            input:
              input && (input.kind === "money" || input.kind === "text")
                ? { kind: input.kind, label: text(input.label, 60) ?? "", placeholder: text(input.placeholder, 80), initial: text(input.initial, 80) }
                : null,
            href: local(rawHref),
          } as CardAction;
        })
        .filter((a): a is CardAction => !!a)
        // Actions other than links need an owner to answer them.
        .filter((a) => !!a.href || !!owner)
        .slice(0, 5)
    : [];
  return {
    kind,
    title,
    detail: text(c.detail, 500),
    state: text(c.state, 80),
    // Relative to the site only: a card never links somewhere else.
    href: local(href),
    ...(text(c.body, 4000) ? { body: text(c.body, 4000) } : {}),
    ...(fields.length ? { fields } : {}),
    ...(actions.length ? { actions } : {}),
    ...(owner ? { owner, ref: text(c.ref, 100) } : {}),
  };
}
