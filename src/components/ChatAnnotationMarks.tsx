/**
 * Marks the passages the chat's annotations were made on (lib/chatAnnotations.ts): a dotted
 * underline on a light tint while pending, a paler underline once sent. Drawn with the CSS Custom
 * Highlight API, so the message's DOM stays React's and a virtualized row that mounts again is
 * marked again; a browser without it marks nothing. A tap on a pending passage opens its editor.
 * Each quote is found by its words in the message it came from (`data-annotate-ts`), the first
 * match; one that is not there, or a message scrolled out of the window, is skipped.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import "./ChatAnnotationMarks.css";

import { useChatAnnotations, useSentAnnotations, type ChatAnnotation } from "../lib/chatAnnotations.ts";
import { findQuote } from "../lib/chatHighlights.ts";
import { AnnotationEditDialog } from "./ChatAnnotations.tsx";

const SUPPORTED = typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS;

/** One pair for the document, since `::highlight()` names are global; each chat adds and removes its own ranges. */
let shared: { pending: Highlight; sent: Highlight } | null = null;
function highlights(): { pending: Highlight; sent: Highlight } {
  if (shared === null) {
    const pending = new Highlight();
    // a passage annotated again after a send shows as pending
    pending.priority = 1;
    const sent = new Highlight();
    CSS.highlights.set("chat-annotation-pending", pending);
    CSS.highlights.set("chat-annotation-sent", sent);
    shared = { pending, sent };
  }
  return shared;
}

// the message's words, not a button's name or a field's text: what a selection could take
const NOT_WORDS = "button, input, textarea, [contenteditable]";

function textNodes(element: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(NOT_WORDS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function rangeOf(root: HTMLElement, annotation: ChatAnnotation): Range | null {
  if (!annotation.turnTs) return null;
  const message = root.querySelector(`[data-annotate-ts="${CSS.escape(annotation.turnTs)}"]`);
  if (message === null) return null;
  const nodes = textNodes(message);
  const span = findQuote(nodes.map((node) => node.data), annotation.quote);
  if (span === null) return null;
  const range = document.createRange();
  range.setStart(nodes[span.start.node] as Text, span.start.offset);
  range.setEnd(nodes[span.end.node] as Text, span.end.offset);
  return range;
}

const hits = (range: Range, x: number, y: number): boolean =>
  [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);

export function ChatAnnotationMarks({ root, storeKey }: { root: HTMLElement | null; storeKey: string }) {
  const pending = useChatAnnotations(storeKey);
  const sent = useSentAnnotations(storeKey);
  const [editing, setEditing] = useState<{ id: string; anchor: DOMRect } | null>(null);
  // the pending passages now marked, for a tap to find: a ref, so a streamed answer re-marks without a render
  const marked = useRef<ReadonlyMap<Range, string>>(new Map());

  useEffect(() => {
    if (!SUPPORTED || root === null || (pending.length === 0 && sent.length === 0)) return;
    const { pending: pendingMarks, sent: sentMarks } = highlights();
    let own: Range[] = [];
    let frame = 0;
    const clear = () => {
      for (const range of own) {
        pendingMarks.delete(range);
        sentMarks.delete(range);
      }
      own = [];
    };
    const apply = () => {
      frame = 0;
      clear();
      const byRange = new Map<Range, string>();
      for (const annotation of sent) {
        const range = rangeOf(root, annotation);
        if (range === null) continue;
        sentMarks.add(range);
        own.push(range);
      }
      for (const annotation of pending) {
        const range = rangeOf(root, annotation);
        if (range === null) continue;
        pendingMarks.add(range);
        own.push(range);
        byRange.set(range, annotation.id);
      }
      marked.current = byRange;
    };
    apply();
    // a streamed answer, a row the virtualizer mounts again: mark once per frame, after the change
    const observer = new MutationObserver(() => { if (frame === 0) frame = requestAnimationFrame(apply); });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clear();
      marked.current = new Map();
    };
  }, [pending, sent, root]);

  useEffect(() => {
    if (!SUPPORTED || root === null || pending.length === 0) return;
    const onClick = (event: MouseEvent) => {
      // a drag that selected, a long press: the selection is the user's, not a tap on a mark
      const selection = document.getSelection();
      if (selection !== null && !selection.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest(`a, summary, ${NOT_WORDS}`)) return;
      for (const [range, id] of marked.current) {
        if (!hits(range, event.clientX, event.clientY)) continue;
        setEditing({ id, anchor: range.getBoundingClientRect() });
        return;
      }
    };
    root.addEventListener("click", onClick);
    return () => { root.removeEventListener("click", onClick); };
  }, [pending.length, root]);

  const annotation = useMemo(() => (editing === null ? undefined : pending.find((item) => item.id === editing.id)), [editing, pending]);
  // deleted, or sent with a message, while its editor was open
  useEffect(() => { if (editing !== null && annotation === undefined) setEditing(null); }, [annotation, editing]);

  if (editing === null || annotation === undefined) return null;
  return <AnnotationEditDialog storeKey={storeKey} annotation={annotation} anchor={editing.anchor} onClose={() => { setEditing(null); }} />;
}
