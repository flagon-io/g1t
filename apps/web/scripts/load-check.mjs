// After the site builds: loads each route's modules from the client build,
// root first and then the route, the way a browser does, each in a fresh
// worker so each has its own module graph. A module that throws as it
// loads stops the build: the bundle can put code in chunks that import each
// other, and a module that reads another as it loads may read it before it
// is there, which kills every page's script (#51: "Cannot read properties of
// undefined (reading 'filter')"). Nothing renders; only loading is checked.
//
//   node scripts/load-check.mjs [build/client]
import { readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (!isMainThread) {
  // Enough of a browser for modules that look at it as they load; nothing here runs a page.
  const noop = () => {};
  const element = () => ({
    style: {},
    setAttribute: noop,
    appendChild: noop,
    addEventListener: noop,
    classList: { add: noop, remove: noop, contains: () => false },
  });
  globalThis.window ??= globalThis;
  globalThis.self ??= globalThis;
  globalThis.document ??= {
    documentElement: element(),
    head: element(),
    body: element(),
    createElement: element,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    cookie: "",
    visibilityState: "visible",
  };
  globalThis.location ??= new URL("https://g1t.sh/");
  globalThis.history ??= { state: null, pushState: noop, replaceState: noop };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
  globalThis.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.sessionStorage ??= globalThis.localStorage;
  globalThis.addEventListener ??= noop;
  globalThis.removeEventListener ??= noop;
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const { root, modules } = workerData;
  let error = null;
  try {
    for (const module of modules) await import(pathToFileURL(join(root, module)).href);
  } catch (caught) {
    error = String(caught?.stack ?? caught)
      .split("\n")
      .slice(0, 2)
      .join(" | ");
  }
  parentPort.postMessage(error);
} else {
  const root = resolve(process.argv[2] ?? "build/client");
  const assets = join(root, "assets");
  const manifestFile = readdirSync(assets).find((name) => /^manifest-.*\.js$/.test(name));
  if (!manifestFile) throw new Error(`No route manifest in ${assets}: build the site first.`);
  const text = readFileSync(join(assets, manifestFile), "utf8");
  const manifest = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const rootModule = manifest.routes.root.module;
  const routes = Object.values(manifest.routes).filter((route) => route.module && route.id !== "root");

  const check = (modules) =>
    new Promise((done) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { root, modules } });
      worker.once("message", (error) => {
        done(error);
        void worker.terminate();
      });
      worker.once("error", (error) => done(String(error?.stack ?? error).split("\n")[0]));
    });

  const failed = [];
  const queue = [{ id: "root", modules: [rootModule] }, ...routes.map((route) => ({ id: route.id, modules: [rootModule, route.module] }))];
  await Promise.all(
    Array.from({ length: Math.min(8, availableParallelism()) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const error = await check(next.modules);
        if (error) failed.push(`${next.id}: ${error}`);
      }
    }),
  );
  if (failed.length) {
    console.error(`${failed.length} of ${routes.length + 1} routes throw as they load:`);
    for (const line of failed.sort().slice(0, 20)) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`Every route loads (${routes.length + 1}).`);
}
