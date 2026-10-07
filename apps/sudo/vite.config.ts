import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    // `~/` is app/, set here rather than read from tsconfig's paths: those
    // apply only to files tsconfig includes, and a build beside the other
    // sites' (deploy.mjs) sometimes found legacy-accounts.tsx outside them.
    alias: { "~": fileURLToPath(new URL("./app", import.meta.url)) },
  },
});
