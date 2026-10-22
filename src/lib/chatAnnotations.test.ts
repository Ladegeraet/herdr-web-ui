import { describe, expect, it } from "bun:test";

import { addAnnotation, annotationChipLabel, clearAnnotations, composeWithAnnotations, formatAnnotationsMarkdown, getAnnotations, getSentAnnotations, markAnnotationsSent, planAnnotatedSend, removeAnnotation, subscribeAnnotations, updateAnnotation, type ChatAnnotation } from "./chatAnnotations.ts";

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

  it("formats one agent annotation with its time, as one piece of feedback", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "Use a map here", comment: "Why not a set?", context: "14:32" })])).toBe(
      "# Message Feedback\n\nI've reviewed this conversation and have 1 piece of feedback:\n\n"
      + "## 1. (agent message, 14:32) Feedback on: \"Use a map here\"\n> Why not a set?\n\n---",
    );
  });

  it("labels the user's own messages and leaves out a missing or blank context", () => {
    expect(formatAnnotationsMarkdown([annotation({ source: "user", quote: "q", comment: "c" })])).toContain('## 1. (your message) Feedback on: "q"\n> c\n');
    expect(formatAnnotationsMarkdown([annotation({ context: "  " })])).toContain('## 1. (agent message) Feedback on: "quoted"\n');
  });

  it("numbers several annotations oldest first, as pieces of feedback", () => {
    const text = formatAnnotationsMarkdown([
      annotation({ id: "b", quote: "later", createdAt: 20, context: "14:35" }),
      annotation({ id: "a", source: "user", quote: "earlier", createdAt: 10, context: "14:32" }),
    ]);
    expect(text).toBe(
      "# Message Feedback\n\nI've reviewed this conversation and have 2 pieces of feedback:\n\n"
      + "## 1. (your message, 14:32) Feedback on: \"earlier\"\n> noted\n\n"
      + "## 2. (agent message, 14:35) Feedback on: \"later\"\n> noted\n\n---",
    );
  });

  it("gives a passage only flagged its heading alone", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "flagged", comment: " \n " }), annotation({ quote: "next", createdAt: 2 })])).toContain(
      '## 1. (agent message) Feedback on: "flagged"\n\n## 2. (agent message) Feedback on: "next"\n> noted\n\n---',
    );
  });

  it("quotes every line of a multi-line comment", () => {
    expect(formatAnnotationsMarkdown([annotation({ comment: "first\n\nsecond \r\n" })])).toContain('Feedback on: "quoted"\n> first\n>\n> second\n\n---');
  });

  it("puts a multi-line quote in a fenced block, whole", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "\r\n  indented  \r\nnext\t\r\n\r\n", comment: "ok \n" })])).toContain(
      "## 1. (agent message) Feedback on:\n```\n  indented\nnext\n```\n> ok\n\n---",
    );
  });

  it("puts a long quote in a fenced block without cutting it", () => {
    const long = "word ".repeat(60).trim();
    expect(formatAnnotationsMarkdown([annotation({ quote: long })])).toContain(`Feedback on:\n\`\`\`\n${long}\n\`\`\`\n> noted`);
    const inline = "x".repeat(200);
    expect(formatAnnotationsMarkdown([annotation({ quote: inline })])).toContain(`Feedback on: "${inline}"\n`);
  });

  it("fences a quote holding backticks with a longer fence", () => {
    expect(formatAnnotationsMarkdown([annotation({ quote: "a\n```ts\nb" })])).toContain("Feedback on:\n````\na\n```ts\nb\n````\n> noted");
  });
});

describe("composeWithAnnotations", () => {
  const block = formatAnnotationsMarkdown([annotation({})]);

  it("puts the typed text first, then the annotations", () => {
    expect(composeWithAnnotations("  overall thoughts \n", [annotation({})])).toBe(`overall thoughts\n\n${block}`);
    expect(composeWithAnnotations("Overall: fine.", [annotation({})])).toStartWith("Overall: fine.\n\n# Message Feedback\n\n");
  });

  it("sends just the block when nothing is typed", () => {
    expect(composeWithAnnotations("", [annotation({})])).toBe(block);
    expect(composeWithAnnotations(" \n ", [annotation({})])).toBe(block);
  });

  it("leaves the text as it is without annotations", () => {
    expect(composeWithAnnotations("  as typed ", [])).toBe("  as typed ");
  });
});

describe("annotationChipLabel", () => {
  it("shows the comment on one line, or the quote without one", () => {
    expect(annotationChipLabel({ comment: "  why\nthis? ", quote: "q" })).toBe("why this?");
    expect(annotationChipLabel({ comment: " ", quote: "the\tquoted  text" })).toBe("the quoted text");
  });

  it("cuts a long one at the limit", () => {
    const label = annotationChipLabel({ comment: "a".repeat(100), quote: "" });
    expect(label).toHaveLength(64);
    expect(label.endsWith("…")).toBe(true);
    expect(annotationChipLabel({ comment: "b".repeat(64), quote: "" })).toBe("b".repeat(64));
  });
});

describe("planAnnotatedSend", () => {
  const list = [annotation({ id: "a", createdAt: 1 }), annotation({ id: "b", createdAt: 2 })];
  const now = { immediate: true, answering: false, max: 10_000 };

  it("sends the text as typed without annotations", () => {
    expect(planAnnotatedSend(" hi ", [], { ...now, answering: true })).toEqual({ kind: "send", message: " hi ", sentIds: [], heldBack: false });
  });

  it("appends the annotations to a message sent at once, and names them to mark sent", () => {
    expect(planAnnotatedSend("overall", list, now)).toEqual({ kind: "send", message: composeWithAnnotations("overall", list), sentIds: ["a", "b"], heldBack: false });
    expect(planAnnotatedSend("  ", list, now)).toEqual({ kind: "send", message: formatAnnotationsMarkdown(list), sentIds: ["a", "b"], heldBack: false });
  });

  it("holds them back from a queued message or an answer, and refuses one with nothing else in it", () => {
    expect(planAnnotatedSend("later", list, { ...now, immediate: false })).toEqual({ kind: "send", message: "later", sentIds: [], heldBack: true });
    expect(planAnnotatedSend("2", list, { ...now, answering: true })).toEqual({ kind: "send", message: "2", sentIds: [], heldBack: true });
    expect(planAnnotatedSend("", list, { ...now, immediate: false })).toEqual({ kind: "refuse", reason: "queued" });
    expect(planAnnotatedSend(" ", list, { ...now, immediate: false, answering: true })).toEqual({ kind: "refuse", reason: "question" });
  });

  it("refuses a message the annotations make too long", () => {
    const block = formatAnnotationsMarkdown(list);
    expect(planAnnotatedSend("", list, { ...now, max: block.length })).toMatchObject({ kind: "send" });
    expect(planAnnotatedSend("x", list, { ...now, max: block.length })).toEqual({ kind: "refuse", reason: "too-long" });
  });

  it("clears only what went, and only once it went", () => {
    const key = freshKey();
    const first = addAnnotation(key, { source: "agent", quote: "q1", comment: "c1" });
    const plan = planAnnotatedSend("go", getAnnotations(key), now);
    // added while the message was on its way: not in it
    const during = addAnnotation(key, { source: "user", quote: "q2", comment: "c2" });
    // a refused or queued send marks nothing: the annotations stay
    expect(getAnnotations(key)).toEqual([first, during]);
    if (plan.kind !== "send") throw new Error("expected a send");
    markAnnotationsSent(key, plan.sentIds);
    expect(getAnnotations(key)).toEqual([during]);
    expect(getSentAnnotations(key)).toEqual([first]);
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
