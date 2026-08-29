/**
 * Contract for the host-facing raw-HTML anchor helpers.
 *
 * `buildPersistedHtmlAnchor`: a host persists what it gets back, so the
 * failures to catch are (1) an in-bounds anchor being rewritten (a stored
 * anchor that no longer equals the composed one breaks host fingerprints),
 * (2) the product cap and the byte budget being confused for each other in
 * the drop counts, and (3) the budget eating the quote before the extras.
 *
 * `projectHostThreads`: the output order IS the marker numbering, so the
 * failures to catch are a reordered or dropped row, a resolved row painting,
 * and an anchor-only row being demoted to a document-level comment.
 */
import { describe, expect, test } from "bun:test";
import {
  buildPersistedHtmlAnchor,
  DEFAULT_HTML_ANCHOR_MAX_BYTES,
  MAX_HTML_ADDITIONAL_TARGETS,
  projectHostThreads,
  type HostThread,
} from "./html-anchor";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("buildPersistedHtmlAnchor", () => {
  test("an anchor already within every bound comes back byte-identical", () => {
    // Kept-target key order is text, label, anchor (the reference host's
    // wire order), so a stored anchor's serialization is stable on adoption.
    const input = {
      originalText: "Quoted text with an emoji \u{1F600}",
      htmlAnchor: { selector: "#hero > p:nth-of-type(2)", tagName: "p", text: "Quoted", point: { x: 0.25, y: 0.75 } },
      htmlAdditionalTargets: [
        { text: "Save", label: "Button", anchor: { selector: "button[data-testid=\"save\"]", tagName: "button", text: "Save" } },
        { text: "[element: img]" },
      ],
    };
    const result = buildPersistedHtmlAnchor(input);
    expect(JSON.stringify(result.anchor)).toBe(JSON.stringify(input));
    expect(result.droppedTargets).toBe(0);
    expect(result.capDroppedTargets).toBe(0);
    expect(result.sizeDroppedTargets).toBe(0);
    // A composer-ordered target (label first) is re-keyed to the wire order.
    const reordered = buildPersistedHtmlAnchor({
      originalText: "q",
      htmlAdditionalTargets: [{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button" } }],
    });
    expect(Object.keys(reordered.anchor.htmlAdditionalTargets![0]!)).toEqual(["text", "label", "anchor"]);
  });

  test("a drag capture without an element anchor writes exactly the legacy shape", () => {
    const result = buildPersistedHtmlAnchor({ originalText: "plain quote" });
    expect(result.anchor).toEqual({ originalText: "plain quote" });
    expect(Object.keys(result.anchor)).toEqual(["originalText"]);
  });

  test("a malformed element anchor fails closed to the text quote", () => {
    const result = buildPersistedHtmlAnchor({
      originalText: "quote",
      htmlAnchor: { selector: "", tagName: "p" },
    });
    expect(result.anchor).toEqual({ originalText: "quote" });
  });

  test("targets past maxTargets are dropped in draft order and counted against the cap only", () => {
    const targets = Array.from({ length: 10 }, (_, i) => ({ text: `Target ${i}` }));
    const result = buildPersistedHtmlAnchor({ originalText: "q", htmlAdditionalTargets: targets }, { maxTargets: 7 });
    expect(result.anchor.htmlAdditionalTargets?.map((t) => t.text)).toEqual(targets.slice(0, 7).map((t) => t.text));
    expect(result.capDroppedTargets).toBe(3);
    expect(result.sizeDroppedTargets).toBe(0);
  });

  test("the default cap is the viewer's 16", () => {
    const targets = Array.from({ length: 20 }, (_, i) => ({ text: `Target ${i}` }));
    const result = buildPersistedHtmlAnchor({ originalText: "q", htmlAdditionalTargets: targets });
    expect(result.anchor.htmlAdditionalTargets?.length).toBe(MAX_HTML_ADDITIONAL_TARGETS);
    expect(result.capDroppedTargets).toBe(4);
  });

  test("the byte budget truncates the quote to its useful floor before shedding targets", () => {
    // 16 in-bounds targets of 400 chars each (~6.9 KB) plus a 12 KB quote
    // overflow the default 16 KiB budget by well under the quote's slack
    // above the 400-char floor, so the quote alone absorbs the squeeze.
    const targets = Array.from({ length: 16 }, (_, i) => ({
      label: `Target ${i}`,
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(40) },
    }));
    const result = buildPersistedHtmlAnchor({
      originalText: "q".repeat(12_000),
      htmlAdditionalTargets: targets,
    });
    expect(bytes(result.anchor)).toBeLessThanOrEqual(DEFAULT_HTML_ANCHOR_MAX_BYTES);
    expect(result.anchor.htmlAdditionalTargets?.length).toBe(16);
    expect(result.sizeDroppedTargets).toBe(0);
    expect(result.capDroppedTargets).toBe(0);
    // A prefix, so text-search restore still matches it in the document.
    expect(result.anchor.originalText.length).toBeGreaterThanOrEqual(400);
    expect("q".repeat(12_000).startsWith(result.anchor.originalText)).toBe(true);
  });

  test("below the quote floor, targets are shed from the end and counted as size drops", () => {
    const targets = Array.from({ length: 16 }, (_, i) => ({
      label: `Target ${i}`,
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(400) },
    }));
    const result = buildPersistedHtmlAnchor(
      { originalText: "q".repeat(400), htmlAdditionalTargets: targets },
      { maxBytes: 4096 },
    );
    expect(bytes(result.anchor)).toBeLessThanOrEqual(4096);
    // The quote survives at its floor: the squeeze cost targets, not the quote.
    expect(result.anchor.originalText).toBe("q".repeat(400));
    const kept = result.anchor.htmlAdditionalTargets ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(16);
    expect(kept.map((t) => t.label)).toEqual(targets.slice(0, kept.length).map((t) => t.label));
    expect(result.sizeDroppedTargets).toBe(16 - kept.length);
    expect(result.capDroppedTargets).toBe(0);
  });

  test("a cap drop and a size drop are reported separately on the same anchor", () => {
    const targets = Array.from({ length: 12 }, (_, i) => ({
      text: "t".repeat(400),
      anchor: { selector: `#target-${i}`, tagName: "div", text: "t".repeat(400) },
    }));
    const result = buildPersistedHtmlAnchor(
      { originalText: "q".repeat(400), htmlAdditionalTargets: targets },
      { maxTargets: 7, maxBytes: 3000 },
    );
    expect(result.capDroppedTargets).toBe(5);
    expect(result.sizeDroppedTargets).toBeGreaterThan(0);
    expect((result.anchor.htmlAdditionalTargets?.length ?? 0) + result.sizeDroppedTargets).toBe(7);
    expect(result.droppedTargets).toBe(result.capDroppedTargets + result.sizeDroppedTargets);
    expect(bytes(result.anchor)).toBeLessThanOrEqual(3000);
  });

  test("quote truncation never splits a surrogate pair", () => {
    const quote = "\u{1F600}".repeat(9_000); // 18,000 UTF-16 units, 4 bytes each
    const result = buildPersistedHtmlAnchor({ originalText: quote });
    expect(bytes(result.anchor)).toBeLessThanOrEqual(DEFAULT_HTML_ANCHOR_MAX_BYTES);
    const last = result.anchor.originalText.charCodeAt(result.anchor.originalText.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe("projectHostThreads", () => {
  const anchor = { selector: "#a", tagName: "p", text: "Alpha" };
  const rows: HostThread[] = [
    { id: "t1", originalText: "Alpha", htmlAnchor: anchor, state: "open", text: "first", createdA: 10 },
    { id: "t2", originalText: "Beta", state: "resolved", text: "second", createdA: 20 },
    { id: "t3", originalText: "", htmlAnchor: { selector: "img#chart", tagName: "img", text: "" }, state: "open", createdA: 30 },
    { id: "t4", originalText: "", state: "open", text: "document-level note", createdA: 40 },
    { id: "t5", originalText: "Gamma", state: "open", htmlAdditionalTargets: [{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button", text: "Go" } }] },
  ];

  test("output order is input order, which is the marker numbering", () => {
    expect(projectHostThreads(rows).map((a) => a.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  test("openOnly drops resolved rows and keeps rows without a state", () => {
    const projected = projectHostThreads([...rows, { id: "t6", originalText: "no state" }], { openOnly: true });
    expect(projected.map((a) => a.id)).toEqual(["t1", "t3", "t4", "t5", "t6"]);
  });

  test("an element anchor without quoted text stays a page COMMENT; nothing restorable projects GLOBAL by default", () => {
    const byId = new Map(projectHostThreads(rows).map((a) => [a.id, a]));
    expect(byId.get("t3")?.type).toBe("COMMENT");
    expect(byId.get("t3")?.htmlAnchor).toEqual({ selector: "img#chart", tagName: "img", text: "" });
    expect(byId.get("t4")?.type).toBe("GLOBAL_COMMENT");
    expect(byId.get("t4")?.htmlAnchor).toBeUndefined();
    expect(byId.get("t1")?.type).toBe("COMMENT");
  });

  test("documentLevel: 'unanchored' keeps nothing-restorable rows as textless page COMMENTs", () => {
    // The host that treats a document-level note as a comment that lost its
    // place opts in; the row then has an empty quote and no anchor, which is
    // exactly what the viewer's unanchored union reports.
    const byId = new Map(projectHostThreads(rows, { documentLevel: "unanchored" }).map((a) => [a.id, a]));
    expect(byId.get("t4")).toMatchObject({ type: "COMMENT", originalText: "" });
    expect(byId.get("t4")?.htmlAnchor).toBeUndefined();
    // Anchored and quoted rows are untouched by the mode.
    expect(byId.get("t3")?.type).toBe("COMMENT");
    expect(byId.get("t1")?.type).toBe("COMMENT");
    // The default and the explicit 'global' agree.
    expect(projectHostThreads(rows, { documentLevel: "global" })).toEqual(projectHostThreads(rows));
  });

  test("maxTargets caps additional targets on read; absent applies the viewer's 16", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `T${i}` }));
    const row: HostThread = { id: "m", originalText: "q", htmlAdditionalTargets: many };
    expect(projectHostThreads([row])[0]?.htmlAdditionalTargets?.length).toBe(16);
    expect(projectHostThreads([row], { maxTargets: 7 })[0]?.htmlAdditionalTargets?.map((t) => t.text))
      .toEqual(many.slice(0, 7).map((t) => t.text));
  });

  test("anchors and targets validate fail-closed; presentational fields ride through", () => {
    const projected = projectHostThreads([
      {
        id: "bad",
        originalText: "kept",
        htmlAnchor: { selector: "x".repeat(2000), tagName: "p" },
        htmlAdditionalTargets: [{ text: "" }, { text: "ok", anchor: { selector: "", tagName: "" } }],
        text: "body",
        author: "ramos",
        createdA: 5,
        images: [{ path: "https://x/y.png", name: "y.png" }],
      },
    ]);
    expect(projected[0]).toEqual({
      id: "bad",
      blockId: "",
      startOffset: 0,
      endOffset: 0,
      type: "COMMENT",
      text: "body",
      originalText: "kept",
      createdA: 5,
      author: "ramos",
      images: [{ path: "https://x/y.png", name: "y.png" }],
      htmlAdditionalTargets: [{ text: "ok" }],
    });
    const gamma = projectHostThreads(rows).find((a) => a.id === "t5");
    expect(gamma?.htmlAdditionalTargets).toEqual([{ label: "Button", text: "Go", anchor: { selector: "#go", tagName: "button", text: "Go" } }]);
  });

  test("is pure: the same input projects the same output and never mutates it", () => {
    const frozen = JSON.stringify(rows);
    const a = projectHostThreads(rows, { openOnly: true });
    const b = projectHostThreads(rows, { openOnly: true });
    expect(a).toEqual(b);
    expect(JSON.stringify(rows)).toBe(frozen);
  });
});
