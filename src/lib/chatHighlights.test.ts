import { describe, expect, it } from "bun:test";
import { findQuote } from "./chatHighlights.ts";

describe("findQuote", () => {
  it("finds a quote inside one node", () => {
    expect(findQuote(["Hello brave world"], "brave")).toEqual({ start: { node: 0, offset: 6 }, end: { node: 0, offset: 11 } });
  });

  it("follows a quote across nodes", () => {
    expect(findQuote(["Run ", "bun test", " now"], "Run bun test")).toEqual({ start: { node: 0, offset: 0 }, end: { node: 1, offset: 8 } });
  });

  it("matches the selection's line breaks against blocks with no whitespace between them", () => {
    expect(findQuote(["First paragraph.", "Second one."], "First paragraph.\n\nSecond")).toEqual({ start: { node: 0, offset: 0 }, end: { node: 1, offset: 6 } });
  });

  it("ignores indentation and runs of spaces on either side", () => {
    expect(findQuote(["if (a) {\n    return b;\n}"], "if (a) { return  b;")).toEqual({ start: { node: 0, offset: 0 }, end: { node: 0, offset: 22 } });
  });

  it("skips empty and whitespace-only nodes", () => {
    expect(findQuote(["", "  ", "\n", "word"], "word")).toEqual({ start: { node: 3, offset: 0 }, end: { node: 3, offset: 4 } });
  });

  it("takes the first of two matches", () => {
    expect(findQuote(["same", "and ", "same"], "same")).toEqual({ start: { node: 0, offset: 0 }, end: { node: 0, offset: 4 } });
  });

  it("answers null for a missing or blank quote", () => {
    expect(findQuote(["Hello world"], "goodbye")).toBeNull();
    expect(findQuote(["Hello world"], " \n ")).toBeNull();
    expect(findQuote([], "Hello")).toBeNull();
  });
});
