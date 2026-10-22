import { describe, expect, it } from "bun:test";

import { addAnnotation, clearAnnotations, composeWithAnnotations, formatAnnotationsMarkdown, getAnnotations, getSentAnnotations, markAnnotationsSent, removeAnnotation, subscribeAnnotations, updateAnnotation, type ChatAnnotation } from "./chatAnnotations.ts";

let keys = 0;
/** A conversation no other test touches: the store is shared by the whole module. */
function freshKey(): string {
  keys += 1;
  return `pane-test-${keys}`;
}

function annotation(fields: Partial<ChatAnnotation>): ChatAnnotation {
  return { id: "a", source: "agent", quote: "quoted", comment: "noted", createdAt: 1, ...fields };
}

describe("formatAnnotationsMarkdown", () => {
  it("returns nothing for no annotations", () => {
    expect(formatAnnotationsMarkdown([])).toBe("");
  });

  it("formats one agent annotation with its context", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "Use a map here", comment: "Why not a set?", context: "message 4 · 14:32" })])).toBe(
      "## Annotation 1\n**On agent message** (message 4 · 14:32)\n\nComment on:\n> Use a map here\n\nUser comment:\n> Why not a set?",
    );
  });

  it("labels the user's own messages and leaves out a missing or blank context", () => {
    expect(formatAnnotationsMarkdown([annotation({ source: "user", quote: "q", comment: "c" })])).toBe(
      "## Annotation 1\n**On your message**\n\nComment on:\n> q\n\nUser comment:\n> c",
    );
    expect(formatAnnotationsMarkdown([annotation({ context: "  " })])).toStartWith("## Annotation 1\n**On agent message**\n");
  });

  it("quotes every line of a multi-line quote and comment", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "one\ntwo\n\nfour", comment: "first\nsecond" })])).toBe(
      "## Annotation 1\n**On agent message**\n\nComment on:\n> one\n> two\n>\n> four\n\nUser comment:\n> first\n> second",
    );
  });

  it("drops CRs, trailing spaces and blank edge lines", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "\r\n  indented  \r\nnext\t\r\n\r\n", comment: "ok \n" })])).toBe(
      "## Annotation 1\n**On agent message**\n\nComment on:\n>   indented\n> next\n\nUser comment:\n> ok",
    );
  });

  it("numbers several annotations oldest first", () => {
    const text = formatAnnotationsMarkdown([
      annotation({ id: "b", quote: "later", createdAt: 20 }),
      annotation({ id: "a", source: "user", quote: "earlier", createdAt: 10 }),
    ]);
    expect(text).toBe(
      "## Annotation 1\n**On your message**\n\nComment on:\n> earlier\n\nUser comment:\n> noted\n\n"
      + "## Annotation 2\n**On agent message**\n\nComment on:\n> later\n\nUser comment:\n> noted",
    );
  });
});

describe("composeWithAnnotations", () => {
  const block = formatAnnotationsMarkdown([annotation({})]);

  it("puts the typed text first, then the annotations", () => {
    expect(composeWithAnnotations("  overall thoughts \n", [annotation({})])).toBe(`overall thoughts\n\n${block}`);
  });

  it("sends just the block when nothing is typed", () => {
    expect(composeWithAnnotations("", [annotation({})])).toBe(block);
    expect(composeWithAnnotations(" \n ", [annotation({})])).toBe(block);
  });

  it("leaves the text as it is without annotations", () => {
    expect(composeWithAnnotations("  as typed ", [])).toBe("  as typed ");
  });
});

describe("annotation store", () => {
  it("adds, updates, removes and clears a conversation's annotations", () => {
    const key = freshKey();
    expect(getAnnotations(key)).toEqual([]);
    const first = addAnnotation(key, { source: "agent", quote: "q1", comment: "c1", context: "message 1" });
    const second = addAnnotation(key, { source: "user", quote: "q2", comment: "c2" });
    expect(first.id).not.toBe(second.id);
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
    expect(getAnnotations(key).map((a) => a.quote)).toEqual(["q1", "q2"]);

    updateAnnotation(key, first.id, { comment: "changed", tag: "nit" });
    expect(getAnnotations(key)[0]).toEqual({ ...first, comment: "changed", tag: "nit" });

    removeAnnotation(key, first.id);
    expect(getAnnotations(key).map((a) => a.id)).toEqual([second.id]);

    clearAnnotations(key);
    expect(getAnnotations(key)).toEqual([]);
  });

  it("keeps each conversation's annotations apart", () => {
    const one = freshKey();
    const two = freshKey();
    const kept = addAnnotation(one, { source: "agent", quote: "a", comment: "b" });
    addAnnotation(two, { source: "agent", quote: "c", comment: "d" });
    clearAnnotations(two);
    removeAnnotation(two, kept.id);
    updateAnnotation(two, kept.id, { comment: "not here" });
    expect(getAnnotations(one)).toEqual([kept]);
    expect(getAnnotations(two)).toEqual([]);
  });

  it("returns the same array until something changes", () => {
    const key = freshKey();
    const empty = getAnnotations(key);
    expect(getAnnotations(key)).toBe(empty);
    const added = addAnnotation(key, { source: "agent", quote: "q", comment: "c" });
    const after = getAnnotations(key);
    expect(after).not.toBe(empty);
    expect(getAnnotations(key)).toBe(after);
    updateAnnotation(key, "missing", { comment: "x" });
    removeAnnotation(key, "missing");
    expect(getAnnotations(key)).toBe(after);
    updateAnnotation(key, added.id, { comment: "x" });
    expect(getAnnotations(key)).not.toBe(after);
  });

  it("tells a conversation's listeners of each change until they unsubscribe", () => {
    const key = freshKey();
    const other = freshKey();
    let calls = 0;
    let otherCalls = 0;
    const unsubscribe = subscribeAnnotations(key, () => { calls += 1; });
    const unsubscribeOther = subscribeAnnotations(other, () => { otherCalls += 1; });

    const added = addAnnotation(key, { source: "agent", quote: "q", comment: "c" });
    updateAnnotation(key, added.id, { comment: "c2" });
    removeAnnotation(key, added.id);
    addAnnotation(key, { source: "user", quote: "q", comment: "c" });
    clearAnnotations(key);
    expect(calls).toBe(5);

    // nothing changed: no one is told
    clearAnnotations(key);
    removeAnnotation(key, "missing");
    updateAnnotation(key, "missing", { comment: "x" });
    expect(calls).toBe(5);
    expect(otherCalls).toBe(0);

    unsubscribe();
    addAnnotation(key, { source: "agent", quote: "q", comment: "c" });
    expect(calls).toBe(5);
    unsubscribeOther();
  });

  it("moves sent annotations out of the pending ones, in their order", () => {
    const key = freshKey();
    let calls = 0;
    const unsubscribe = subscribeAnnotations(key, () => { calls += 1; });
    const first = addAnnotation(key, { source: "agent", quote: "q1", comment: "c1", turnTs: "2026-10-22T10:00:00Z" });
    const second = addAnnotation(key, { source: "user", quote: "q2", comment: "c2" });
    const third = addAnnotation(key, { source: "agent", quote: "q3", comment: "c3" });
    calls = 0;
    const emptySent = getSentAnnotations(key);

    markAnnotationsSent(key, [third.id, first.id]);
    expect(calls).toBe(1);
    expect(getAnnotations(key)).toEqual([second]);
    expect(getSentAnnotations(key)).toEqual([first, third]);
    expect(getSentAnnotations(key)).not.toBe(emptySent);

    // nothing pending by those ids: nothing changes
    const sent = getSentAnnotations(key);
    markAnnotationsSent(key, [first.id, "missing"]);
    markAnnotationsSent(key, []);
    expect(calls).toBe(1);
    expect(getSentAnnotations(key)).toBe(sent);

    markAnnotationsSent(key, [second.id]);
    expect(getAnnotations(key)).toEqual([]);
    expect(getSentAnnotations(key).map((a) => a.id)).toEqual([first.id, third.id, second.id]);
    // clearing the pending ones keeps what was sent
    clearAnnotations(key);
    expect(getSentAnnotations(key)).toHaveLength(3);
    expect(getSentAnnotations(freshKey())).toEqual([]);
    unsubscribe();
  });
});
