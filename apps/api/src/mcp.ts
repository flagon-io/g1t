import type { Viewer } from "@g1t/contracts";

import { type ApiEnv, operations, operationsByName } from "./operations";

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `g1t is a git forge where agents work on intents.
An intent is a goal on a repository. To work on one: get_intent, then
start_attempt (you get your own fork to clone and push to), record_session
as you work so people can see your reasoning, push your commits, and
submit_attempt with a summary.`;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

function result(id: JsonRpcRequest["id"], value: unknown): object {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): object {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handle(
  env: ApiEnv,
  viewer: Viewer,
  request: JsonRpcRequest,
): Promise<object | null> {
  // Notifications carry no id and get no response.
  if (request.id === undefined) return null;

  switch (request.method) {
    case "initialize": {
      const requested = String(request.params?.protocolVersion ?? "");
      return result(request.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "g1t", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(request.id, {});
    case "tools/list":
      return result(request.id, {
        tools: operations.map(({ name, description, input }) => ({
          name,
          description,
          inputSchema: input,
        })),
      });
    case "tools/call": {
      const operation = operationsByName.get(String(request.params?.name));
      if (!operation) return error(request.id, -32602, "Unknown tool.");
      const input = (request.params?.arguments ?? {}) as Record<string, unknown>;
      const outcome = await operation.run(env, viewer, input);
      // A failed operation is a tool result the model can read and act on,
      // not a protocol error.
      return result(request.id, {
        content: [
          {
            type: "text",
            text: outcome.ok
              ? JSON.stringify(outcome.value, null, 2)
              : outcome.error.message,
          },
        ],
        isError: !outcome.ok,
      });
    }
    default:
      return error(request.id, -32601, `Method not found: ${request.method}`);
  }
}

/**
 * MCP over streamable HTTP. The server keeps no session state, so every
 * POST is answered directly with JSON.
 */
export async function handleMcp(
  request: Request,
  env: ApiEnv,
  viewer: Viewer,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await request.json();
  } catch {
    return Response.json(error(null, -32700, "Parse error"), { status: 400 });
  }
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((item) => handle(env, viewer, item)))
    ).filter((response) => response !== null);
    return responses.length
      ? Response.json(responses)
      : new Response(null, { status: 202 });
  }
  const response = await handle(env, viewer, body);
  return response ? Response.json(response) : new Response(null, { status: 202 });
}
