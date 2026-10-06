import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Icons are shared by nearly every page, a few hundred bytes each:
          // one file for all of them, not a request per icon.
          groups: [{ name: "icons", test: /[\\/]node_modules[\\/]lucide-react[\\/]/ }],
        },
      },
    },
  },
});
