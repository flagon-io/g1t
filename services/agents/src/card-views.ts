/**
 * How agents' cards look, and what they offer, by state: pure, so it is
 * tested on its own (cards.ts acts on them, sessions.ts posts them).
 */
import type { MessageCard } from "@g1t/contracts";

import type { DraftRow } from "./cards.ts";

/** A draft issue's card: what it would file, and the buttons. */
export function draftCard(draft: Pick<DraftRow, "id" | "repo" | "title" | "body" | "labels" | "status" | "filed_by" | "number">): MessageCard {
  const labels = (() => {
    try {
      return (JSON.parse(draft.labels || "[]") as string[]).join(", ");
    } catch {
      return "";
    }
  })();
  const fields = [{ label: "Repository", value: draft.repo }, ...(labels ? [{ label: "Labels", value: labels }] : [])];
  const preview = draft.body.length > 900 ? `${draft.body.slice(0, 900)}…` : draft.body;
  if (draft.status === "filed" && draft.number) {
    const href = `/${draft.repo}/issues/${draft.number}`;
    return {
      kind: "draft_issue",
      title: draft.title,
      detail: `Filed as ${draft.repo}#${draft.number}${draft.filed_by ? ` by @${draft.filed_by}` : ""}`,
      state: "Filed",
      href,
      fields,
      actions: [{ id: "open", label: "Open issue", href }],
      owner: "agents",
      ref: draft.id,
    };
  }
  if (draft.status === "discarded") {
    return { kind: "draft_issue", title: draft.title, detail: "Discarded", state: "Discarded", href: null, owner: "agents", ref: draft.id };
  }
  return {
    kind: "draft_issue",
    title: draft.title,
    detail: `A draft issue for ${draft.repo}. Filing it files it as you.`,
    state: "Draft",
    href: null,
    body: preview,
    fields,
    actions: [
      { id: "file", label: "File issue", style: "primary" },
      { id: "discard", label: "Discard" },
    ],
    owner: "agents",
    ref: draft.id,
  };
}

/** Money as people type it ("5", "$12.50") in micro-dollars, or null. */
export function parseMoney(input: string | null): number | null {
  const text = (input ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const micros = Math.round(Number(text) * 1_000_000);
  return micros > 0 ? micros : null;
}

/** What people can do on a session's card, by where it is. */
export function sessionActions(status: string, cap: number | null, spent: number, href: string): NonNullable<MessageCard["actions"]> {
  const open = { id: "open", label: "Open", href };
  const live = status === "queued" || status === "working" || status === "waiting";
  if (status === "needs_approval") {
    const suggested = Math.max(spent + 1_000_000, (cap ?? spent) * 2);
    return [
      {
        id: "approve",
        label: "Approve more",
        style: "primary",
        input: { kind: "money", label: "New cap", placeholder: "5.00", initial: (suggested / 1_000_000).toFixed(2) },
      },
      { id: "stop", label: "Stop", style: "danger", confirm: "Stop this session and everything under it?" },
      open,
    ];
  }
  if (live) {
    return [
      { id: "steer", label: "Message", input: { kind: "text", label: "Tell it", placeholder: "Also check the mobile app…" } },
      { id: "stop", label: "Stop", style: "danger", confirm: "Stop this session and everything under it?" },
      open,
    ];
  }
  // Over: carry on with a message (it picks up with its context), or read it.
  return [{ id: "steer", label: "Follow up", input: { kind: "text", label: "Ask it to", placeholder: "Now write the release note…" } }, open];
}

