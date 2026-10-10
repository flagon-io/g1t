/**
 * One call of the agent builder (builder.ts): a fast-tier model request
 * through `metered`, charged to the person who asked and recorded as a
 * builder reply, so their budget and Spend count it. Saves nothing else.
 */
import { type User, newId } from "@g1t/contracts";

import { BUILDER_ID, BUILDER_PER_HOUR, builderRow } from "./builder.ts";
import type { Definition } from "./definition.ts";
import { type MeterEnv, metered } from "./meter.ts";
import { runTurn } from "./turn.ts";

export type BuilderCall = {
  slug: string;
  workspaceId: string;
  viewer: User;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxOutput?: number;
  /** For Try it: the unsaved agent's own model limits, so it answers on what it would run on. */
  routing?: Partial<Definition["routing"]>;
};

export type BuilderResult = { ok: true; text: string; charged: number } | { ok: false; code: "invalid" | "forbidden"; message: string };

/** How many builder calls `username` made in the last hour. */
async function recentCalls(db: D1Database, workspaceId: string, username: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM agent_replies WHERE agent_id = ? AND workspace_id = ? AND asked_by_username = ? AND created_at > ?")
    .bind(BUILDER_ID, workspaceId, username, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * One builder call: checks the person's hourly allowance, asks the model
 * through `metered` (charged to them), and records it as a builder reply
 * so their budget and Spend count it. Saves nothing else.
 */
export async function callBuilder(env: MeterEnv, call: BuilderCall, now = new Date()): Promise<BuilderResult> {
  const username = call.viewer.username.toLowerCase();
  if ((await recentCalls(env.DB, call.workspaceId, username, now)) >= BUILDER_PER_HOUR) {
    return { ok: false, code: "invalid", message: `That's ${BUILDER_PER_HOUR} drafts and tries in an hour. Wait a little, or edit all fields yourself.` };
  }
  const row = builderRow(call.workspaceId, call.routing);
  const id = newId("arp", now.getTime());
  const record = (status: string, extra: { model?: string | null; tier?: string | null; input?: number; output?: number; cost?: number; charged?: number; error?: string | null }) =>
    env.DB.prepare(
      `INSERT INTO agent_replies (id, agent_id, workspace_id, channel_id, message_id, asked_by, asked_by_username, channel_name, agent_version, model, tier,
         input_tokens, output_tokens, cost_micros, charged_micros, status, error, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        BUILDER_ID,
        call.workspaceId,
        BUILDER_ID,
        id,
        call.viewer.id,
        username,
        extra.model ?? null,
        extra.tier ?? null,
        extra.input ?? 0,
        extra.output ?? 0,
        extra.cost ?? 0,
        extra.charged ?? 0,
        status,
        extra.error?.slice(0, 500) ?? null,
        now.toISOString(),
        new Date().toISOString(),
      )
      .run()
      .catch((error: unknown) => console.error("agents: a builder call was not recorded", String(error)));
  try {
    const done = await metered(env, { row, payer: row, slug: call.slug, task: "reply", start: "small", askerName: username, person: username }, async (model) => {
      const answer = await runTurn(model.send, {
        model: model.model.model,
        system: call.system,
        messages: call.messages,
        tools: null,
        price: model.ownModel ? null : model.model.price,
        maxOutput: call.maxOutput,
        maxRounds: 1,
      });
      return { text: answer.text, tokens: answer.tokens, cost: model.ownModel ? 0 : answer.cost, rounds: answer.rounds };
    });
    if (!done.ok) {
      const forbidden = done.reason === "person_budget" || done.reason === "workspace_agent_budget" || done.reason.startsWith("workspace_");
      return { ok: false, code: forbidden ? "forbidden" : "invalid", message: done.message };
    }
    await record(done.value.text ? "replied" : "failed", {
      model: done.model,
      tier: done.tier,
      input: done.tokens.input + done.tokens.cacheRead + done.tokens.cacheWrite,
      output: done.tokens.output,
      cost: done.cost,
      charged: done.charged,
      error: done.value.text ? null : "the model gave no text",
    });
    if (!done.value.text) return { ok: false, code: "invalid", message: "The model gave no answer. Try again in a moment." };
    return { ok: true, text: done.value.text, charged: done.charged };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("agents: a builder call failed", message);
    await record("failed", { error: message });
    return { ok: false, code: "invalid", message: "Something went wrong drafting that. Try again in a moment." };
  }
}
