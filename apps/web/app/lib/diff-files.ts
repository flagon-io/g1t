import type { FileDiff } from "@g1t/contracts";

/**
 * Fetching the files a large change was sent without (lib/diff.ts
 * firstScreens), from routes/repo/diff-files.ts. Files asked for in the
 * same moment, as several scroll near together, go in one request, and
 * each is fetched once per page: a refresh or a file folded and unfolded
 * finds it here.
 */

/** As many as the route takes in one request. */
const PER_REQUEST = 20;
/** How long asks are gathered before they are sent. */
const GATHER_MS = 30;

type Ask = { path: string; resolve: (file: FileDiff | null) => void; reject: (error: unknown) => void };

const loaded = new Map<string, FileDiff | null>();
const loading = new Map<string, Promise<FileDiff | null>>();
const queued = new Map<string, Ask[]>();
let timer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (source: string, path: string) => `${source}\n${path}`;

/** A file fetched already, so it is drawn at once rather than after a frame of its placeholder. */
export function peekFile(source: string, path: string): FileDiff | null | undefined {
  return loaded.get(keyOf(source, path));
}

/**
 * The file at `path` of the change `source` names (the route's address with
 * its `base` and `head`), with its lines; null when the change no longer has it.
 * The files in `also` (the ones after it) come in the same request, so a
 * reader scrolling down finds them fetched rather than asking one by one.
 */
export function loadFile(
  source: string,
  path: string,
  { also = [], fetcher = fetch }: { also?: string[]; fetcher?: typeof fetch } = {},
): Promise<FileDiff | null> {
  const key = keyOf(source, path);
  // Fetched already, or on its way (with the file before it): nothing to send.
  if (loaded.has(key)) return Promise.resolve(loaded.get(key)!);
  if (loading.has(key)) return loading.get(key)!;
  for (const next of also) {
    if (!loaded.has(keyOf(source, next))) void ask(source, next, fetcher).catch(() => {});
  }
  return ask(source, path, fetcher);
}

function ask(source: string, path: string, fetcher: typeof fetch): Promise<FileDiff | null> {
  const key = keyOf(source, path);
  if (loaded.has(key)) return Promise.resolve(loaded.get(key)!);
  const pending = loading.get(key);
  if (pending) return pending;
  const promise = new Promise<FileDiff | null>((resolve, reject) => {
    const asks = queued.get(source) ?? [];
    asks.push({ path, resolve, reject });
    queued.set(source, asks);
    timer ??= setTimeout(() => flush(fetcher), GATHER_MS);
  }).then(
    (file) => {
      loaded.set(key, file);
      loading.delete(key);
      return file;
    },
    (error: unknown) => {
      // Asked again, it is fetched again.
      loading.delete(key);
      throw error;
    },
  );
  loading.set(key, promise);
  return promise;
}

function flush(fetcher: typeof fetch) {
  timer = null;
  const all = [...queued];
  queued.clear();
  for (const [source, asks] of all) {
    for (let start = 0; start < asks.length; start += PER_REQUEST) {
      const batch = asks.slice(start, start + PER_REQUEST);
      const url = `${source}${source.includes("?") ? "&" : "?"}${batch.map((ask) => `path=${encodeURIComponent(ask.path)}`).join("&")}`;
      fetcher(url, { headers: { accept: "application/json" } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`The diff could not be loaded (${response.status}).`);
          const { files } = (await response.json()) as { files: FileDiff[] };
          const byPath = new Map(files.map((file) => [file.path, file]));
          for (const ask of batch) ask.resolve(byPath.get(ask.path) ?? null);
        })
        .catch((error: unknown) => {
          for (const ask of batch) ask.reject(error);
        });
    }
  }
}

/** For tests: forget everything fetched. */
export function forgetFiles() {
  loaded.clear();
  loading.clear();
  queued.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
