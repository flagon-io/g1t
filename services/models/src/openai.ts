/**
 * Speaking OpenAI's Chat Completions API on behalf of a harness that speaks
 * Anthropic's Messages API.
 *
 * g1t's agents run Claude Code, which only speaks Anthropic's API. A
 * workspace whose provider speaks OpenAI's (OpenAI itself, Gemini's
 * compatible endpoint, OpenRouter, Groq, vLLM, Ollama…) still gets agents:
 * the proxy turns each request into a chat completion and turns the answer,
 * streamed or not, back into what Anthropic would have sent, tool calls
 * included.
 */

type Json = Record<string, unknown>;

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | AnthropicBlock[]; is_error?: boolean }
  | { type: "thinking" | "redacted_thinking"; [key: string]: unknown };

type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicBlock[] };

export type AnthropicRequest = {
  model?: string;
  system?: string | { type: "text"; text: string }[];
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema?: unknown; type?: string }[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Json[] }
  | { role: "assistant"; content: string | null; tool_calls?: Json[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** How the provider wants the request shaped. */
export type Dialect = {
  /** OpenAI's own API: `max_completion_tokens`, and no temperature for its reasoning models. */
  official: boolean;
  /** Which provider, by name, for the quirks of each. */
  provider?: string;
};

/** The most output tokens a provider accepts in one answer, where it caps them below what the harness asks. */
const MAX_OUTPUT: Record<string, number> = { deepseek: 8192, groq: 32768, cerebras: 32768 };

/**
 * Some providers attach data to a tool call that has to come back with it
 * on the next turn, such as Gemini's thought signatures. The harness keeps
 * nothing but the call's id, so the data rides in the id.
 */
const CARRIED = "__g1t_";

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** A tool call's id, carrying whatever the provider attached to the call. */
export function carryId(id: string, extra: unknown): string {
  return extra == null ? id : `${id}${CARRIED}${toBase64Url(JSON.stringify(extra))}`;
}

/** The provider's own id, and what it attached, from a carried id. */
export function uncarryId(id: string): { id: string; extra: unknown } {
  const at = id.indexOf(CARRIED);
  if (at < 0) return { id, extra: undefined };
  try {
    return { id: id.slice(0, at), extra: JSON.parse(fromBase64Url(id.slice(at + CARRIED.length))) };
  } catch {
    return { id: id.slice(0, at), extra: undefined };
  }
}

function text(content: string | AnthropicBlock[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A chat completion request saying what the Anthropic request said. */
export function toChat(request: AnthropicRequest, model: string, dialect: Dialect): Json {
  const messages: ChatMessage[] = [];
  const system = typeof request.system === "string" ? request.system : text(request.system as AnthropicBlock[] | undefined);
  if (system) messages.push({ role: "system", content: system });

  for (const message of request.messages) {
    const blocks: AnthropicBlock[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (message.role === "assistant") {
      const said = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
      const calls = blocks
        .filter((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => {
          const { id, extra } = uncarryId(b.id);
          return {
            id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            ...(extra === undefined ? {} : { extra_content: extra }),
          };
        });
      messages.push({ role: "assistant", content: said || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results answer the assistant's calls, so they go first, each as
    // its own message; whatever else the user said follows.
    for (const block of blocks) {
      if (block.type !== "tool_result") continue;
      const result = text(block.content);
      messages.push({
        role: "tool",
        tool_call_id: uncarryId(block.tool_use_id).id,
        content: block.is_error ? `Error: ${result}` : result,
      });
    }
    const parts: Json[] = [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
      if (block.type === "image") {
        const url = block.source.type === "base64" ? `data:${block.source.media_type};base64,${block.source.data}` : block.source.url;
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (parts.length === 1 && parts[0].type === "text") messages.push({ role: "user", content: parts[0].text as string });
    else if (parts.length > 0) messages.push({ role: "user", content: parts });
  }

  const body: Json = { model, messages, stream: request.stream === true };
  // Usage at the end of a stream; Mistral refuses the option.
  if (request.stream && dialect.provider !== "mistral") body.stream_options = { include_usage: true };
  const cap = MAX_OUTPUT[dialect.provider ?? ""];
  const maxTokens = request.max_tokens && cap ? Math.min(request.max_tokens, cap) : request.max_tokens;
  if (maxTokens) body[dialect.official ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  if (!dialect.official && request.temperature != null) body.temperature = request.temperature;
  if (!dialect.official && request.top_p != null) body.top_p = request.top_p;
  if (request.stop_sequences?.length) body.stop = request.stop_sequences.slice(0, 4);
  // Anthropic's own server tools (web search and the like) have no
  // counterpart; functions do.
  const tools = (request.tools ?? []).filter((tool) => tool.input_schema != null);
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema },
    }));
    const choice = request.tool_choice;
    if (choice?.type === "any") body.tool_choice = dialect.provider === "mistral" ? "any" : "required";
    else if (choice?.type === "tool" && choice.name) body.tool_choice = { type: "function", function: { name: choice.name } };
    else if (choice?.type === "none") body.tool_choice = "none";
  }
  return body;
}

const STOP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** An Anthropic message saying what a (non-streamed) chat completion said. */
export function fromChat(completion: Json, model: string): Json {
  const choice = ((completion.choices as Json[] | undefined) ?? [])[0] ?? {};
  const message = (choice.message as Json | undefined) ?? {};
  const content: Json[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  for (const call of (message.tool_calls as Json[] | undefined) ?? []) {
    const fn = call.function as Json;
    content.push({
      type: "tool_use",
      id: carryId(String(call.id), call.extra_content),
      name: fn.name,
      input: parseArguments(String(fn.arguments ?? "")),
    });
  }
  const usage = (completion.usage as Json | undefined) ?? {};
  return {
    id: `msg_${String(completion.id ?? crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: STOP[String(choice.finish_reason)] ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) },
  };
}

function event(name: string, data: Json): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
}

/**
 * Turns a chat completion's server-sent events into the events Anthropic's
 * API streams: a message, its content blocks one at a time (text, or a tool
 * call whose input arrives in pieces), then why it stopped.
 */
export class StreamTranslator {
  private started = false;
  private open: { kind: "text" } | { kind: "tool"; slot: number } | null = null;
  private index = -1;
  private stopReason = "end_turn";
  private inputTokens = 0;
  private outputTokens = 0;
  private buffer = "";
  private finished = false;

  private readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  private start(id: string): string {
    if (this.started) return "";
    this.started = true;
    return event("message_start", {
      message: {
        id: `msg_${id.replace(/[^A-Za-z0-9_-]/g, "") || crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private close(): string {
    if (!this.open) return "";
    this.open = null;
    return event("content_block_stop", { index: this.index });
  }

  private chunk(data: Json): string {
    let out = this.start(String(data.id ?? ""));
    const usage = data.usage as Json | undefined;
    if (usage) {
      this.inputTokens = Number(usage.prompt_tokens ?? this.inputTokens);
      this.outputTokens = Number(usage.completion_tokens ?? this.outputTokens);
    }
    for (const choice of (data.choices as Json[] | undefined) ?? []) {
      const delta = (choice.delta as Json | undefined) ?? {};
      if (typeof delta.content === "string" && delta.content) {
        if (this.open?.kind !== "text") {
          out += this.close();
          this.index += 1;
          this.open = { kind: "text" };
          out += event("content_block_start", { index: this.index, content_block: { type: "text", text: "" } });
        }
        out += event("content_block_delta", { index: this.index, delta: { type: "text_delta", text: delta.content } });
      }
      for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
        const slot = Number(call.index ?? 0);
        const fn = (call.function as Json | undefined) ?? {};
        if (!(this.open?.kind === "tool" && this.open.slot === slot)) {
          out += this.close();
          this.index += 1;
          this.open = { kind: "tool", slot };
          out += event("content_block_start", {
            index: this.index,
            content_block: {
              type: "tool_use",
              id: carryId(String(call.id ?? `call_${this.index}`), call.extra_content),
              name: String(fn.name ?? ""),
              input: {},
            },
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          out += event("content_block_delta", {
            index: this.index,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          });
        }
      }
      if (choice.finish_reason) this.stopReason = STOP[String(choice.finish_reason)] ?? "end_turn";
    }
    return out;
  }

  /** Takes raw bytes of the upstream stream; returns Anthropic events to send. */
  push(piece: string): string {
    this.buffer += piece;
    let out = "";
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        out += this.finish();
        continue;
      }
      try {
        out += this.chunk(JSON.parse(payload) as Json);
      } catch {
        // A line that is not JSON carries nothing to translate.
      }
    }
    return out;
  }

  /** The closing events, once. */
  finish(): string {
    if (this.finished) return "";
    this.finished = true;
    return (
      this.start("") +
      this.close() +
      event("message_delta", {
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      }) +
      event("message_stop", {})
    );
  }
}

/** A provider's error, in the shape Anthropic's API uses. */
export function errorFromChat(status: number, body: string): Json {
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as Json;
    const error = (Array.isArray(parsed) ? parsed[0]?.error : parsed.error) as Json | string | undefined;
    if (typeof error === "string") message = error;
    else if (error && typeof error.message === "string") message = error.message;
  } catch {
    // Not JSON: keep the text.
  }
  const type =
    status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status === 404 ? "not_found_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return { type: "error", error: { type, message: `The provider said: ${message}` } };
}

/** A rough count, for the harness's token counting, which chat APIs lack. */
export function estimateTokens(request: AnthropicRequest): number {
  return Math.ceil(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }).length / 4);
}
