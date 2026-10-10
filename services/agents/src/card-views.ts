/**
 * How agents' cards look, and what they offer, by state: pure, so it is
 * tested on its own (cards.ts acts on them, sessions.ts posts them).
 */
import type { AbilityLevel, MessageCard } from "@g1t/contracts";

import { ABILITY_LEVEL_LABELS } from "../../../packages/contracts/src/abilities.ts";
import type { AbilityRequestRow } from "./abilities.ts";
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

/**
 * An Ask-first card (docs.g1t.sh/guides/agent-abilities/, "Ask first"):
 * what the agent wants to do, for whom, under which rule, with Allow and
 * Deny; then what came of it.
 */
export function abilityCard(
  request: Pick<AbilityRequestRow, "id" | "summary" | "status" | "decided_by" | "result" | "ability">,
  about: { agent: string; asker: string | null; rule: string; level: AbilityLevel; note: string | null; body: string | null },
): MessageCard {
  const who = about.asker ? `@${about.asker}` : "the person who asked";
  const fields = [
    { label: "Ability", value: about.rule },
    { label: "Rule", value: ABILITY_LEVEL_LABELS[about.level] },
  ];
  const base = { kind: "ability", title: request.summary, href: null, fields, owner: "agents" as const, ref: request.id };
  switch (request.status) {
    case "allowed":
      return { ...base, detail: `Allowed by @${request.decided_by ?? "someone"}. ${request.result ?? ""}`.trim(), state: "Done", body: about.body };
    case "failed":
      return { ...base, detail: `Allowed by @${request.decided_by ?? "someone"}, but it didn't work: ${request.result ?? "no reason given"}`, state: "Failed", body: about.body };
    case "denied":
      return { ...base, detail: `Denied by @${request.decided_by ?? "someone"}.`, state: "Denied" };
    default:
      return {
        ...base,
        detail: `${about.agent} wants to do this for ${who}.${about.note ? ` ${about.note}` : ""} Allowing runs it as you.`,
        state: "Waiting",
        body: about.body,
        actions: [
          { id: "allow", label: "Allow", style: "primary" },
          { id: "deny", label: "Deny" },
        ],
      };
  }
}

/** A Connect card: the ability runs on the asking person's own connection, which they haven't made. One press opens its setup. */
export function connectCard(about: { connector: string; agent: string; ability: string; asker: string | null; href: string }): MessageCard {
  return {
    kind: "connect",
    title: `Connect ${about.connector} to let ${about.agent} ${about.ability.toLowerCase()} for you`,
    detail: `Runs on ${about.asker ? `@${about.asker}'s` : "your"} own ${about.connector} connection, which isn't set up yet.`,
    state: "Not connected",
    href: null,
    body: `${about.ability} in ${about.connector} uses your own account there, not the workspace's. Connect it, then ask ${about.agent} again.`,
    actions: [{ id: "connect", label: `Connect ${about.connector}`, style: "primary", href: about.href }],
    owner: null,
    ref: null,
  };
}

/**
 * A Request card: the agent lacks something, said plainly, with one press
 * to ask the workspace's owners (an integration to connect, through the
 * Marketplace's requests; an ability to allow, through a notification).
 * An owner gets a link to do it instead.
 */
export function requestCard(about: {
  agent: { id: string; handle: string; display_name: string };
  workspace: string;
  connector: { id: string; name: string; available: boolean } | null;
  ability: { id: string; label: string } | null;
  why: string;
  status: "open" | "asked" | "done";
  by: string | null;
}): MessageCard {
  const need = about.ability ? about.ability.label : (about.connector?.name ?? "something");
  const ref = about.ability ? `ability:${about.agent.id}:${about.ability.id}` : `connector:${about.agent.id}:${about.connector?.id ?? ""}`;
  const href = about.ability ? `/${about.workspace}/-/agents/${about.agent.handle}/abilities` : `/${about.workspace}/-/marketplace/integrations/${about.connector?.id ?? ""}`;
  const title = about.ability ? `${about.agent.display_name} needs an ability: ${need}` : `${about.agent.display_name} needs ${need} connected`;
  if (about.status === "asked") {
    return { kind: "request", title, detail: `${about.by ? `@${about.by}` : "Someone"} asked the workspace's owners.`, state: "Asked", href: null, fields: [{ label: "Why", value: about.why }], actions: [{ id: "open", label: "Open", href }], owner: "agents", ref };
  }
  if (about.connector && !about.connector.available) {
    return { kind: "request", title, detail: `${about.connector.name} can't be connected to a workspace yet.`, state: "Coming", href: null, fields: [{ label: "Why", value: about.why }], owner: null, ref: null };
  }
  return {
    kind: "request",
    title,
    detail: about.ability ? `${about.agent.display_name} isn't allowed to ${about.ability.label.toLowerCase()}.` : `${about.connector?.name} isn't connected to this workspace.`,
    state: "Needed",
    href: null,
    body: about.ability ? `An owner changes that on ${about.agent.display_name}'s Abilities tab. Anyone else can ask them here.` : `An owner connects ${about.connector?.name} from the Marketplace. Anyone else can ask them here.`,
    fields: [{ label: "Why", value: about.why }],
    actions: [
      { id: "ask", label: "Ask the owners", style: "primary" },
      { id: "open", label: about.ability ? "Open Abilities" : "Open in Marketplace", href },
    ],
    owner: "agents",
    ref,
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

