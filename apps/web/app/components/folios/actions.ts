/**
 * How Artifacts' pages change things: a JSON request to `-/artifacts/api`,
 * then the sidebar and page load again so they show it. Returns the
 * service's `{ ok, value }` or `{ ok: false, error }`.
 */
import type { Result } from "@g1t/contracts";
import { useCallback, useEffect, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { browserTimeZone } from "../../lib/time-zone";
import type { FoliosLayoutData } from "../../routes/workspace/folios/layout";

export function useFoliosData(): FoliosLayoutData | undefined {
  return useRouteLoaderData("routes/workspace/folios/layout") as FoliosLayoutData | undefined;
}

/**
 * The viewer's time zone, for the home list's days. The server renders
 * with the zone the browser last told it (the `g1t_tz` cookie, else UTC);
 * the browser then uses its own and remembers it for next time.
 */
export function useViewerZone(): string {
  const saved = useFoliosData()?.zone ?? null;
  const [zone, setZone] = useState(saved ?? "UTC");
  useEffect(() => {
    const own = browserTimeZone();
    if (!own) return;
    setZone(own);
    if (own !== saved) document.cookie = `g1t_tz=${encodeURIComponent(own)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }, [saved]);
  return zone;
}

/** How long a request may take before the page says so instead of waiting on. */
export const FOLIOS_TIMEOUT_MS = 20_000;

/** What a request that failed or took too long says. */
export function foliosFailure<T>(error: unknown): Result<T> {
  const late = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  const message = late ? "Artifacts took too long to answer. Try again in a moment." : "Artifacts didn't answer. Check your connection and try again.";
  return { ok: false, error: { code: "conflict", message } };
}

export async function foliosRequest<T>(slug: string, intent: string, body: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/artifacts/api`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ intent, ...body }),
      signal: AbortSignal.timeout(FOLIOS_TIMEOUT_MS),
    });
    return (await response.json()) as Result<T>;
  } catch (error) {
    return foliosFailure(error);
  }
}

export async function foliosQuery<T>(slug: string, query: Record<string, string>): Promise<Result<T>> {
  try {
    const response = await fetch(`/${slug}/-/artifacts/api?${new URLSearchParams(query)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FOLIOS_TIMEOUT_MS),
    });
    return (await response.json()) as Result<T>;
  } catch (error) {
    return foliosFailure(error);
  }
}

/** `send(intent, body)`: makes the change, then reloads what shows it. `busy` while it works; `error` when it failed. */
export function useFoliosAction(slug: string) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useCallback(
    async <T>(intent: string, body: Record<string, unknown> = {}, options: { reload?: boolean } = {}): Promise<Result<T>> => {
      setBusy(true);
      setError(null);
      const result = await foliosRequest<T>(slug, intent, body);
      setBusy(false);
      if (!result.ok) setError(result.error.message);
      else if (options.reload !== false) void revalidator.revalidate();
      return result;
    },
    [slug, revalidator],
  );
  return { send, busy, error, setError };
}
