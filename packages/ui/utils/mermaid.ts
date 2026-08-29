/**
 * Mermaid runtime slot.
 *
 * ONE code path feeds `MermaidBlock`: `loadMermaidRuntime()`. It resolves at
 * once from a filled slot and otherwise imports the runtime lazily. Plannotator
 * fills the slot at module evaluation through `./mermaid-eager` (imported by
 * `packages/editor/App.tsx`), which keeps the runtime in its entry chunk on the
 * share portal exactly as it was with the static import, so it cannot fail
 * separately from the app. A host that does not import the eager entry gets
 * the lazy path: the runtime is fetched on the first diagram, a failed import
 * is dropped from the memo so the next call issues a fresh `import()`, and
 * the block re-attempts once and offers Retry.
 *
 * This module has NO static import of `mermaid`; the only place the
 * dependency is named at runtime is the default loader's `import('mermaid')`.
 */
import type { Mermaid, MermaidConfig } from 'mermaid';

/**
 * Hoisted verbatim from the former module-scope `mermaid.initialize(...)` in
 * MermaidBlock. Nothing in it reads a CSS token or the resolved mode.
 * `securityLevel: 'strict'` is a deliberate security pin (see MermaidBlock.test.ts).
 */
export const MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  themeVariables: {
    primaryColor: '#3b82f6',
    primaryTextColor: '#f8fafc',
    primaryBorderColor: '#475569',
    lineColor: '#64748b',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    background: '#1e293b',
    mainBkg: '#1e293b',
    nodeBorder: '#475569',
    clusterBkg: '#1e293b',
    clusterBorder: '#475569',
    titleColor: '#f8fafc',
    edgeLabelBackground: '#1e293b',
  },
  flowchart: {
    htmlLabels: true,
    curve: 'basis',
  },
};

/**
 * Who filled the slot. The eager value doubles as a build marker: the literal
 * only reaches a bundle when `./mermaid-eager` is evaluated in it, which is
 * what `tests/entry-assets.test.ts` asserts on the built HTML.
 */
export type MermaidRuntimeSource = 'plannotator-mermaid-eager' | 'loader' | 'host';

export type MermaidRuntimeLoader = () => Promise<Mermaid>;

/** Default lazy loader: import the runtime and initialize it once. */
const defaultMermaidLoader: MermaidRuntimeLoader = () =>
  import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize(MERMAID_CONFIG);
    return mermaid;
  });

let runtime: Mermaid | null = null;
let runtimeSource: MermaidRuntimeSource | null = null;
let loader: MermaidRuntimeLoader = defaultMermaidLoader;
let pending: Promise<Mermaid> | null = null;

/**
 * Delay before the block's one automatic re-attempt after a failed lazy
 * import. Only chunking hosts can fail here; a filled slot never loads.
 */
let retryDelayMs = 750;

/** Current runtime, or `null` while the slot is empty. */
export function getMermaidRuntime(): Mermaid | null {
  return runtime;
}

/** How the current runtime was registered, or `null` while the slot is empty. */
export function getMermaidRuntimeSource(): MermaidRuntimeSource | null {
  return runtimeSource;
}

/** Register an already-initialized runtime (what `./mermaid-eager` does). */
export function setMermaidRuntime(next: Mermaid, source: MermaidRuntimeSource = 'host'): void {
  runtime = next;
  runtimeSource = source;
  pending = null;
}

/** The block's retry delay for the lazy path. */
export function getMermaidRetryDelayMs(): number {
  return retryDelayMs;
}

/**
 * Resolve the runtime: at once from a filled slot, otherwise through the
 * loader. A rejected load is dropped from the memo so the next call (the
 * block's automatic re-attempt, a later mount, or the Retry button) issues a
 * fresh `import()` instead of replaying the cached rejection.
 */
export function loadMermaidRuntime(): Promise<Mermaid> {
  if (runtime) return Promise.resolve(runtime);
  if (!pending) {
    const attempt = loader().then(
      (loaded) => {
        setMermaidRuntime(loaded, 'loader');
        return loaded;
      },
      (err: unknown) => {
        if (pending === attempt) pending = null;
        throw err;
      },
    );
    pending = attempt;
  }
  return pending;
}

/** Test hook: empty the slot, stand in for the lazy import, shorten the retry delay. */
export function __setMermaidRuntimeLoaderForTests(
  next: MermaidRuntimeLoader | undefined,
  options?: { retryDelayMs?: number },
): void {
  runtime = null;
  runtimeSource = null;
  pending = null;
  loader = next ?? defaultMermaidLoader;
  retryDelayMs = options?.retryDelayMs ?? 750;
}
