/*
 * Test setup.
 *
 * Node 26 ships a disabled `localStorage` global (it throws unless started with
 * `--localstorage-file`), and Vitest's happy-dom bridge keeps that Node global
 * instead of exposing the DOM one. Tests that exercise persistence need a
 * working Storage, so provide one: happy-dom's sessionStorage when present,
 * otherwise a small in-memory implementation.
 */
if (typeof window !== 'undefined' && typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  const fallback: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  };

  const session = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: session ?? fallback,
    configurable: true,
  });
}
