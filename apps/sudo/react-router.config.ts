import type { Config } from "@react-router/dev/config";

export default {
  // Rendered on the server only: the pages ship no JavaScript at all (root
  // leaves out <Scripts />), so the content security policy can forbid
  // every script. Forms are plain HTML forms posting to route actions.
  ssr: true,
} satisfies Config;
