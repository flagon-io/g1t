/**
 * One model turn with tools: ask, run the tools it calls through the
 * reply's `ToolBox`, give it the results, until it answers in text. Pure
 * apart from `send`, so the loop's rails are tested on their own.
 *
 * Rails: the tool box allows at most `MAX_TOOL_CALLS` for the whole reply
 * (consults included); once they are spent, or the turn has read
 * `INPUT_BUDGET` input tokens, the model is asked to answer without tools.
 * At most `MAX_ROUNDS` requests, whatever happens.
 */
import type { TokenPrice } from "../../runner/src/model-env.ts";
import { type Tokens, costMicros } from "./budget.ts";
import type { ToolBox } from "./tools.ts";

/** The input tokens one turn may read before it must answer. */
export const INPUT_BUDGET = 150_000;
const MAX_ROUNDS = 12;
/** A chat answer is short; this bounds the cost of one that is not. */
export const MAX_OUTPUT_TOKENS = 2048;

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; [key: string]: unknown };
export type ModelMessage = { role: "user" | "assistant"; content: string | Block[] };

export type ModelAnswer = {
  content?: Block[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

/** Sends one Messages API request; throws when the model did not answer. */
export type Send = (body: Record<string, unknown>) => Promise<ModelAnswer>;

export type TurnResult = { text: string; tokens: Tokens; cost: number; rounds: number; stopped?: boolean };

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A session step's rails: more rounds, more input, longer answers than a chat reply. */
export const SESSION_LIMITS = { rounds: 30, input: 400_000, output: 8192 } as const;

export type TurnOptions = {
  /** At most this many requests (default `MAX_ROUNDS`). */
  maxRounds?: number;
  /** Input tokens read before it must answer (default `INPUT_BUDGET`). */
  inputBudget?: number;
  /** The longest answer (default `MAX_OUTPUT_TOKENS`). */
  maxOutput?: number;
  /** Told what the model said in each round that also called tools: a session's transcript. */
  onText?: (text: string) => void;
  /** Asked before each round; true ends the turn with what it has (a session was stopped). */
  stopped?: () => Promise<boolean>;
  /**
   * How hard the model reasons (`output_config.effort`), from the agent's
   * effort setting; null or absent leaves it to the model.
   */
  effort?: string | null;
};

export async function runTurn(
  send: Send,
  input: { model: string; system: string; messages: ModelMessage[]; tools: ToolBox | null; price: TokenPrice | null } & TurnOptions,
): Promise<TurnResult> {
  const messages = [...input.messages];
  let tokens = NO_TOKENS;
  const maxRounds = input.maxRounds ?? MAX_ROUNDS;
  const inputBudget = input.inputBudget ?? INPUT_BUDGET;
  for (let round = 1; ; round++) {
    if (round > 1 && input.stopped && (await input.stopped())) {
      return { text: "", tokens, cost: costMicros(tokens, input.price), rounds: round - 1, stopped: true };
    }
    const definitions = input.tools?.definitions() ?? [];
    const canUse = !!input.tools && definitions.length > 0 && !input.tools.spent && tokens.input + tokens.cacheRead < inputBudget && round < maxRounds;
    const answer = await send({
      model: input.model,
      system: input.system,
      messages,
      max_tokens: input.maxOutput ?? MAX_OUTPUT_TOKENS,
      ...(input.effort ? { output_config: { effort: input.effort } } : {}),
      // Tools stay listed once the conversation has used them, so their
      // results still read; past the rails, the model must answer in text.
      ...(definitions.length ? { tools: definitions, tool_choice: { type: canUse ? "auto" : "none" } } : {}),
    });
    const usage = answer.usage ?? {};
    tokens = addTokens(tokens, {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    });
    const content = answer.content ?? [];
    const calls = content.filter((block) => block.type === "tool_use");
    const text = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!.trim())
      .join("\n\n")
      .trim();
    if (!calls.length || !input.tools || round >= maxRounds) {
      return { text, tokens, cost: costMicros(tokens, input.price), rounds: round };
    }
    if (text) input.onText?.(text);
    messages.push({ role: "assistant", content });
    const results: Block[] = [];
    for (const call of calls) {
      const ran = await input.tools.run(String(call.name ?? ""), (call.input as Record<string, unknown>) ?? {});
      results.push({ type: "tool_result", tool_use_id: call.id, content: ran.text });
    }
    messages.push({ role: "user", content: results });
  }
}
