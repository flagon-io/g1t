/**
 * Agents know their teammates (docs.g1t.sh/guides/people-and-teams/,
 * "What agents are told"): every turn, an agent is told the visible teams
 * it is on, from the team pages: who leads each, who is on it and what
 * they own, who reports to whom, who is around now, and who to page when
 * a person is needed. It also carries the teams' budgets, which cap what
 * the team's agents spend together in a month.
 *
 * `teamsSection` and `teamBudgetBlock` are pure, so they are tested on
 * their own (teammates.test.ts); `loadTeams` (ports.ts) reads identity,
 * the presence rooms (notify) and this service's own agents.
 */
import type { AgentTeam, PresenceEntry } from "@g1t/contracts";

import { dollars } from "./money.ts";

/** An agent as its teammates are told of it. */
export type TeamAgentInfo = { id: string; handle: string; display_name: string; title: string };

/** Everything about an agent's teams that one turn needs. */
export type TeamsHere = {
  teams: AgentTeam[];
  /** Every agent on those teams, by id. */
  agents: TeamAgentInfo[];
  /** How the people on those teams show now; someone missing is offline. */
  presence: PresenceEntry[];
};

/** The agents on `team`, by id: its members, as the team page adds them. */
export function agentIdsOn(team: AgentTeam): string[] {
  return [...new Set(team.agent_ids)];
}

/** "QA", "QA and Web", "QA, Web and Support". */
export function listOf(names: readonly string[]): string {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "18:12", their local time, or null when the zone isn't one. */
export function localTime(zone: string | null, now: Date): string | null {
  if (!zone) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  } catch {
    return null;
  }
}

/** How someone shows now, in a few words; null when presence wasn't read. */
export function showing(entry: PresenceEntry | null | undefined, zone: string | null, now: Date, known: boolean): string | null {
  if (!known) return null;
  if (!entry || entry.presence === "offline") return "offline";
  const parts: string[] = [];
  const dnd = entry.dnd_until && Date.parse(entry.dnd_until) > now.getTime() ? entry.dnd_until : null;
  if (dnd) {
    const until = localTime(zone, new Date(dnd));
    parts.push(`focusing in Do Not Disturb${until ? ` until ${until} their time` : ""}`);
  } else {
    parts.push(entry.presence === "active" ? "online" : "away");
  }
  if (entry.status?.text) parts.push(`status "${[entry.status.emoji, entry.status.text].filter(Boolean).join(" ")}"`);
  return parts.join("; ");
}

/** Whether someone can be reached now: online and not in Do Not Disturb. */
function reachable(entry: PresenceEntry | null | undefined, now: Date): boolean {
  if (!entry || entry.presence !== "active") return false;
  return !(entry.dnd_until && Date.parse(entry.dnd_until) > now.getTime());
}

function personLabel(person: { username: string; name: string | null }): string {
  return person.name && person.name.toLowerCase() !== person.username.toLowerCase() ? `${person.name} (@${person.username})` : `@${person.username}`;
}

/**
 * Who to page on a team when a person is needed: its lead when they can
 * be reached, else a maintainer, else anyone on it who can. Null when
 * no one can, or presence wasn't read.
 */
export function whoToPage(team: AgentTeam, presence: Map<string, PresenceEntry>, now: Date, known: boolean): AgentTeam["people"][number] | null {
  if (!known) return null;
  const lead = team.lead?.kind === "user" ? team.people.find((p) => p.username === (team.lead as { username: string }).username) : undefined;
  const order = [...(lead ? [lead] : []), ...team.people.filter((p) => p.maintainer && p !== lead), ...team.people.filter((p) => !p.maintainer && p !== lead)];
  return order.find((p) => reachable(presence.get(p.user_id), now)) ?? null;
}

/** "Your teams", for the system prompt; null when the agent is on none. */
export function teamsSection(selfId: string, here: TeamsHere | null, now: Date): string | null {
  if (!here || !here.teams.length) return null;
  const known = here.presence.length > 0;
  const presence = new Map(here.presence.map((entry) => [entry.user_id, entry]));
  const byId = new Map(here.agents.map((agent) => [agent.id, agent]));
  const blocks = here.teams.map((team) => {
    const agentIds = agentIdsOn(team);
    const agents = agentIds.map((id) => byId.get(id)).filter((a): a is TeamAgentInfo => !!a);
    const facts: string[] = [];
    if (team.description) facts.push(team.description.replace(/\s+/g, " ").trim().replace(/\.?$/, "."));
    if (team.lead?.kind === "user") {
      const username = team.lead.username;
      const lead = team.people.find((p) => p.username === username);
      facts.push(`Led by ${lead ? personLabel(lead) : `@${username}`}.`);
    } else if (team.lead?.kind === "agent") {
      const id = team.lead.agent_id;
      const lead = byId.get(id);
      facts.push(id === selfId ? "You lead it." : lead ? `Led by @${lead.handle}, an agent.` : "Led by an agent.");
    }
    if (team.channel) facts.push(`Its channel is #${team.channel.name}.`);
    if (team.budget_micros) facts.push(`Its agents share a budget of ${dollars(team.budget_micros)} a month.`);
    const lines = team.people.map((person) => {
      const bits = [personLabel(person)];
      const role = [person.title, team.lead?.kind === "user" && team.lead.username === person.username ? "the lead" : null, person.maintainer ? "a maintainer" : null].filter(Boolean);
      if (role.length) bits.push(role.join(", "));
      if (person.owns.length) bits.push(`owns ${person.owns.join(", ")}`);
      if (person.manager) bits.push(`reports to @${person.manager}`);
      const shows = showing(presence.get(person.user_id), person.timezone, now, known);
      const time = localTime(person.timezone, now);
      const now_ = [shows, time ? `it's ${time} for them` : null].filter(Boolean).join("; ");
      return `- ${bits.join("; ")}${now_ ? ` (${now_})` : ""}`;
    });
    for (const agent of agents) {
      lines.push(agent.id === selfId ? `- @${agent.handle}: you` : `- @${agent.handle} (${agent.display_name}), an agent${agent.title ? `: ${agent.title}` : ""}`);
    }
    if (!lines.length) lines.push("- No one else yet.");
    const page = whoToPage(team, presence, now, known);
    const pageLine = !known
      ? null
      : page
        ? `When a person is needed: ${personLabel(page)}, who is online now.`
        : team.people.length
          ? `No one on ${team.name} can be reached now; ${team.channel ? `post in #${team.channel.name} and ` : ""}say they'll see it when they're back.`
          : null;
    return [`### ${team.name}`, "", ...(facts.length ? [facts.join(" "), ""] : []), ...lines, ...(pageLine ? ["", pageLine] : [])].join("\n");
  });
  return [
    "## Your teams",
    "",
    "From your teams' pages, and how people show right now. Use it to know who leads, who owns what and who to ask or hand work to. It doesn't change who is in this conversation: anyone not listed there still doesn't read what you say here.",
    "",
    "- Ask the person who owns something before guessing. Hold non-urgent questions for someone focusing or away, and say so.",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** One team's month so far: its budget and what its agents spent together. */
export type TeamSpend = { name: string; budget_micros: number; spent_micros: number };

/** Why work may not start: a team the agent is on has used its budget for the month. Null when it may. */
export function teamBudgetBlock(spends: readonly TeamSpend[]): string | null {
  const over = spends.find((team) => team.budget_micros > 0 && team.spent_micros >= team.budget_micros);
  if (!over) return null;
  return `${over.name}'s agents have used the team's budget of ${dollars(over.budget_micros)} for this month. Someone who manages the team can raise it on its settings.`;
}

/** Each team with a budget, with what its agents spent this month (`month` is `YYYY-MM`). */
export async function teamSpends(db: D1Database, here: TeamsHere, month: string): Promise<TeamSpend[]> {
  const budgeted = here.teams.filter((team) => team.budget_micros && team.budget_micros > 0);
  return Promise.all(
    budgeted.map(async (team) => {
      const ids = agentIdsOn(team);
      const row = await db
        .prepare("SELECT COALESCE(SUM(micros), 0) AS micros FROM agent_spend WHERE period = ?1 AND agent_id IN (SELECT value FROM json_each(?2))")
        .bind(month, JSON.stringify(ids))
        .first<{ micros: number | null }>();
      return { name: team.name, budget_micros: team.budget_micros!, spent_micros: row?.micros ?? 0 };
    }),
  );
}
