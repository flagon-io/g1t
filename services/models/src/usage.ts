/**
 * What a model answer used, read as it passes through: Anthropic's
 * `usage`, from a whole JSON answer or from a stream's `message_start`
 * (input and cache) and `message_delta` (output) events. The proxy adds
 * these up per run for usage views; billing still prices runs from AI
 * Gateway, not from these.
 */

export type Tokens = {
  input: number;
  output: number;
  /** Prompt tokens read from the provider's cache. */
  cacheRead: number;
  /** Prompt tokens written to the provider's cache. */
  cacheWrite: number;
};

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The tokens of one `usage` object. */
export function fromUsage(usage: Usage | undefined | null): Tokens {
  return {
    input: count(usage?.input_tokens),
    output: count(usage?.output_tokens),
    cacheRead: count(usage?.cache_read_input_tokens),
    cacheWrite: count(usage?.cache_creation_input_tokens),
  };
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
    let event: { type?: string; message?: { usage?: Usage }; usage?: Usage };
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (event.type === "message_start") {
      const start = fromUsage(event.message?.usage);
      this.tokens = { ...start, output: Math.max(this.tokens.output, start.output) };
    } else if (event.type === "message_delta" && event.usage) {
      const delta = fromUsage(event.usage);
      this.tokens.output = Math.max(this.tokens.output, delta.output);
      // Some providers repeat the prompt's tokens at the end.
      if (delta.input) this.tokens.input = delta.input;
      if (delta.cacheRead) this.tokens.cacheRead = delta.cacheRead;
      if (delta.cacheWrite) this.tokens.cacheWrite = delta.cacheWrite;
    }
  }
}

/**
 * The answer as it was, and a promise of what it used, read from a copy of
 * its body. A failed answer, or one that is not a message, used nothing.
 */
export function measure(answer: Response): { response: Response; tokens: Promise<Tokens> } {
  if (!answer.ok || !answer.body) return { response: answer, tokens: Promise.resolve({ ...NO_TOKENS }) };
  const [passed, copy] = answer.body.tee();
  const response = new Response(passed, answer);
  const streaming = (answer.headers.get("content-type") ?? "").includes("text/event-stream");
  const tokens = (async () => {
    try {
      if (!streaming) return fromUsage(((await new Response(copy).json()) as { usage?: Usage }).usage);
      const reader = copy.pipeThrough(new TextDecoderStream()).getReader();
      const usage = new StreamUsage();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        usage.push(value);
      }
      return usage.finish();
    } catch {
      return { ...NO_TOKENS };
    }
  })();
  return { response, tokens };
}
