/**
 * The methods only g1t's own services call (`chatInternalClient` in
 * @g1t/contracts), at `POST /internal/<method>`: they act as @g1t and take
 * no viewer. The site never reaches them: it calls `/rpc/<method>` by name,
 * on a person's behalf, and nothing it sends goes to `/internal/`. And
 * anything that came in from the internet is refused, should a route ever
 * be pointed at this Worker by mistake.
 */

/** What the service does for these methods (src/index.ts). */
export type InternalChat = {
  internalG1tPost(a: { workspace: string; channel_id: string; body: string }): Promise<unknown>;
  internalG1tEdit(a: { workspace: string; channel_id: string; id: string; body: string }): Promise<unknown>;
};

/**
 * Whether a request came from the internet. Cloudflare names the client of
 * every request that reached it from outside; a service binding's request
 * carries none of these unless a caller copied them over, which g1t's
 * services never do.
 */
export function fromInternet(request: Request): boolean {
  return request.headers.has("cf-connecting-ip") || request.headers.has("x-real-ip") || request.headers.has("x-forwarded-for");
}

export async function internalAnswer(service: InternalChat, request: Request, method: string): Promise<Response> {
  if (fromInternet(request)) return new Response("Forbidden\n", { status: 403 });
  const args = (await request.json().catch(() => ({}))) as any;
  switch (method) {
    case "g1t_post":
      return Response.json(await service.internalG1tPost(args));
    case "g1t_edit":
      return Response.json(await service.internalG1tEdit(args));
    default:
      return new Response("Unknown method\n", { status: 404 });
  }
}
