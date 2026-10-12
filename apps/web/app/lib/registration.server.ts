/** Who is asking, for identity's rate limits: the visitor's address. */
export function clientKey(request: Request): string | null {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}
