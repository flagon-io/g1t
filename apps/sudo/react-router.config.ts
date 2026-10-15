import type { Config } from "@react-router/dev/config";

export default {
  // Rendered on the server, then hydrated in the browser. The page's policy
  // lets only sudo's own scripts run, by a nonce made for each page
  // (entry.server.tsx, lib/guard.ts). Forms post to route actions.
  ssr: true,
} satisfies Config;
