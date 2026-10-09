/**
 * Conversations already seen, kept in the browser so switching back to one
 * draws it at once (routes/workspace/chat/channel.tsx `clientLoader`),
 * while the server is asked again behind it. The latest ~20, newest kept;
 * in memory, and in IndexedDB when the browser allows it so a reload is
 * instant too. Every IndexedDB step may fail (private windows, full
 * disks); then only memory is used.
 */

/** How many conversations are kept. */
export const KEEP = 20;

/** A conversation as it was last read, and when. */
export type Kept<T> = { value: T; at: number };

/** A small LRU: the most recently used last. Pure, so it is tested on its own. */
export class Recent<T> {
  private items = new Map<string, Kept<T>>();
  private readonly keep: number;
  constructor(keep = KEEP) {
    this.keep = keep;
  }
  get(key: string): Kept<T> | undefined {
    const found = this.items.get(key);
    if (found) {
      this.items.delete(key);
      this.items.set(key, found);
    }
    return found;
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  set(key: string, value: T, at = Date.now()): void {
    this.items.delete(key);
    this.items.set(key, { value, at });
    while (this.items.size > this.keep) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }
  keys(): string[] {
    return [...this.items.keys()];
  }
}

const DB = "g1t-chat";
const STORE = "conversations";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        try {
          request.result.createObjectStore(STORE);
        } catch {
          // Already there.
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

let db: Promise<IDBDatabase | null> | null = null;
const database = () => (db ??= openDb());

/** The conversations kept, shared by every page in this tab. */
export function createConversationCache<T>() {
  const memory = new Recent<T>();
  return {
    peek: (key: string) => memory.get(key)?.value,
    has: (key: string) => memory.has(key),
    set(key: string, value: T) {
      memory.set(key, value);
      void database().then((store) => {
        if (!store) return;
        try {
          const tx = store.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put({ value, at: Date.now() }, key);
          // Keep the store as small as memory: drop what memory let go.
          const kept = new Set(memory.keys());
          const keys = tx.objectStore(STORE).getAllKeys();
          keys.onsuccess = () => {
            for (const stored of keys.result) if (!kept.has(String(stored))) tx.objectStore(STORE).delete(stored);
          };
        } catch {
          // Memory still has it.
        }
      });
    },
    /** From IndexedDB after a reload, when memory has nothing yet. */
    async load(key: string): Promise<T | undefined> {
      const found = memory.get(key)?.value;
      if (found !== undefined) return found;
      const store = await database();
      if (!store) return undefined;
      return new Promise((resolve) => {
        try {
          const request = store.transaction(STORE, "readonly").objectStore(STORE).get(key);
          request.onsuccess = () => {
            const kept = request.result as Kept<T> | undefined;
            if (kept) memory.set(key, kept.value, kept.at);
            resolve(kept?.value);
          };
          request.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    },
  };
}
