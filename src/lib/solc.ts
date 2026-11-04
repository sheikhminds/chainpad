/**
 * Solidity compiler loading.
 *
 * ChainPad does not bundle the compiler: `soljson` is roughly 10 MB of
 * JavaScript with an inlined WebAssembly binary, and shipping it inside this
 * repo would dominate the app. Instead the compiler is fetched on demand from
 * the official Solidity binary repository and cached in the browser's Cache
 * API, so the second compile works offline.
 *
 * License note: the Solidity compiler is GPL-3.0. It is downloaded at runtime
 * from binaries.soliditylang.org and never redistributed by this project.
 */

export const COMPILER_CDN = 'https://binaries.soliditylang.org/wasm/';

/** Cache name for downloaded compilers. Bump when the loading strategy changes. */
const CACHE_NAME = 'chainpad-solc-v1';
const VERSION_CACHE_KEY = 'chainpad:solc-versions:v1';
const VERSION_CACHE_TTL = 24 * 60 * 60 * 1000;

/** Minimum compiler we support. Older releases use a different standard JSON. */
const MIN_VERSION: [number, number, number] = [0, 6, 0];

/** Used when the version list cannot be fetched (e.g. first visit offline). */
const FALLBACK_VERSIONS = ['0.8.30', '0.8.26', '0.8.20', '0.7.6'];

export interface CompilerBuild {
  version: string;
  longVersion: string;
  path: string;
  url: string;
}

export interface SolcModule {
  cwrap(ident: string, returnType: string, argTypes: string[]): (...args: unknown[]) => unknown;
}

export interface Compiler {
  /** Short version reported by the compiler binary, e.g. `0.8.30+commit.73712a01.Emscripten.clang`. */
  version: string;
  /** License string reported by the compiler binary. */
  license: string;
  /** Standard JSON compile. Resolves imports from the `sources` map. */
  compile(input: string): string;
}

interface VersionListResponse {
  builds?: Array<{ path: string; version: string; longVersion: string }>;
  releases?: Record<string, string>;
  latestRelease?: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readVersionCache(): CompilerBuild[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(VERSION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at: number; builds: CompilerBuild[] };
    if (!parsed || typeof parsed.at !== 'number' || !Array.isArray(parsed.builds)) return null;
    if (Date.now() - parsed.at > VERSION_CACHE_TTL) return null;
    return parsed.builds;
  } catch {
    return null;
  }
}

function writeVersionCache(builds: CompilerBuild[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify({ at: Date.now(), builds }));
  } catch {
    // Storage full or blocked: versions are re-fetched next time, no harm.
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isSupported(version: string): boolean {
  if (version.includes('-')) return false; // nightly builds are not stable enough for a teaching tool
  const parts = version.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const have = parts[i] ?? 0;
    const need = MIN_VERSION[i];
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

/** Turn the official `list.json` payload into a newest-first list of stable compilers. */
export function parseVersionList(payload: VersionListResponse): CompilerBuild[] {
  const builds: CompilerBuild[] = [];
  if (payload.releases) {
    for (const [version, path] of Object.entries(payload.releases)) {
      if (typeof path !== 'string' || !isSupported(version)) continue;
      builds.push({
        version,
        longVersion: version,
        path,
        url: `${COMPILER_CDN}${path}`,
      });
    }
  }
  builds.sort((a, b) => compareVersions(b.version, a.version));
  return builds;
}

function fallbackBuilds(): CompilerBuild[] {
  return FALLBACK_VERSIONS.map((version) => ({
    version,
    longVersion: version,
    path: `soljson-v${version}.js`,
    url: '',
  }));
}

let versionPromise: Promise<CompilerBuild[]> | null = null;

/**
 * Newest-first list of stable compilers >= 0.6.0.
 * Network failures fall back to a short built-in list so the UI is never empty.
 */
export function listCompilerVersions(): Promise<CompilerBuild[]> {
  if (versionPromise) return versionPromise;
  versionPromise = (async () => {
    const cached = readVersionCache();
    if (cached && cached.length > 0) return cached;
    try {
      const response = await fetch(`${COMPILER_CDN}list.json`, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as VersionListResponse;
      const builds = parseVersionList(payload);
      if (builds.length === 0) throw new Error('empty compiler list');
      writeVersionCache(builds);
      return builds;
    } catch {
      return fallbackBuilds();
    }
  })();
  return versionPromise;
}

/** Reset the in-memory version cache (used by tests). */
export function resetVersionCache(): void {
  versionPromise = null;
}

/**
 * Wrap a `soljson` Emscripten module in the small API ChainPad needs.
 * @param soljson object exported by `soljson-vX.Y.Z.js`
 */
export function createCompiler(soljson: SolcModule): Compiler {
  if (!soljson || typeof soljson.cwrap !== 'function') {
    throw new Error('Solidity compiler module did not expose cwrap()');
  }
  const compileFn = soljson.cwrap('solidity_compile', 'string', [
    'string',
    'number',
    'number',
  ]) as unknown as (input: string, callbacks: number, context: number) => string;
  const versionFn = soljson.cwrap('solidity_version', 'string', []) as unknown as () => string;
  const licenseFn = soljson.cwrap('solidity_license', 'string', []) as unknown as () => string;

  return {
    version: String(versionFn()),
    license: String(licenseFn()),
    compile(input: string) {
      return compileFn(input, 0, 0);
    },
  };
}

/**
 * Evaluate a downloaded `soljson.js` file.
 *
 * The file is an Emscripten bundle that reads `module.exports` when running in
 * a CommonJS-like scope, so a tiny shim object is enough. It is *not* inserted
 * into the DOM: the source is never allowed to touch the page globals.
 */
export function instantiateSoljson(source: string): SolcModule {
  if (!source || source.length < 1000) {
    throw new Error('Compiler download looks empty or truncated');
  }
  const shim: { exports: unknown } = { exports: {} };
  let mod: SolcModule;
  try {
    // The bundle is a plain Emscripten script that declares `var Module` and
    // fills in `cwrap` once its inlined WebAssembly binary is instantiated.
    // Appending `return Module` is how we get the object out of the function
    // scope. `process`, `require` and `module` are shadowed so the Node code
    // paths inside Emscripten stay off even if a bundler injected them.
    const factory = new Function(
      'module',
      'exports',
      'process',
      'require',
      `${source}\nreturn Module;`,
    ) as (
      module: { exports: unknown },
      exports: unknown,
      process: undefined,
      require: undefined,
    ) => SolcModule;
    mod = factory(shim, shim.exports, undefined, undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not start the Solidity compiler: ${message}`);
  }
  if (!mod || typeof mod.cwrap !== 'function') {
    throw new Error('Compiler module did not export WebAssembly bindings');
  }
  return mod;
}

async function fetchCompilerSource(url: string): Promise<string> {
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) return await hit.text();
    } catch {
      // Cache API blocked (private mode, quota): fall through to a plain fetch.
    }
  }

  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(
      `Could not download the Solidity compiler (HTTP ${response.status} from ${url})`,
    );
  }
  const text = await response.text();

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url, new Response(text, { headers: { 'content-type': 'text/javascript' } }));
    } catch {
      // Ignore quota errors: the network copy is still usable.
    }
  }
  return text;
}

/**
 * Download (or reuse) a compiler and return the wrapper.
 * @param build entry from {@link listCompilerVersions}
 */
export async function loadCompiler(
  build: CompilerBuild,
  onProgress?: (message: string) => void,
): Promise<Compiler> {
  const url = build.url || `${COMPILER_CDN}${build.path}`;
  onProgress?.(`Downloading Solidity ${build.version}…`);
  const source = await fetchCompilerSource(url);
  onProgress?.('Starting the compiler…');
  const compiler = createCompiler(instantiateSoljson(source));
  if (!isBrowser()) {
    // Nothing to do; the guard only documents that this works in Node too.
  }
  return compiler;
}

const compilerCache = new Map<string, Promise<Compiler>>();

/** Load a compiler once per session and share the promise between callers. */
export function getCompiler(
  build: CompilerBuild,
  onProgress?: (message: string) => void,
): Promise<Compiler> {
  const key = build.url || `${COMPILER_CDN}${build.path}`;
  const existing = compilerCache.get(key);
  if (existing) return existing;
  const promise = loadCompiler(build, onProgress).catch((error) => {
    compilerCache.delete(key);
    throw error;
  });
  compilerCache.set(key, promise);
  return promise;
}
