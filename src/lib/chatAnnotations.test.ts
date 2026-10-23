import { describe, expect, it } from "bun:test";

import { addAnnotation, annotationChipLabel, clearAnnotations, composeWithAnnotations, formatAnnotationsMarkdown, getAnnotations, getSentAnnotations, markAnnotationsSent, parseAnnotationsBlock, sentAnnotationOf, planAnnotatedSend, removeAnnotation, subscribeAnnotations, updateAnnotation, type ChatAnnotation } from "./chatAnnotations.ts";

let keys = 0;
/** A conversation no other test touches: the store is shared by the whole module. */
function freshKey(): string {
  keys += 1;
  return `pane-test-${keys}`;
}

function annotation(fields: Partial<ChatAnnotation>): ChatAnnotation {
  return { id: "a", source: "agent", kind: "comment", quote: "quoted", comment: "noted", createdAt: 1, ...fields };
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

  it("writes a strike as Plannotator's deletion: the quote fenced, then why", () => {
    expect(formatAnnotationsMarkdown([annotation({ kind: "reject", quote: "Drop the cache", comment: "", context: "14:35" })])).toBe(
      "# Message Feedback\n\nI've reviewed this conversation and have 1 piece of feedback:\n\n"
      + "## 1. (agent message, 14:35) Remove this\n```\nDrop the cache\n```\n> I don't want this.\n\n---",
    );
    expect(formatAnnotationsMarkdown([annotation({ kind: "reject", quote: "a ``b``", comment: "Too risky.\nLater." })])).toContain(
      "## 1. (agent message) Remove this\n```\na ``b``\n```\n> Too risky.\n> Later.\n\n---",
    );
  });

  it("writes an agreement with Plannotator's label, its comment only when there is one", () => {
    expect(formatAnnotationsMarkdown([annotation({ kind: "approve", quote: "Ship it", comment: "", context: "14:36" })])).toContain(
      '## 1. (agent message, 14:36) [👍 Looks good] Feedback on: "Ship it"\n\n---',
    );
    expect(formatAnnotationsMarkdown([annotation({ kind: "approve", source: "user", quote: "Ship it", comment: "Yes, today." })])).toContain(
      '## 1. (your message) [👍 Looks good] Feedback on: "Ship it"\n> Yes, today.\n\n---',
    );
    expect(formatAnnotationsMarkdown([annotation({ kind: "approve", quote: "one\ntwo", comment: "" })])).toContain(
      "## 1. (agent message) [👍 Looks good] Feedback on:\n```\none\ntwo\n```\n\n---",
    );
  });

  it("numbers comments and verdicts in one list, oldest first", () => {
    expect(formatAnnotationsMarkdown([
      annotation({ id: "c", kind: "approve", quote: "Keep the retry", comment: "", createdAt: 3, context: "14:36" }),
      annotation({ id: "a", quote: "Use a map here", comment: "Why not a set?", createdAt: 1, context: "14:32" }),
      annotation({ id: "b", kind: "reject", quote: "Drop the cache", comment: "", createdAt: 2, context: "14:35" }),
    ])).toBe(
      "# Message Feedback\n\nI've reviewed this conversation and have 3 pieces of feedback:\n\n"
      + '## 1. (agent message, 14:32) Feedback on: "Use a map here"\n> Why not a set?\n\n'
      + "## 2. (agent message, 14:35) Remove this\n```\nDrop the cache\n```\n> I don't want this.\n\n"
      + '## 3. (agent message, 14:36) [👍 Looks good] Feedback on: "Keep the retry"\n\n---',
    );
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

describe("parseAnnotationsBlock", () => {
  const sent = (fields: Partial<ChatAnnotation>) => {
    const { source, kind, quote, comment, context } = annotation(fields);
    return { source, kind, quote, comment, ...(context === undefined ? {} : { context }) };
  };

  it("reads back what was typed and every annotation, in order", () => {
    const list = [
      annotation({ id: "a", quote: "Use a map here", comment: "Why not a set?", context: "14:32", createdAt: 1 }),
      annotation({ id: "b", source: "user", quote: 'a "quoted" word', comment: "first\n\nsecond", createdAt: 2 }),
      annotation({ id: "c", quote: "flagged only", comment: "", context: "06:03", createdAt: 3 }),
      annotation({ id: "d", quote: "line one\n  indented\n```ts\ncode", comment: "> nested\nok", context: "06:04", createdAt: 4 }),
      annotation({ id: "e", quote: "word ".repeat(60).trim(), createdAt: 5 }),
    ];
    expect(parseAnnotationsBlock(composeWithAnnotations("das ist ganz coolio", list))).toEqual({
      text: "das ist ganz coolio",
      annotations: list.map((item) => sent(item)),
    });
  });

  it("reads back every kind, with and without a comment, inline and fenced", () => {
    const list = [
      annotation({ id: "a", kind: "reject", quote: "Drop the cache", comment: "", context: "14:35", createdAt: 1 }),
      annotation({ id: "b", kind: "reject", source: "user", quote: "line one\n```\nline two", comment: "Too risky.\n\nLater.", createdAt: 2 }),
      annotation({ id: "c", kind: "approve", quote: "Keep the retry", comment: "", context: "14:36", createdAt: 3 }),
      annotation({ id: "d", kind: "approve", quote: "word ".repeat(60).trim(), comment: "Yes.", createdAt: 4 }),
      annotation({ id: "e", kind: "approve", quote: "one\ntwo", comment: "", createdAt: 5 }),
      annotation({ id: "f", quote: "Use a map here", comment: "Why not a set?", createdAt: 6 }),
      annotation({ id: "g", quote: "flagged only", comment: "", createdAt: 7 }),
    ];
    expect(parseAnnotationsBlock(composeWithAnnotations("mixed", list))).toEqual({ text: "mixed", annotations: list.map((item) => sent(item)) });
  });

  it("still reads a block sent before verdicts existed", () => {
    const v4 = "ok\n\n# Message Feedback\n\nI've reviewed this conversation and have 2 pieces of feedback:\n\n"
      + '## 1. (agent message, 14:32) Feedback on: "Use a map here"\n> Why not a set?\n\n'
      + "## 2. (your message) Feedback on:\n```\na\nb\n```\n\n---";
    expect(parseAnnotationsBlock(v4)).toEqual({
      text: "ok",
      annotations: [
        { source: "agent", kind: "comment", quote: "Use a map here", comment: "Why not a set?", context: "14:32" },
        { source: "user", kind: "comment", quote: "a\nb", comment: "" },
      ],
    });
  });

  it("reads nothing from a strike whose quote is not fenced", () => {
    expect(parseAnnotationsBlock("# Message Feedback\n\nI've reviewed this conversation and have 1 piece of feedback:\n\n## 1. (agent message) Remove this \"x\"\n> no\n\n---")).toBeNull();
  });

  it("reads a message that is only the block", () => {
    expect(parseAnnotationsBlock(composeWithAnnotations("", [annotation({})]))).toEqual({ text: "", annotations: [sent({})] });
  });

  it("reads a block whose line ends were changed to CRLF", () => {
    expect(parseAnnotationsBlock(composeWithAnnotations("hi", [annotation({})]).replace(/\n/g, "\r\n"))?.annotations).toEqual([sent({})]);
  });

  it("finds nothing in a message without a block", () => {
    expect(parseAnnotationsBlock("just a message")).toBeNull();
    expect(parseAnnotationsBlock("")).toBeNull();
    expect(parseAnnotationsBlock("# Message Feedback\n\nwritten by hand\n\n---")).toBeNull();
  });

  it("reads nothing from a block that does not read back whole", () => {
    const block = formatAnnotationsMarkdown([annotation({}), annotation({ id: "b", quote: "two", createdAt: 2 })]);
    expect(parseAnnotationsBlock(block.replace(/\n---$/, ""))).toBeNull();
    expect(parseAnnotationsBlock(`${block}\n\nmore words`)).toBeNull();
    expect(parseAnnotationsBlock(block.replace("## 2.", "## 3."))).toBeNull();
    expect(parseAnnotationsBlock(block.replace("2 pieces", "3 pieces"))).toBeNull();
    expect(parseAnnotationsBlock(block.replace("(agent message)", "(someone)"))).toBeNull();
    const fenced = formatAnnotationsMarkdown([annotation({ quote: "a\nb" })]);
    expect(parseAnnotationsBlock(fenced.replace("```\n> noted", "> noted"))).toBeNull();
    expect(parseAnnotationsBlock("# Message Feedback\n\nI've reviewed this conversation and have 0 pieces of feedback:\n\n---")).toBeNull();
  });

  it("takes a title typed above the block, or quoted in it, as words", () => {
    const quoted = annotation({ quote: "# Message Feedback\n\n---" });
    const message = composeWithAnnotations("# Message Feedback\n\nmy notes", [quoted]);
    expect(parseAnnotationsBlock(message)).toEqual({ text: "# Message Feedback\n\nmy notes", annotations: [sent(quoted)] });
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
  const now = { agent: true, plain: true, immediate: true, answering: false, max: 10_000 };

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

  it("never sends them where no agent runs: a shell would take `>` as a redirect", () => {
    expect(planAnnotatedSend("ls", list, { ...now, agent: false })).toEqual({ kind: "send", message: "ls", sentIds: [], heldBack: true });
    expect(planAnnotatedSend(" ", list, { ...now, agent: false })).toEqual({ kind: "refuse", reason: "no-agent" });
    // no agent outranks the other reasons, so the hint names what would let them go
    expect(planAnnotatedSend("", list, { ...now, agent: false, immediate: false, answering: true })).toEqual({ kind: "refuse", reason: "no-agent" });
    expect(planAnnotatedSend("ls", [], { ...now, agent: false })).toEqual({ kind: "send", message: "ls", sentIds: [], heldBack: false });
  });

  it("keeps them off a command, a shell escape or a memory line, and off a send over an open screen", () => {
    for (const typed of ["!echo hi", "  !ls", "/status", "/resume", "# remember this"]) {
      expect(planAnnotatedSend(typed, list, now)).toEqual({ kind: "send", message: typed, sentIds: [], heldBack: true });
    }
    expect(planAnnotatedSend("go on", list, { ...now, plain: false })).toEqual({ kind: "send", message: "go on", sentIds: [], heldBack: true });
    // a word that only holds the characters is a prompt
    expect(planAnnotatedSend("a/b and !c", list, now)).toMatchObject({ sentIds: ["a", "b"], heldBack: false });
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

  it("finds the sent annotation a feedback card stands for, with its anchor", () => {
    const key = freshKey();
    const anchor = { start: 4, end: 14, exact: "Fix it now", prefix: "Ok: ", suffix: "" };
    const first = addAnnotation(key, { source: "agent", quote: "Fix it\nnow", comment: "", turnTs: "2026-10-22T10:00:00Z", anchor });
    addAnnotation(key, { source: "user", quote: "Fix it now", comment: "" });
    expect(sentAnnotationOf(key, { source: "agent", kind: "comment", quote: "Fix it now", comment: "" })).toBeUndefined();
    markAnnotationsSent(key, getAnnotations(key).map((annotation) => annotation.id));
    // the card reads the quote back on one line; the side must match too
    expect(sentAnnotationOf(key, { source: "agent", kind: "comment", quote: "Fix it now", comment: "" })).toEqual(first);
    expect(sentAnnotationOf(key, { source: "agent", kind: "comment", quote: "Fix it later", comment: "" })).toBeUndefined();
    // a verdict on the same words is another annotation
    expect(sentAnnotationOf(key, { source: "agent", kind: "reject", quote: "Fix it now", comment: "" })).toBeUndefined();
  });

  it("adds a comment unless told the kind, and switches the kind on edit", () => {
    const key = freshKey();
    expect(addAnnotation(key, { source: "agent", quote: "q", comment: "" }).kind).toBe("comment");
    const verdict = addAnnotation(key, { source: "agent", kind: "reject", quote: "q", comment: "" });
    expect(verdict.kind).toBe("reject");
    updateAnnotation(key, verdict.id, { kind: "approve", comment: "fine" });
    expect(getAnnotations(key)[1]).toMatchObject({ kind: "approve", comment: "fine" });
  });
});
