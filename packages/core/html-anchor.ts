/**
 * Raw-HTML annotation anchors: the pure, host-facing helpers a consumer of
 * `@plannotator/ui`'s HtmlViewer needs on either side of its own storage.
 *
 * - `buildPersistedHtmlAnchor` trims a composed comment's anchor into a
 *   bounded record a host can persist (target cap, byte budget).
 * - `projectHostThreads` projects stored host rows back onto the viewer's
 *   `annotations` prop shape, in the order that becomes the marker numbering.
 *
 * Browser-safe and dependency-free (this package is `@plannotator/core`).
 * The types below are structurally identical to `HtmlElementAnchor` and
 * `HtmlAnnotationTarget` in `@plannotator/ui/types`; the validators mirror
 * the caps `@plannotator/ui` enforces at its own parent trust boundary
 * (`components/html-viewer/useHtmlAnnotation.ts`), so nothing persisted here
 * is ever refused on read.
 */

export interface HtmlAnchorPoint {
  x: number;
  y: number;
}

export interface HtmlElementAnchor {
  selector: string;
  tagName: string;
  text?: string;
  point?: HtmlAnchorPoint;
}

export interface HtmlAnnotationTarget {
  label?: string;
  text: string;
  anchor?: HtmlElementAnchor;
}

/** Mirrors `MAX_ANCHOR_SELECTOR_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_SELECTOR_LENGTH = 1024;
/** Mirrors `MAX_ANCHOR_TAG_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_ANCHOR_TAG_LENGTH = 64;
/** Mirrors `MAX_ANCHOR_TEXT_LENGTH` in `@plannotator/ui` (the 400-char snapshot). */
export const MAX_HTML_ANCHOR_TEXT_LENGTH = 400;
/** Mirrors `MAX_TARGET_LABEL_LENGTH` in `@plannotator/ui`. */
export const MAX_HTML_TARGET_LABEL_LENGTH = 64;
/**
 * Persisted bound for an additional target's display text: the anchor
 * snapshot bound, not the viewer's 10,000-char draft bound (a handful of
 * draft-sized texts alone would blow a 16 KiB anchor budget).
 */
export const MAX_HTML_TARGET_TEXT_LENGTH = 400;
/** Mirrors `MAX_ADDITIONAL_TARGETS` in `@plannotator/ui` (the draft cap). */
export const MAX_HTML_ADDITIONAL_TARGETS = 16;
/** Default byte budget for a persisted anchor (16 KiB of UTF-8 JSON). */
export const DEFAULT_HTML_ANCHOR_MAX_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Truncate to at most `max` UTF-16 units without splitting a surrogate pair
 * (a lone high surrogate becomes U+FFFD once UTF-8-encoded on the wire).
 */
export function truncateSurrogateSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

function parseHtmlAnchorPoint(value: unknown): HtmlAnchorPoint | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y } = value;
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/**
 * Validate a stored element anchor; `null` fails closed to text-only restore.
 * A malformed `point` is dropped without rejecting the anchor it rides on
 * (the marker then falls back to the element rect's center), the same
 * additive rule the viewer applies to bridge messages.
 */
export function parseHtmlElementAnchor(value: unknown): HtmlElementAnchor | null {
  if (!isRecord(value)) return null;
  const { selector, tagName, text } = value;
  if (
    typeof selector !== "string"
    || selector.length === 0
    || selector.length > MAX_HTML_ANCHOR_SELECTOR_LENGTH
    || typeof tagName !== "string"
    || tagName.length === 0
    || tagName.length > MAX_HTML_ANCHOR_TAG_LENGTH
  ) {
    return null;
  }
  const point = parseHtmlAnchorPoint(value.point);
  if (text === undefined) return { selector, tagName, ...(point ? { point } : {}) };
  if (typeof text !== "string" || text.length > MAX_HTML_ANCHOR_TEXT_LENGTH) return null;
  return { selector, tagName, text, ...(point ? { point } : {}) };
}

/**
 * Validate stored additional targets. A target needs its display text; a
 * broken per-target anchor or label is dropped, not fatal (the target still
 * lists in the composer and export; only its marker restore is lost). The
 * count is capped on read too: rows can come from arbitrary API clients, and
 * the viewer slices to its own cap before the bridge anyway.
 */
export function parseHtmlAdditionalTargets(
  value: unknown,
  maxTargets: number = MAX_HTML_ADDITIONAL_TARGETS,
): HtmlAnnotationTarget[] {
  if (!Array.isArray(value)) return [];
  const targets: HtmlAnnotationTarget[] = [];
  for (const entry of value) {
    if (targets.length >= maxTargets) break;
    if (!isRecord(entry)) continue;
    const { label, text, anchor } = entry;
    if (typeof text !== "string" || text.length === 0) continue;
    const parsedAnchor = parseHtmlElementAnchor(anchor);
    const validLabel =
      typeof label === "string" && label.length > 0 && label.length <= MAX_HTML_TARGET_LABEL_LENGTH
        ? label
        : undefined;
    targets.push({
      ...(validLabel !== undefined ? { label: validLabel } : {}),
      text: truncateSurrogateSafe(text, MAX_HTML_TARGET_TEXT_LENGTH),
      ...(parsedAnchor !== null ? { anchor: parsedAnchor } : {}),
    });
  }
  return targets;
}

/** The anchor record a host persists for a raw-HTML comment: the legacy
 * text quote plus, additively, the durable element fields when the viewer
 * captured them. */
export interface PersistedHtmlAnchor {
  originalText: string;
  htmlAnchor?: HtmlElementAnchor;
  htmlAdditionalTargets?: HtmlAnnotationTarget[];
}

export interface BuildPersistedHtmlAnchorOptions {
  /** Byte budget for the serialized (UTF-8 JSON) anchor. Default 16 KiB. */
  maxBytes?: number;
  /** Product cap on persisted additional targets. Default 16 (the viewer's draft cap). */
  maxTargets?: number;
}

export interface PersistedHtmlAnchorResult {
  anchor: PersistedHtmlAnchor;
  /** Every target not persisted: `capDroppedTargets + sizeDroppedTargets`. */
  droppedTargets: number;
  /** Targets dropped by `maxTargets` (reported against the product cap). */
  capDroppedTargets: number;
  /** Targets shed to keep the serialized anchor under `maxBytes` (a different reason, said separately). */
  sizeDroppedTargets: number;
}

function serializedAnchorBytes(anchor: PersistedHtmlAnchor): number {
  return new TextEncoder().encode(JSON.stringify(anchor)).length;
}

/**
 * The quote length below which the byte budget stops eating the quote and
 * starts shedding targets instead. A 400-unit prefix (the anchor-snapshot
 * bound) is still a solid text-search restore key and panel context line;
 * truncating past it to make room for targets would trade the row's primary
 * anchor text for its extras.
 */
const MIN_USEFUL_QUOTE_LENGTH = MAX_HTML_ANCHOR_TEXT_LENGTH;

/**
 * Build the anchor a host persists for a raw-HTML comment. Additive over the
 * legacy `{ originalText }` shape: a drag capture without an element anchor
 * writes exactly that shape, and an input already within every bound comes
 * back byte-identical. Enforces the persistence bounds:
 *
 * - `htmlAnchor` is validated by the same fail-closed parser the read path
 *   uses (never persist what would be refused on read back);
 * - additional targets are capped at `maxTargets` in draft order, the cap
 *   drop counted separately from the size drop so a host's notice never
 *   reports a size-driven drop as its product cap;
 * - the serialized anchor is kept under `maxBytes`: the quote (the elastic
 *   field) is truncated first, but only down to MIN_USEFUL_QUOTE_LENGTH;
 *   below that, targets are shed from the end before the quote gives up
 *   another character, so a size squeeze can never silently annihilate the
 *   quoted text while extras survive. Truncation is surrogate-safe and
 *   yields a PREFIX, so text-search restore still matches it.
 */
export function buildPersistedHtmlAnchor(
  source: {
    originalText: string;
    htmlAnchor?: HtmlElementAnchor | null;
    htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null;
  },
  options: BuildPersistedHtmlAnchorOptions = {},
): PersistedHtmlAnchorResult {
  const maxBytes = options.maxBytes ?? DEFAULT_HTML_ANCHOR_MAX_BYTES;
  const maxTargets = options.maxTargets ?? MAX_HTML_ADDITIONAL_TARGETS;
  // Persist-side validation mirrors the read side: bounds and shape are
  // enforced on what is written, not only on what is later read back.
  const htmlAnchor = parseHtmlElementAnchor(source.htmlAnchor) ?? undefined;
  const drafted = source.htmlAdditionalTargets ?? [];
  // Kept-target key order is text, label, anchor: the order the reference
  // host implementation persisted, so a stored anchor's serialization (and
  // any fingerprint over it) does not change when a host adopts this helper.
  let kept = drafted.slice(0, Math.max(0, maxTargets)).map((target) => {
    const entry: HtmlAnnotationTarget = {
      text: truncateSurrogateSafe(target.text, MAX_HTML_TARGET_TEXT_LENGTH),
    };
    if (target.label !== undefined) {
      entry.label = truncateSurrogateSafe(target.label, MAX_HTML_TARGET_LABEL_LENGTH);
    }
    const targetAnchor = parseHtmlElementAnchor(target.anchor);
    if (targetAnchor !== null) entry.anchor = targetAnchor;
    return entry;
  });
  const capDroppedTargets = drafted.length - kept.length;
  let originalText = source.originalText;

  const compose = (): PersistedHtmlAnchor => ({
    originalText,
    ...(htmlAnchor !== undefined ? { htmlAnchor } : {}),
    ...(kept.length > 0 ? { htmlAdditionalTargets: kept } : {}),
  });

  let anchor = compose();

  const truncateQuoteWhileOver = (floor: number): void => {
    while (serializedAnchorBytes(anchor) > maxBytes && originalText.length > floor) {
      const over = serializedAnchorBytes(anchor) - maxBytes;
      // Each removed UTF-16 unit frees at least one byte; remove in honest
      // chunks and re-measure (escaping and multi-byte make exact math
      // per-character; the loop converges in a handful of passes).
      const cut = Math.min(
        originalText.length - floor,
        Math.max(1, Math.ceil(over / 4)),
      );
      originalText = truncateSurrogateSafe(originalText, originalText.length - cut);
      anchor = compose();
    }
  };

  // Byte budget, exact over the serialized JSON, in three stages: quote down
  // to its useful floor, then targets from the end, then the rest of the
  // quote (only reachable if the base anchor plus a floor-length quote alone
  // overflow, which validated bounds make unreachable with the default budget).
  truncateQuoteWhileOver(Math.min(MIN_USEFUL_QUOTE_LENGTH, originalText.length));
  while (serializedAnchorBytes(anchor) > maxBytes && kept.length > 0) {
    kept = kept.slice(0, kept.length - 1);
    anchor = compose();
  }
  truncateQuoteWhileOver(0);
  const sizeDroppedTargets =
    drafted.length - capDroppedTargets - (anchor.htmlAdditionalTargets?.length ?? 0);
  return {
    anchor,
    droppedTargets: capDroppedTargets + sizeDroppedTargets,
    capDroppedTargets,
    sizeDroppedTargets,
  };
}

/** One stored host row, in the host's own thread order. */
export interface HostThread {
  id: string;
  /** The quoted text; empty for element-only pinpoints and document-level notes. */
  originalText: string;
  htmlAnchor?: HtmlElementAnchor | null;
  htmlAdditionalTargets?: readonly HtmlAnnotationTarget[] | null;
  /** Thread state. Absent means the host has no state concept: the row is open. */
  state?: "open" | "resolved" | string;
  /** Optional presentational fields carried verbatim onto the projection. */
  text?: string;
  author?: string;
  createdA?: number;
  images?: Array<{ path: string; name: string }>;
}

export interface ProjectHostThreadsOptions {
  /** Keep only rows whose `state` is `"open"` (or absent). Default false: every row projects. */
  openOnly?: boolean;
  /**
   * How a row with nothing restorable (no quoted text, no element anchor)
   * projects. `'global'` (default, Plannotator's model): a document-level
   * `GLOBAL_COMMENT`, rendered by the panel's global card grammar and never
   * reported as unanchored. `'unanchored'`: a page `COMMENT` with an empty
   * quote and no anchor, which the viewer's unanchored report then names
   * (the panel renders it with an empty quote line), for hosts that treat
   * such rows as comments that lost their place.
   */
  documentLevel?: 'global' | 'unanchored';
  /**
   * Read-side cap on additional targets per row. Default undefined: the
   * viewer's own 16 applies (rows from arbitrary API clients can carry
   * more; the viewer slices before the bridge anyway). A host with a
   * smaller persisted cap passes it so the projection matches its store.
   */
  maxTargets?: number;
}

/**
 * The viewer-facing annotation shape, structurally the `Annotation` of
 * `@plannotator/ui/types` restricted to what the raw-HTML surface reads:
 * paint fields (`originalText`, `htmlAnchor`, `htmlAdditionalTargets`), the
 * type that decides marker versus document-level card, and the optional
 * presentational fields. `@plannotator/ui` re-exports the projection typed
 * as `Annotation[]`.
 */
export interface ProjectedHostAnnotation {
  id: string;
  blockId: "";
  startOffset: 0;
  endOffset: 0;
  type: "COMMENT" | "GLOBAL_COMMENT";
  text?: string;
  originalText: string;
  createdA: number;
  author?: string;
  images?: Array<{ path: string; name: string }>;
  htmlAnchor?: HtmlElementAnchor;
  htmlAdditionalTargets?: HtmlAnnotationTarget[];
}

/**
 * Project stored host rows onto the viewer's `annotations` prop. The OUTPUT
 * ORDER IS THE INPUT ORDER (minus filtered rows), and the viewer numbers
 * markers by array position, so pass rows in the order the host's panel
 * lists them and bubble N is card N.
 *
 * - A row with nothing restorable at all (no quoted text and no element
 *   anchor, e.g. an agent's document-level note) projects by
 *   `documentLevel`: `'global'` (default) makes it a `GLOBAL_COMMENT`, a
 *   document-level comment the panel renders without a quote line and the
 *   viewer never reports as unanchored; `'unanchored'` keeps it a page
 *   `COMMENT` with an empty quote, which the viewer's unanchored report
 *   names. An element anchor is a page location even without quoted text
 *   (a pinpoint on an image or chart), so such rows stay `COMMENT` in both
 *   modes; projecting them global would drop their marker and number.
 * - Anchors are validated fail-closed on the way through (a malformed stored
 *   anchor degrades to text-only restore, never a crash); additional targets
 *   validate per entry and cap at `maxTargets` (default: the viewer's 16).
 * - `openOnly` keeps rows whose `state` is `"open"` or absent, so resolved
 *   rows unpaint and give their number up.
 *
 * Pure: no clock, no randomness. `createdA` defaults to 0 when the row
 * carries none; hosts that sort by time supply it.
 */
export function projectHostThreads(
  threads: readonly HostThread[],
  options: ProjectHostThreadsOptions = {},
): ProjectedHostAnnotation[] {
  const out: ProjectedHostAnnotation[] = [];
  const documentLevel = options.documentLevel ?? "global";
  const maxTargets = options.maxTargets ?? MAX_HTML_ADDITIONAL_TARGETS;
  for (const thread of threads) {
    if (options.openOnly && thread.state !== undefined && thread.state !== "open") continue;
    const htmlAnchor = parseHtmlElementAnchor(thread.htmlAnchor);
    const htmlAdditionalTargets = parseHtmlAdditionalTargets(thread.htmlAdditionalTargets, maxTargets);
    const originalText = typeof thread.originalText === "string" ? thread.originalText : "";
    const anchorless = originalText === "" && htmlAnchor === null;
    out.push({
      id: thread.id,
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: anchorless && documentLevel === "global" ? "GLOBAL_COMMENT" : "COMMENT",
      ...(thread.text !== undefined ? { text: thread.text } : {}),
      originalText,
      createdA: typeof thread.createdA === "number" && Number.isFinite(thread.createdA) ? thread.createdA : 0,
      ...(thread.author !== undefined ? { author: thread.author } : {}),
      ...(thread.images && thread.images.length > 0 ? { images: thread.images.map((image) => ({ ...image })) } : {}),
      ...(htmlAnchor !== null ? { htmlAnchor } : {}),
      ...(htmlAdditionalTargets.length > 0 ? { htmlAdditionalTargets } : {}),
    });
  }
  return out;
}
