/**
 * Marks the passages the chat's annotations were made on (lib/chatAnnotations.ts): a solid tint
 * while pending, a paler one once sent, in the accent for a comment, green for an agreement and red
 * and struck through for a strike. Drawn with the CSS Custom Highlight API, so the
 * message's DOM stays React's and a virtualized row that mounts again is marked again; a browser
 * without it marks nothing. A tap on a pending passage opens its editor. Each passage is found in
 * the message it came from (`data-annotate-ts`) by its saved anchor (lib/chatHighlights.ts), or
 * its words alone when it has none; one that is not there, or not in one place only, or a message
 * scrolled out of the window, is skipped. A sent feedback card's quote lights its passage for a
 * moment (flashPassage).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import "./ChatAnnotationMarks.css";

import { useChatAnnotations, useSentAnnotations, type ChatAnnotation, type ChatAnnotationKind } from "../lib/chatAnnotations.ts";
import { NOT_WORDS, passageRange } from "../lib/chatPassage.ts";
import { AnnotationEditDialog } from "./ChatAnnotations.tsx";

const SUPPORTED = typeof Highlight === "function" && typeof CSS !== "undefined" && "highlights" in CSS;

type Marks = Record<ChatAnnotationKind, Highlight>;
const KINDS: readonly ChatAnnotationKind[] = ["comment", "approve", "reject"];

/** One set for the document, since `::highlight()` names are global (`chat-annotation-pending-approve`); each chat adds and removes its own ranges. */
let shared: { pending: Marks; sent: Marks } | null = null;
function highlights(): { pending: Marks; sent: Marks } {
  if (shared === null) {
    const make = (state: "pending" | "sent", priority: number): Marks => Object.fromEntries(KINDS.map((kind) => {
      const highlight = new Highlight();
      highlight.priority = priority;
      CSS.highlights.set(`chat-annotation-${state}-${kind}`, highlight);
      return [kind, highlight];
    })) as Marks;
    // a passage annotated again after a send shows as pending, whatever either's kind
    shared = { pending: make("pending", 1), sent: make("sent", 0) };
  }
  return shared;
}

function rangeOf(root: HTMLElement, annotation: ChatAnnotation): Range | null {
  if (!annotation.turnTs) return null;
  const message = root.querySelector(`[data-annotate-ts="${CSS.escape(annotation.turnTs)}"]`);
  return message === null ? null : passageRange(message, annotation.quote, annotation.anchor);
}

/** How long a passage jumped to from a sent card stays lit. */
const FLASH_MS = 1600;
let flashed: { range: Range; timer: ReturnType<typeof setTimeout> } | null = null;

/** Scrolls the passage into the middle of the chat and lights it briefly; without the API it only scrolls. */
export function flashPassage(range: Range): void {
  const start = range.startContainer;
  (start instanceof Element ? start : start.parentElement)?.scrollIntoView({ block: "center" });
  if (!SUPPORTED) return;
  let highlight = CSS.highlights.get("chat-annotation-flash");
  if (highlight === undefined) {
    highlight = new Highlight();
    // over the pending and sent marks of the same words
    highlight.priority = 2;
    CSS.highlights.set("chat-annotation-flash", highlight);
  }
  if (flashed !== null) {
    clearTimeout(flashed.timer);
    highlight.delete(flashed.range);
  }
  highlight.add(range);
  const lit = highlight;
  flashed = { range, timer: setTimeout(() => { lit.delete(range); flashed = null; }, FLASH_MS) };
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
        for (const kind of KINDS) {
          pendingMarks[kind].delete(range);
          sentMarks[kind].delete(range);
        }
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
        sentMarks[annotation.kind].add(range);
        own.push(range);
      }
      for (const annotation of pending) {
        const range = rangeOf(root, annotation);
        if (range === null) continue;
        pendingMarks[annotation.kind].add(range);
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
      if (event.target instanceof Element && event.target.closest(`a, summary, button, ${NOT_WORDS}`)) return;
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
