import { describe, expect, it } from "bun:test";
import { anchorOf, findQuote, flatOffset, flattenText, looseWords, markdownLooseWords, resolvePassage, textPieces, type TextPiece, type TextSpan, type WalkNode } from "./chatHighlights.ts";

// a few plain objects in the shape of DOM nodes, for the walk
interface Model extends WalkNode { className: string; childNodes: Model[] }
const text = (value: string): Model => ({ nodeType: 3, nodeName: "#text", nodeValue: value, className: "", childNodes: [] });
const el = (tag: string, ...children: (Model | string)[]): Model => {
  const [name, className = ""] = tag.split(".");
  return { nodeType: 1, nodeName: (name as string).toUpperCase(), nodeValue: null, className, childNodes: children.map((child) => (typeof child === "string" ? text(child) : child)) };
};
// what the chat leaves out: a control's name, not a file path the Markdown draws as a button
const controls = (node: WalkNode): boolean => node.nodeName === "BUTTON" && !(node as Model).className.includes("markdown-file");
// what it left out before: every button
const everyButton = (node: WalkNode): boolean => node.nodeName === "BUTTON";
const fileLink = (path: string): Model => el("button.markdown-file", el("code", path));

/** The words a span covers, read from the pieces as a DOM Range would. */
function spanText(pieces: readonly TextPiece[], span: TextSpan): string {
  let out = "";
  for (let node = span.start.node; node <= span.end.node; node += 1) {
    const piece = pieces[node];
    if (piece === null || piece === undefined) continue;
    out += piece.slice(node === span.start.node ? span.start.offset : 0, node === span.end.node ? span.end.offset : piece.length);
  }
  return out;
}

/** The anchor a selection from the `from`th piece at `start` to the `to`th at `end` saves. */
function anchorFor(pieces: readonly TextPiece[], from: number, start: number, to: number, end: number) {
  const flat = flattenText(pieces);
  return anchorOf(flat, flatOffset(flat, { node: from, offset: start }), flatOffset(flat, { node: to, offset: end }));
}

// Tobi's message: bold lines of text, an en dash, parentheses and a file path in code, then
// lists with many code spans, under a work block and over the copy buttons
function tobisMessage(work = "Read 3 files"): Model {
  return el("article",
    el("section.work-block", el("button.work-block-head", work)),
    el("div.markdown",
      el("p", "Here is the review:"),
      el("p", el("strong", "182667 – Zoom stays after a type change (", fileLink("pdf_main_view.dart:56"), ") – confirmed, high priority")),
      el("ul", el("li", "Cause: ", el("code", "_zoom"), " is not reset in ", el("code", "didUpdateWidget")), el("li", "Fix: call ", el("code", "resetZoom()"))),
      el("p", el("strong", "182668 – First line sits lower when the text starts with a heading (", fileLink("vetos_rich_text_field.dart:149"), ") – confirmed")),
      el("ul", el("li", el("code", "TextAlign"), " and ", el("code", "strutStyle"), " checked"), el("li", "see ", el("code", "line_height.dart"))),
    ),
    el("div.chat-turn-meta", el("button.chat-meta-btn", "MD"), el("button.chat-meta-btn", "TXT")),
  );
}

const FIRST = "182667 – Zoom stays after a type change (pdf_main_view.dart:56) – confirmed, high priority";
const SECOND = "182668 – First line sits lower when the text starts with a heading (vetos_rich_text_field.dart:149) – confirmed";

describe("Tobi's two annotated lines", () => {
  it("were not found while the walk left out the file path a quote crosses", () => {
    // the root cause: the path is a <button class="markdown-file"> the walk skipped, so the
    // selection's text holds words the message's text did not
    const { pieces } = textPieces(tobisMessage(), everyButton);
    expect(findQuote(pieces, FIRST)).toBeNull();
    expect(findQuote(pieces, SECOND)).toBeNull();
    // a quote that stops before the path was found, so one line of two showed a mark
    expect(findQuote(pieces, "182668 – First line sits lower")).not.toBeNull();
  });

  it("are both found and marked once file paths count as words", () => {
    const { pieces } = textPieces(tobisMessage(), controls);
    for (const quote of [FIRST, SECOND]) {
      const span = findQuote(pieces, quote);
      expect(span).not.toBeNull();
      expect(spanText(pieces, span as TextSpan)).toBe(quote);
    }
  });

  it("keeps a control's name out of the words", () => {
    const { pieces } = textPieces(tobisMessage(), controls);
    expect(pieces).not.toContain("MD");
    expect(pieces).not.toContain("Read 3 files");
  });

  it("anchors two passages of one message, each to its own place", () => {
    const { pieces } = textPieces(tobisMessage(), controls);
    const lines = [FIRST, SECOND].map((quote) => {
      const from = pieces.indexOf(quote.slice(0, 6) === "182667" ? "182667 – Zoom stays after a type change (" : "182668 – First line sits lower when the text starts with a heading (");
      const to = pieces.findIndex((piece, index) => index > from && piece !== null && piece.startsWith(") – confirmed"));
      return { quote, anchor: anchorFor(pieces, from, 0, to, (pieces[to] as string).length) };
    });
    const flat = flattenText(pieces);
    for (const { quote, anchor } of lines) {
      expect(anchor?.exact).toBe(quote);
      const span = resolvePassage(flat, quote, anchor ?? undefined);
      expect(spanText(pieces, span as TextSpan)).toBe(quote);
    }
  });

  it("finds an anchored passage again after the text before it changed", () => {
    const { pieces } = textPieces(tobisMessage(), controls);
    const from = pieces.indexOf("182667 – Zoom stays after a type change (");
    const anchor = anchorFor(pieces, from, 9, from + 1, 13);
    expect(anchor?.exact).toBe("Zoom stays after a type change (pdf_main_view");
    // the work block opened and its rows count now: the saved offsets point elsewhere
    const opened = el("article", el("p", "Read src/pdf_main_view.dart and two more files"), ...tobisMessage().childNodes);
    const after = textPieces(opened, controls).pieces;
    const span = resolvePassage(flattenText(after), "Zoom stays after a type change (pdf_main_view", anchor ?? undefined);
    expect(spanText(after, span as TextSpan)).toBe("Zoom stays after a type change (pdf_main_view");
  });
});

describe("normalized text", () => {
  it("puts one space between blocks and collapses whitespace runs", () => {
    const { pieces } = textPieces(el("div", el("p", "One  line\n"), el("ul", el("li", "first"), el("li", " second ")), "tail"), () => false);
    expect(flattenText(pieces).text).toBe("One line first second tail");
  });

  it("reads a non-breaking space as a space", () => {
    const pieces = ["Price: 42 €"];
    expect(flattenText(pieces).text).toBe("Price: 42 €");
    expect(findQuote(pieces, "Price: 42 €")).toEqual({ start: { node: 0, offset: 0 }, end: { node: 0, offset: 11 } });
  });

  it("maps a point inside a whitespace run to the character after it", () => {
    const flat = flattenText(["a  ", null, " b"]);
    expect(flat.text).toBe("a b");
    expect(flatOffset(flat, { node: 0, offset: 2 })).toBe(2);
    expect(flatOffset(flat, { node: 2, offset: 2 })).toBe(3);
  });

  it("leaves spaces at an anchor's edges out", () => {
    const flat = flattenText(["alpha beta gamma"]);
    expect(anchorOf(flat, 5, 11)).toEqual({ start: 6, end: 10, exact: "beta", prefix: "alpha ", suffix: " gamma" });
    expect(anchorOf(flat, 5, 6)).toBeNull();
  });
});

describe("resolvePassage", () => {
  it("follows a selection across strong, code and plain text", () => {
    const { pieces } = textPieces(el("p", "Run ", el("strong", "the ", el("code", "bun test")), " suite – now"), () => false);
    const anchor = anchorFor(pieces, 1, 0, 3, 8);
    expect(anchor?.exact).toBe("the bun test suite –");
    const span = resolvePassage(flattenText(pieces), "the bun test suite –", anchor ?? undefined);
    expect(span).toEqual({ start: { node: 1, offset: 0 }, end: { node: 3, offset: 8 } });
  });

  it("finds a quote that spans two list items or paragraphs", () => {
    const { pieces } = textPieces(el("div", el("ul", el("li", "first item"), el("li", "second item")), el("p", "Next one.")), () => false);
    const span = findQuote(pieces, "item\nsecond item\n\nNext");
    expect(spanText(pieces, span as TextSpan)).toBe("itemsecond itemNext");
  });

  it("does not mark words that stand twice without a context to choose by", () => {
    const pieces = ["same", " and ", "same"];
    expect(resolvePassage(flattenText(pieces), "same")).toBe("ambiguous");
    expect(findQuote(pieces, "same")).toBeNull();
  });

  it("takes the saved place of words that stand twice", () => {
    const pieces = ["Fix it. Then ", "Fix it.", " Done."];
    const anchor = anchorFor(pieces, 1, 0, 1, 7);
    expect(resolvePassage(flattenText(pieces), "Fix it.", anchor ?? undefined)).toEqual({ start: { node: 1, offset: 0 }, end: { node: 1, offset: 7 } });
  });

  it("chooses between two places by their context once the offsets moved", () => {
    const pieces = ["Fix it. Then ", "Fix it.", " Done."];
    const anchor = anchorFor(pieces, 1, 0, 1, 7);
    const moved = ["New first line. ", ...pieces];
    expect(resolvePassage(flattenText(moved), "Fix it.", anchor ?? undefined)).toEqual({ start: { node: 2, offset: 0 }, end: { node: 2, offset: 7 } });
  });

  it("marks nothing when two places have the same context", () => {
    const pieces = ["a b a"];
    const anchor = { start: 40, end: 41, exact: "a", prefix: "x", suffix: "y" };
    expect(resolvePassage(flattenText(pieces), "a", anchor)).toBe("ambiguous");
  });

  it("answers null for words that are gone", () => {
    const anchor = anchorOf(flattenText(["Hello brave world"]), 6, 11);
    expect(resolvePassage(flattenText(["Hello world"]), "brave", anchor ?? undefined)).toBeNull();
  });
});

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

  it("answers null for a missing or blank quote", () => {
    expect(findQuote(["Hello world"], "goodbye")).toBeNull();
    expect(findQuote(["Hello world"], " \n ")).toBeNull();
    expect(findQuote([], "Hello")).toBeNull();
  });
});

describe("markdownLooseWords", () => {
  const finds = (markdown: string, quote: string): boolean => markdownLooseWords(markdown).includes(looseWords(quote));

  it("finds a quote across two bullets", () => {
    const markdown = "**182668 – Erste Zeile**\n\n- `TextAlign` applied twice in `_layoutFirstLine`\n- Remove the second call\n  * nested item";
    expect(finds(markdown, "applied twice in _layoutFirstLine\nRemove")).toBe(true);
    expect(finds(markdown, "second call\nnested")).toBe(true);
  });

  it("finds a quote across ordered list items and task boxes", () => {
    expect(finds("1. First step\n2) Second step\n10. Tenth", "First step\nSecond step\nTenth")).toBe(true);
    expect(finds("- [ ] open task\n- [x] done task", "open task\ndone task")).toBe(true);
  });

  it("finds a quote from a heading into a bullet, and through a blockquote", () => {
    expect(finds("## Second note – check `main.dart:12`\n\n- runApp wraps VetosApp", "check main.dart:12\n\nrunApp wraps")).toBe(true);
    expect(finds("> quoted line\n> > nested - 1. not a list", "quoted line\nnested - 1. not a list")).toBe(true);
  });

  it("finds a quote across table cells and rows", () => {
    const table = "| File | Line |\n| :--- | ---: |\n| `pdf_main_view.dart` | 56 |\n| editor.dart | 88 |";
    expect(finds(table, "Line\npdf_main_view.dart\t56\neditor.dart")).toBe(true);
  });

  it("drops link targets and fences but keeps a dash inside a line", () => {
    expect(finds("See [the docs](https://example.com/a) now", "See the docs now")).toBe(true);
    expect(finds("```ts\nconst a = 1;\n```\nAfter", "const a = 1;\nAfter")).toBe(true);
    expect(finds("a - b", "ab")).toBe(false);
    expect(finds("- Remove the call", "Remove the cal")).toBe(true);
  });
});
