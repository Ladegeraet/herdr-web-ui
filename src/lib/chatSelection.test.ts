import { describe, expect, it } from "bun:test";

import { annotationContext, annotationSource, popoverPlace, triggerPlace } from "./chatSelection.ts";

const view = { width: 1000, height: 800 };

describe("annotationSource", () => {
  it("knows agent and user messages only", () => {
    expect(annotationSource("agent")).toBe("agent");
    expect(annotationSource("user")).toBe("user");
    expect(annotationSource("tool")).toBeNull();
    expect(annotationSource(undefined)).toBeNull();
  });
});

describe("annotationContext", () => {
  it("is the turn's local time, zero-padded", () => {
    const at = new Date(2026, 9, 21, 9, 5);
    expect(annotationContext(at.toISOString())).toBe("09:05");
  });

  it("is nothing without a readable time", () => {
    expect(annotationContext(null)).toBeUndefined();
    expect(annotationContext("")).toBeUndefined();
    expect(annotationContext("not a date")).toBeUndefined();
  });
});

describe("triggerPlace", () => {
  const size = { width: 100, height: 30 };

  it("sits under the selection's end, right edges aligned", () => {
    expect(triggerPlace({ top: 100, bottom: 120, left: 300, right: 500 }, view, size)).toEqual({ top: 126, left: 400 });
  });

  it("goes above the line at the screen's foot", () => {
    expect(triggerPlace({ top: 760, bottom: 780, left: 300, right: 500 }, view, size).top).toBe(724);
  });

  it("stays on screen", () => {
    expect(triggerPlace({ top: 100, bottom: 120, left: 0, right: 20 }, view, size).left).toBe(8);
    expect(triggerPlace({ top: -400, bottom: -380, left: 0, right: 500 }, view, size).top).toBe(8);
  });
});

describe("popoverPlace", () => {
  const size = { width: 360, height: 300 };

  it("opens under the selection with room there", () => {
    expect(popoverPlace({ top: 100, bottom: 140, left: 200, right: 600 }, view, size)).toEqual({ top: 146, left: 200 });
  });

  it("opens above when only the room above holds it", () => {
    expect(popoverPlace({ top: 600, bottom: 640, left: 200, right: 600 }, view, size).top).toBe(294);
  });

  it("is held inside the screen when neither side holds it", () => {
    const place = popoverPlace({ top: 250, bottom: 600, left: 900, right: 990 }, view, size);
    expect(place.left).toBe(632);
    expect(place.top).toBeGreaterThanOrEqual(8);
    expect(place.top + size.height).toBeLessThanOrEqual(792);
  });
});
