/**
 * Speaking Anthropic's Messages API on behalf of a caller that speaks
 * OpenAI's Chat Completions API: the AI Gateway's `/openai/v1` format, sent
 * to a Claude model.
 *
 * `openai.ts` goes the other way, for a caller that speaks Anthropic's API
 * and a provider that speaks OpenAI's. Between them, any model is
 * reachable from either format.
 *
 * - A request becomes a message: system and developer messages become the
 *   system prompt, tool messages become tool results, functions become
 *   tools, `reasoning_effort` becomes effort, `response_format` a JSON
 *   schema (or an instruction, for `json_object`).
 * - The answer, streamed or not, becomes a chat completion, tool calls
 *   included, with Claude's thinking as `reasoning_content`.
 * - Claude's thinking blocks must come back with the tool calls they led
 *   to, and a chat client keeps nothing but the call's id, so they ride in
 *   the first call's id, as `openai.ts` carries a provider's data.
 */

import { carryId, uncarryId } from "./openai.ts";

type Json = Record<string, unknown>;

/** A request this translation cannot say in Anthropic's terms, and why. */
export class Untranslatable extends Error {}

/** The most output tokens asked for when a request names none: Anthropic requires a number. */
export const DEFAULT_MAX_TOKENS = 8192;

/** OpenAI's `reasoning_effort` as Anthropic's effort. */
export function anthropicEffort(effort: unknown): string | undefined {
  if (effort === "none" || effort === "minimal" || effort === "low") return "low";
  if (effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") return effort;
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => ((part as Json)?.type === "text" ? String((part as Json).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** A data: URL's media type and base64 data, or null. */
function dataUrl(url: string): { media_type: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { media_type: match[1]!, data: match[2]! } : null;
}

/** A user message's parts as Anthropic content blocks. */
function userBlocks(content: unknown): Json[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Json[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: String(part.text) });
    } else if (part.type === "image_url") {
      const url = String(((part.image_url ?? {}) as Json).url ?? "");
      const inline = dataUrl(url);
      blocks.push({ type: "image", source: inline ? { type: "base64", ...inline } : { type: "url", url } });
    } else if (part.type === "file") {
      const file = (part.file ?? {}) as Json;
      const inline = dataUrl(String(file.file_data ?? ""));
      if (!inline) throw new Untranslatable("A file part needs its contents inline, as file_data: a data: URL.");
      blocks.push({ type: "document", source: { type: "base64", ...inline } });
    } else {
      throw new Untranslatable(`Message parts of type ${String(part.type)} are not supported with Claude models; send text, image_url or file.`);
    }
  }
  return blocks;
}

/** What a tool message said, as a tool result's content. */
function toolContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  return userBlocks(content);
}

/** An Anthropic Messages request saying what a chat completion request said. */
export function chatToAnthropic(request: Json, model: string): Json {
  if (typeof request.n === "number" && request.n > 1) {
    throw new Untranslatable("Claude models answer once per request: leave out n, or set it to 1.");
  }
  const system: string[] = [];
  const messages: { role: "user" | "assistant"; content: Json[] }[] = [];
  const add = (role: "user" | "assistant", blocks: Json[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // Tool results and what follows them make one user turn.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const raw of (request.messages as unknown[] | undefined) ?? []) {
    const message = (raw ?? {}) as Json;
    switch (message.role) {
      case "system":
      case "developer": {
        const said = textOf(message.content);
        if (said) system.push(said);
        break;
      }
      case "user":
        add("user", userBlocks(message.content));
        break;
      case "assistant": {
        const blocks: Json[] = [];
        const calls = (message.tool_calls as Json[] | undefined) ?? [];
        // The thinking that led to these calls, carried in the first call's id.
        const carried = calls.length ? uncarryId(String(calls[0]!.id ?? "")).extra : undefined;
        const thinking = (carried as { thinking?: unknown } | undefined)?.thinking;
        if (Array.isArray(thinking)) blocks.push(...(thinking as Json[]));
        const said = textOf(message.content);
        if (said) blocks.push({ type: "text", text: said });
        for (const call of calls) {
          const fn = (call.function ?? {}) as Json;
          let input: unknown = {};
          try {
            input = fn.arguments ? JSON.parse(String(fn.arguments)) : {};
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: uncarryId(String(call.id ?? "")).id, name: String(fn.name ?? ""), input });
        }
        add("assistant", blocks);
        break;
      }
      case "tool":
        add("user", [
          {
            type: "tool_result",
            tool_use_id: uncarryId(String(message.tool_call_id ?? "")).id,
            content: toolContent(message.content),
          },
        ]);
        break;
      default:
        throw new Untranslatable(`Messages with the role ${String(message.role)} are not supported with Claude models.`);
    }
  }

  const body: Json = {
    model,
    messages,
    max_tokens: Number(request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
  };
  if (request.stream === true) body.stream = true;
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  const stop = typeof request.stop === "string" ? [request.stop] : Array.isArray(request.stop) ? request.stop : [];
  if (stop.length) body.stop_sequences = stop.map(String);
  if (typeof request.user === "string" && request.user) body.metadata = { user_id: request.user.slice(0, 256) };

  const output: Json = {};
  const effort = anthropicEffort(request.reasoning_effort);
  if (effort) output.effort = effort;
  const format = (request.response_format ?? {}) as Json;
  if (format.type === "json_schema") {
    const schema = ((format.json_schema ?? {}) as Json).schema;
    if (schema) output.format = { type: "json_schema", schema };
  } else if (format.type === "json_object") {
    system.push("Answer with a single JSON object and nothing else.");
  }
  if (Object.keys(output).length) body.output_config = output;
  // Anthropic's own thinking settings, for a caller that knows them.
  if (request.thinking && typeof request.thinking === "object") body.thinking = request.thinking;
  if (system.length) body.system = system.join("\n\n");

  const tools = (request.tools as Json[] | undefined) ?? [];
  if (tools.length) {
    body.tools = tools.map((tool) => {
      if (tool.type !== "function") {
        throw new Untranslatable(`Tools of type ${String(tool.type)} are not supported with Claude models in this format; send functions.`);
      }
      const fn = (tool.function ?? {}) as Json;
      return {
        name: String(fn.name ?? ""),
        ...(fn.description ? { description: String(fn.description) } : {}),
        input_schema: fn.parameters ?? { type: "object", properties: {} },
        ...(fn.strict === true ? { strict: true } : {}),
      };
    });
  }
  const choice = request.tool_choice;
  const parallel = request.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === "none") body.tool_choice = { type: "none" };
  else if (choice === "required") body.tool_choice = { type: "any", ...parallel };
  else if (choice && typeof choice === "object") {
    const name = ((choice as Json).function as Json | undefined)?.name;
    if (name) body.tool_choice = { type: "tool", name: String(name), ...parallel };
  } else if (tools.length && request.parallel_tool_calls === false) body.tool_choice = { type: "auto", ...parallel };
  return body;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  refusal: "content_filter",
};

/** A finish reason for an Anthropic stop reason. */
export function finishReason(stop: unknown): string {
  return FINISH[String(stop)] ?? "stop";
}

/** Anthropic's usage, as a chat completion reports it: cached tokens are part of the prompt. */
export function chatUsage(usage: Json | undefined | null): Json {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  const cached = n(usage?.cache_read_input_tokens);
  const prompt = n(usage?.input_tokens) + cached + n(usage?.cache_creation_input_tokens);
  const completion = n(usage?.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

/** The thinking blocks among an answer's content, to carry with its first tool call. */
function thinkingOf(content: Json[]): Json[] {
  return content.filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
}

/** A chat completion saying what an Anthropic message said. */
export function anthropicToChat(message: Json, model: string): Json {
  const content = (message.content as Json[] | undefined) ?? [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  const reasoning = content
    .filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => String(block.thinking))
    .join("\n");
  const thinking = thinkingOf(content);
  const calls = content
    .filter((block) => block.type === "tool_use")
    .map((block, index) => ({
      id: index === 0 && thinking.length ? carryId(String(block.id), { thinking }) : String(block.id),
      type: "function",
      function: { name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) },
    }));
  return {
    id: `chatcmpl-${String(message.id ?? crypto.randomUUID()).replace(/^msg_/, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || (calls.length ? null : ""),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length ? { tool_calls: calls } : {}),
          refusal: null,
        },
        logprobs: null,
        finish_reason: finishReason(message.stop_reason),
      },
    ],
    usage: chatUsage(message.usage as Json | undefined),
  };
}

/**
 * Turns Anthropic's streamed events into a chat completion's chunks: the
 * role first, then text, reasoning and tool calls as they arrive, then why
 * it stopped, the usage when the caller asked for it, and `[DONE]`.
 */
export class ChatStreamTranslator {
  private readonly model: string;
  private readonly includeUsage: boolean;
  private id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private buffer = "";
  private started = false;
  private finished = false;
  private usage: Json = {};
  private stop = "end_turn";
  /** Content blocks by their index: what kind each is, and its tool call's slot. */
  private blocks = new Map<number, { kind: string; slot?: number; block?: Json }>();
  private calls = 0;
  /** Thinking blocks so far, with their signatures, to carry with the first call. */
  private thinking: Json[] = [];

  constructor(model: string, includeUsage: boolean) {
    this.model = model;
    this.includeUsage = includeUsage;
  }

  private chunk(delta: Json, finish: string | null = null): string {
    const data = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  private start(): string {
    if (this.started) return "";
    this.started = true;
    return this.chunk({ role: "assistant", content: "" });
  }

  private event(data: Json): string {
    switch (data.type) {
      case "message_start": {
        const message = (data.message ?? {}) as Json;
        if (typeof message.id === "string") this.id = `chatcmpl-${message.id.replace(/^msg_/, "")}`;
        this.usage = { ...((message.usage as Json | undefined) ?? {}) };
        return this.start();
      }
      case "content_block_start": {
        const index = Number(data.index ?? 0);
        const block = (data.content_block ?? {}) as Json;
        if (block.type === "tool_use") {
          const slot = this.calls++;
          this.blocks.set(index, { kind: "tool_use", slot });
          const id = slot === 0 && this.thinking.length ? carryId(String(block.id), { thinking: this.thinking }) : String(block.id);
          return (
            this.start() +
            this.chunk({ tool_calls: [{ index: slot, id, type: "function", function: { name: String(block.name ?? ""), arguments: "" } }] })
          );
        }
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          const kept: Json = { ...block };
          this.blocks.set(index, { kind: String(block.type), block: kept });
          this.thinking.push(kept);
          return this.start();
        }
        this.blocks.set(index, { kind: String(block.type) });
        return this.start() + (block.type === "text" && block.text ? this.chunk({ content: String(block.text) }) : "");
      }
      case "content_block_delta": {
        const at = this.blocks.get(Number(data.index ?? 0));
        const delta = (data.delta ?? {}) as Json;
        if (delta.type === "text_delta") return this.chunk({ content: String(delta.text ?? "") });
        if (delta.type === "input_json_delta" && at?.slot != null) {
          return this.chunk({ tool_calls: [{ index: at.slot, function: { arguments: String(delta.partial_json ?? "") } }] });
        }
        if (delta.type === "thinking_delta" && at?.block) {
          at.block.thinking = String(at.block.thinking ?? "") + String(delta.thinking ?? "");
          return delta.thinking ? this.chunk({ reasoning_content: String(delta.thinking) }) : "";
        }
        if (delta.type === "signature_delta" && at?.block) {
          at.block.signature = String(at.block.signature ?? "") + String(delta.signature ?? "");
        }
        return "";
      }
      case "message_delta": {
        const delta = (data.delta ?? {}) as Json;
        if (delta.stop_reason) this.stop = String(delta.stop_reason);
        const usage = (data.usage ?? {}) as Json;
        for (const [key, value] of Object.entries(usage)) if (typeof value === "number" && value > 0) this.usage[key] = value;
        return "";
      }
      case "message_stop":
        return this.finish();
      case "error": {
        const error = (data.error ?? {}) as Json;
        this.finished = true;
        return `data: ${JSON.stringify({ error: { message: String(error.message ?? "The model failed."), type: String(error.type ?? "api_error"), param: null, code: null } })}\n\ndata: [DONE]\n\n`;
      }
      default:
        return "";
    }
  }

  /** Takes raw bytes of Anthropic's stream; returns chunks to send. */
  push(piece: string): string {
    this.buffer += piece;
    let out = "";
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line.startsWith("data:")) continue;
      try {
        out += this.event(JSON.parse(line.slice(5).trim()) as Json);
      } catch {
        // A line that is not JSON carries nothing to translate.
      }
    }
    return out;
  }

  /** The closing chunks, once. */
  finish(): string {
    if (this.finished) return "";
    this.finished = true;
    let out = this.start() + this.chunk({}, finishReason(this.stop));
    if (this.includeUsage) {
      const data = { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model, choices: [], usage: chatUsage(this.usage) };
      out += `data: ${JSON.stringify(data)}\n\n`;
    }
    return `${out}data: [DONE]\n\n`;
  }
}

/** OpenAI's error types, by the statuses the gateway answers with. */
export function openaiErrorType(status: number): { type: string; code: string | null } {
  if (status === 401) return { type: "authentication_error", code: "invalid_api_key" };
  if (status === 402) return { type: "insufficient_quota", code: "insufficient_quota" };
  if (status === 403) return { type: "permission_error", code: null };
  if (status === 404) return { type: "invalid_request_error", code: "model_not_found" };
  if (status === 429) return { type: "rate_limit_error", code: "rate_limit_exceeded" };
  if (status >= 500) return { type: "api_error", code: null };
  return { type: "invalid_request_error", code: null };
}

/** An error in the shape OpenAI's API and SDKs use. */
export function openaiError(status: number, message: string, code?: string | null): Response {
  const kind = openaiErrorType(status);
  return Response.json(
    { error: { message, type: kind.type, param: null, code: code === undefined ? kind.code : code } },
    { status },
  );
}
