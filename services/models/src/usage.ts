/**
 * What a model answer used, read as it passes through: Anthropic's
 * `usage`, from a whole JSON answer or from a stream's `message_start`
 * (input and cache) and `message_delta` (output) events; or OpenAI's, from
 * a chat completion, a stream's chunks or an embeddings answer. The proxy
 * adds these up per run for usage views, and the AI Gateway charges by
 * them; billing still prices runs from AI Gateway.
 */

export type Tokens = {
  input: number;
  output: number;
  /** Prompt tokens read from the provider's cache. */
  cacheRead: number;
  /** Prompt tokens written to the provider's cache, for either lifetime. */
  cacheWrite: number;
  /** Of `cacheWrite`, those written to the hour-long cache. Absent when none. */
  cacheWrite1h?: number;
};

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
};

/** OpenAI's usage, from a chat completion or embeddings answer. */
export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek's name for cached prompt tokens. */
  prompt_cache_hit_tokens?: number;
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The tokens of one `usage` object. */
export function fromUsage(usage: Usage | undefined | null): Tokens {
  const tokens: Tokens = {
    input: count(usage?.input_tokens),
    output: count(usage?.output_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens),
  };
  const hour = count(usage?.cache_creation?.ephemeral_1h_input_tokens);
  if (hour) tokens.cacheWrite1h = Math.min(hour, tokens.cacheWrite || hour);
  if (hour && !tokens.cacheWrite) tokens.cacheWrite = hour + count(usage?.cache_creation?.ephemeral_5m_input_tokens);
  return tokens;
}

/**
 * The tokens of one OpenAI `usage`: its prompt tokens less those read from
 * the cache are input; the cached ones are cache reads.
 */
export function fromChatUsage(usage: ChatUsage | undefined | null): Tokens {
  const prompt = count(usage?.prompt_tokens);
  const cached = Math.min(prompt, count(usage?.prompt_tokens_details?.cached_tokens) || count(usage?.prompt_cache_hit_tokens));
  return { input: prompt - cached, output: count(usage?.completion_tokens), cacheRead: cached, cacheWrite: 0 };
}

export function total(tokens: Tokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/**
 * Reads a server-sent event stream a chunk at a time. `message_start`
 * carries the prompt's tokens; each `message_delta` carries the output so
 * far (the last one is the total).
 */
export class StreamUsage {
  tokens: Tokens = { ...NO_TOKENS };
  /** The model that answered, as `message_start` names it. */
  model: string | null = null;
  private pending = "";

  push(text: string): void {
    this.pending += text;
    let end = this.pending.indexOf("\n");
    while (end >= 0) {
      this.line(this.pending.slice(0, end).trim());
      this.pending = this.pending.slice(end + 1);
      end = this.pending.indexOf("\n");
    }
  }

  finish(): Tokens {
    this.line(this.pending.trim());
    this.pending = "";
    return this.tokens;
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    let event: { type?: string; message?: { usage?: Usage; model?: unknown }; usage?: Usage };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (event.type === "message_start") {
      if (typeof event.message?.model === "string") this.model = event.message.model;
      const start = fromUsage(event.message?.usage);
      this.tokens = { ...start, output: Math.max(this.tokens.output, start.output) };
    } else if (event.type === "message_delta" && event.usage) {
      const delta = fromUsage(event.usage);
      this.tokens.output = Math.max(this.tokens.output, delta.output);
      // Some providers repeat the prompt's tokens at the end.
      if (delta.input) this.tokens.input = delta.input;
      if (delta.cacheRead) this.tokens.cacheRead = delta.cacheRead;
      if (delta.cacheWrite) this.tokens.cacheWrite = delta.cacheWrite;
      if (delta.cacheWrite1h) this.tokens.cacheWrite1h = delta.cacheWrite1h;
    }
  }
}

/**
 * Reads a chat completion's stream a chunk at a time: the chunk that
 * carries `usage` (the last, when the request asked for it) says it all.
 */
export class ChatStreamUsage {
  tokens: Tokens = { ...NO_TOKENS };
  model: string | null = null;
  private pending = "";

  push(text: string): void {
    this.pending += text;
    let end = this.pending.indexOf("\n");
    while (end >= 0) {
      this.line(this.pending.slice(0, end).trim());
      this.pending = this.pending.slice(end + 1);
      end = this.pending.indexOf("\n");
    }
  }

  finish(): Tokens {
    this.line(this.pending.trim());
    this.pending = "";
    return this.tokens;
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    let chunk: { usage?: ChatUsage | null; model?: unknown };
    try {
      chunk = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (typeof chunk?.model === "string" && !this.model) this.model = chunk.model;
    if (chunk?.usage) this.tokens = fromChatUsage(chunk.usage);
  }
}

/**
 * The answer as it was, and a promise of what it used, read from a copy of
 * its body, with the model that answered when it says. A failed answer, or
 * one that is not a message, used nothing.
 */
export function measure(
  answer: Response,
  shape: "anthropic" | "openai" = "anthropic",
): { response: Response; tokens: Promise<Tokens>; model: Promise<string | null> } {
  if (!answer.ok || !answer.body) {
    return { response: answer, tokens: Promise.resolve({ ...NO_TOKENS }), model: Promise.resolve(null) };
  }
  const [passed, copy] = answer.body.tee();
  const response = new Response(passed, answer);
  const streaming = (answer.headers.get("content-type") ?? "").includes("text/event-stream");
  let model: string | null = null;
  const tokens = (async () => {
    try {
      if (!streaming) {
        const whole = (await new Response(copy).json()) as { usage?: Usage & ChatUsage; model?: unknown };
        if (typeof whole.model === "string") model = whole.model;
        return shape === "openai" ? fromChatUsage(whole.usage) : fromUsage(whole.usage);
      }
      const reader = copy.pipeThrough(new TextDecoderStream()).getReader();
      const usage = shape === "openai" ? new ChatStreamUsage() : new StreamUsage();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        usage.push(value);
      }
      const used = usage.finish();
      model = usage.model;
      return used;
    } catch {
      return { ...NO_TOKENS };
    }
  })();
  return { response, tokens, model: tokens.then(() => model) };
}
