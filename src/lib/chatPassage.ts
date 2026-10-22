/**
 * The DOM side of an annotation's passage (lib/chatHighlights.ts holds the pure part): a message's
 * words read from its text nodes, a selection's anchor in them, and the Range a saved passage
 * stands at. The marks (ChatAnnotationMarks.tsx), a tap on one, and a sent card's jump to its
 * passage all find it through `passageMatch`.
 */
import { anchorOf, flatOffset, flattenText, resolvePassage, textPieces, type FlatText, type TextAnchor, type WalkNode } from "./chatHighlights.ts";

// the message's words, not a control's name or a field's text, nor the cards of feedback sent
// with it. A file path the Markdown draws as a button is words: a selection takes it in
export const NOT_WORDS = "button:not(.markdown-file), input, textarea, [contenteditable], .chat-feedback";
const skip = (node: WalkNode): boolean => (node as unknown as Element).matches(NOT_WORDS);

/** The message's words as one normalized text, and the text nodes its points count in. */
function messageText(message: Element): { flat: FlatText; nodes: readonly (Text | null)[] } {
  const { pieces, nodes } = textPieces(message as unknown as WalkNode, skip);
  return { flat: flattenText(pieces), nodes: nodes as unknown as (Text | null)[] };
}

/** Where a range's start (`end` false) or end stands among the message's text nodes. */
function rangePoint(nodes: readonly (Text | null)[], range: Range, end: boolean): { node: number; offset: number } | null {
  const container = end ? range.endContainer : range.startContainer;
  const offset = end ? range.endOffset : range.startOffset;
  const own = nodes.indexOf(container as Text);
  if (own >= 0) return { node: own, offset };
  // a boundary between elements: the first text node after it, or the last one before it
  const inside = (node: Text | null): boolean => node !== null && range.intersectsNode(node);
  let index = nodes.findIndex(inside);
  if (end) for (let at = nodes.length - 1; at >= 0; at -= 1) if (inside(nodes[at] ?? null)) { index = at; break; }
  if (index < 0) return null;
  return { node: index, offset: end ? (nodes[index] as Text).length : 0 };
}

/** The anchor of a selection inside `message`, read while it still stands; undefined when it holds none of its words. */
export function selectionAnchor(message: Element, range: Range): TextAnchor | undefined {
  const { flat, nodes } = messageText(message);
  const start = rangePoint(nodes, range, false);
  const end = rangePoint(nodes, range, true);
  if (start === null || end === null) return undefined;
  return anchorOf(flat, flatOffset(flat, start), flatOffset(flat, end)) ?? undefined;
}

/** Where the passage stands in the message: by its anchor, else by its words when they stand in one place only. */
export function passageMatch(message: Element, quote: string, anchor?: TextAnchor): Range | "ambiguous" | null {
  const { flat, nodes } = messageText(message);
  const span = resolvePassage(flat, quote, anchor);
  if (span === null || span === "ambiguous") return span;
  const range = document.createRange();
  range.setStart(nodes[span.start.node] as Text, span.start.offset);
  range.setEnd(nodes[span.end.node] as Text, span.end.offset);
  return range;
}

export function passageRange(message: Element, quote: string, anchor?: TextAnchor): Range | null {
  const match = passageMatch(message, quote, anchor);
  return match === "ambiguous" ? null : match;
}
