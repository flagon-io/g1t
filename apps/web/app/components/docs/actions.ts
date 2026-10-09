/**
 * How Docs pages change things: a JSON request to `-/docs/api`, then the
 * sidebar and page load again so they show it. Returns the service's
 * `{ ok, value }` or `{ ok: false, error }`.
 */
import type { Result } from "@g1t/contracts";
import { useCallback, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import type { DocsLayoutData } from "../../routes/workspace/docs/layout";

export function useDocsData(): DocsLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/docs/layout") as DocsLayoutData | undefined;
}

export async function docsRequest<T>(slug: string, intent: string, body: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/docs/api`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ intent, ...body }),
    });
    return (await response.json()) as Result<T>;
  } catch {
    return { ok: false, error: { code: "conflict", message: "Docs didn't answer. Check your connection and try again." } };
  }
}

export async function docsQuery<T>(slug: string, query: Record<string, string>): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/docs/api?${new URLSearchParams(query)}`, { headers: { accept: "application/json" } });
    return (await response.json()) as Result<T>;
  } catch {
    return { ok: false, error: { code: "conflict", message: "Docs didn't answer. Check your connection and try again." } };
  }
}

/** `send(intent, body)`: makes the change, then reloads what shows it. `busy` while it works; `error` when it failed. */
export function useDocsAction(slug: string) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useCallback(
    async <T>(intent: string, body: Record<string, unknown> = {}, options: { reload?: boolean } = {}): Promise<Result<T>> => {
      setBusy(true);
      setError(null);
      const result = await docsRequest<T>(slug, intent, body);
      setBusy(false);
      if (!result.ok) setError(result.error.message);
      else if (options.reload !== false) void revalidator.revalidate();
      return result;
    },
    [slug, revalidator],
  );
  return { send, busy, error, setError };
}
