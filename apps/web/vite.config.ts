import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { randomUUID } from "node:crypto";

/**
 * The doc editor's chunk and everything it imports, so a doc's page can
 * ask the browser to fetch them with the page (`<link rel="modulepreload">`,
 * routes/workspace/folios/folio.tsx `links`) rather than after the page's
 * own code has run and asked for them. The editor is only ever imported
 * lazily (it runs in the browser alone), so no route lists it among its
 * modules; this notes its files as the browser build writes them, for the
 * server build that follows in the same run. In development there are no
 * such files, and the page adds no links.
 */
function editorChunk(): Plugin {
  const id = "virtual:g1t-editor-chunk";
  let files: string[] = [];
  return {
    name: "g1t-editor-chunk",
    resolveId(source) {
      return source === id ? `\0${id}` : null;
    },
    load(source) {
      return source === `\0${id}` ? `export default ${JSON.stringify(files)};` : null;
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const editor = chunks.find((chunk) => chunk.moduleIds.some((moduleId) => moduleId.replace(/\\/g, "/").endsWith("/app/components/folios/doc/editor.tsx")));
      if (!editor) return;
      // The chunk first, then what it statically imports, each once.
      const seen = new Set<string>();
      const walk = (fileName: string) => {
        if (seen.has(fileName)) return;
        seen.add(fileName);
        const chunk = chunks.find((c) => c.fileName === fileName);
        for (const imported of chunk?.imports ?? []) walk(imported);
      };
      walk(editor.fileName);
      files = [...seen].map((fileName) => `/${fileName}`);
    },
  };
}

export default defineConfig({
  // In CI, warnings and errors only: the list of every chunk the build
  // writes runs to hundreds of lines, and a job's log is uploaded line by
  // line before the job is done.
  logLevel: process.env.CI ? "warn" : undefined,
  define: { "import.meta.env.G1T_BUILD_ID": JSON.stringify(randomUUID()) },
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tailwindcss(), reactRouter(), editorChunk()],
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // React and react-dom are CommonJS, which the bundler wraps in
            // initialisers that a chunk calls while it loads. Left to
            // automatic splitting, react-dom's landed in an app chunk that
            // imports the chunk calling it, so that chunk ran first and
            // threw `s is not a function`: tooltips, cards, menus and the
            // spend pill never came up. In a chunk of their own, which
            // imports nothing of the app's, they are always ready first.
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler|use-sync-external-store|react-is)[\\/]/, priority: 3 },
            // The UI primitives behind shadcn's components (Radix, and the
            // floating-ui that positions tooltips, cards and menus) set
            // themselves up while they load, calling each other. Inside the
            // app's chunks they could end up in two that import each other,
            // and whichever a page loaded first would call into the other
            // before it was ready. Together, apart from the app, they can't.
            {
              name: "ui",
              test: /[\\/]node_modules[\\/](radix-ui|@radix-ui[\\/][^\\/]+|@floating-ui[\\/][^\\/]+|aria-hidden|react-remove-scroll[^\\/]*|use-callback-ref|use-sidecar|react-style-singleton|get-nonce|tslib|detect-node-es)[\\/]/,
              priority: 3,
            },
            // Icons are shared by nearly every page, a few hundred bytes each:
            // one file for all of them, not a request per icon.
            { name: "icons", test: /[\\/]node_modules[\\/]lucide-react[\\/]/, priority: 2 },
            // The app's own components and helpers that several routes
            // share: grouped by which routes use them, and small groups
            // merged into their neighbours, so a page fetches a few files
            // of them rather than one per module. A signed-in page fetched
            // 124 files, most of them a kilobyte or two, each a request and
            // a `modulepreload` to parse. Modules one route alone uses stay
            // with that route. Packages are left to automatic splitting: a
            // group over them merged what the editor needs with what the
            // diagram renderers need, and every doc fetched both.
            {
              name: "app",
              test: /[\\/]apps[\\/]web[\\/]app[\\/](components|lib)[\\/]/,
              minShareCount: 2,
              entriesAware: true,
              entriesAwareMergeThreshold: 24_000,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});
