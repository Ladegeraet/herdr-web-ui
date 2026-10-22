/**
 * Comments on text selected in the chat, collected per pane and handed back to the agent as one
 * Markdown message (lib/chatAnnotations.ts). Three parts:
 *
 * - `ChatAnnotator` watches the selection inside one chat. A selection within a single message
 *   (`data-annotate` on the turn) offers Comment: with a mouse beside the selection's end, on touch
 *   docked at the chat's foot, clear of the system's own selection menu and handles. The browser's
 *   selection and copy stay as they are; only a saved comment clears the selection.
 * - The comment editor: a popover under the selection on a desktop, the modal bottom sheet on a
 *   phone (`SHEET_QUERY`). What was selected is read when Comment is pressed, since focusing the
 *   comment's field collapses the selection.
 *   `AnnotationEditDialog` opens the same editor on a saved annotation, to change or delete it.
 * - `ChatAnnotationChips`, over the composer's card: one chip per comment, as an attachment, to edit
 *   or remove; past three they fold into one. The composer's own Send carries them (Composer.tsx).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, MessageSquarePlus, MessageSquareText, Trash2, X } from "lucide-react";

import "./ChatAnnotations.css";

import { addAnnotation, annotationChipLabel, clearAnnotations, removeAnnotation, updateAnnotation, useChatAnnotations, type ChatAnnotation, type ChatAnnotationSource } from "../lib/chatAnnotations.ts";
import { annotationContext, annotationSource, boxesMeet, popoverPlace, triggerPlace, type Box } from "../lib/chatSelection.ts";
import { useT } from "../lib/i18n.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import { quotedText } from "../lib/terminalQuote.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** What was selected, read while it still was. */
interface Selected {
  source: ChatAnnotationSource;
  quote: string;
  context?: string;
  turnTs?: string;
  /** the whole selection, and its last line: the popover goes under the one, Comment beside the other */
  box: Box;
  end: Box;
}

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);
const boxOf = (rect: DOMRect): Box => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });

/** The selection when it lies inside one message of `root`, else null. */
function readSelection(root: HTMLElement): Selected | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = elementOf(range.startContainer)?.closest<HTMLElement>("[data-annotate]");
  const end = elementOf(range.endContainer)?.closest<HTMLElement>("[data-annotate]");
  if (!start || start !== end || !root.contains(start)) return null;
  // a field's text, a button's name: not the message's words
  if (elementOf(range.commonAncestorContainer)?.closest("input, textarea, button, [contenteditable]")) return null;
  const source = annotationSource(start.dataset.annotate);
  // a drag from mid-line takes the space before a word: the quote starts at the word
  const quote = quotedText(selection.toString().trim());
  if (source === null || quote === null) return null;
  const lines = range.getClientRects();
  const last = lines[lines.length - 1] ?? range.getBoundingClientRect();
  // its end scrolled out of the chat: Comment would stand over other words, or the composer
  if (!boxesMeet(boxOf(last), boxOf(root.getBoundingClientRect()))) return null;
  return { source, quote, context: annotationContext(start.dataset.annotateTs), turnTs: start.dataset.annotateTs, box: boxOf(range.getBoundingClientRect()), end: boxOf(last) };
}

/** Docked Comment's gap to the chat's foot: clear of a phone's card that rises over the transcript (--composer-over) */
const DOCK_LIFT = 48;
const viewport = (): { width: number; height: number } => ({ width: window.innerWidth, height: window.innerHeight });

export function ChatAnnotator({ root, storeKey }: { root: HTMLElement | null; storeKey: string }) {
  const t = useT();
  const coarse = useMediaQuery("(pointer: coarse)");
  const [selected, setSelected] = useState<Selected | null>(null);
  const [editing, setEditing] = useState<Selected | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // a press on Comment can collapse the selection (iOS does, before the click): the press keeps it
  const pressing = useRef(false);
  // a mouse still dragging out the selection: Comment waits for the button to come up
  const dragging = useRef(false);

  useEffect(() => {
    if (root === null) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      if (dragging.current) return;
      const next = readSelection(root);
      if (next === null && pressing.current) return;
      setSelected(next);
    };
    // selectionchange comes in bursts (a drag, iOS's handles): one read per frame
    const schedule = (): void => { if (frame === 0) frame = window.requestAnimationFrame(update); };
    const down = (event: PointerEvent): void => {
      // iOS collapses the selection after the finger lifts, before the click: the press on Comment
      // holds it until the click; a press anywhere else lets it go
      if (!trigger.current?.contains(event.target as Node)) pressing.current = false;
      // only the main button drags out a selection: a right-click's menu can swallow its pointerup
      dragging.current = event.pointerType === "mouse" && event.button === 0 && root.contains(event.target as Node);
    };
    const up = (): void => { if (!dragging.current) return; dragging.current = false; schedule(); };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    // a drag the browser ended without a pointerup (a context menu, the window losing focus)
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("contextmenu", up, true);
    window.addEventListener("blur", up);
    // the chat scrolls under a selection: Comment follows its words
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("contextmenu", up, true);
      window.removeEventListener("blur", up);
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [root]);

  // on touch it is docked over the chat's foot; with a mouse beside the selection's end
  useLayoutEffect(() => {
    const button = trigger.current;
    if (selected === null || button === null || root === null) { setPlace(null); return; }
    const size = { width: button.offsetWidth, height: button.offsetHeight };
    if (coarse) {
      const frame = root.getBoundingClientRect();
      setPlace({ top: Math.min(frame.bottom, window.innerHeight) - size.height - DOCK_LIFT, left: frame.left + (frame.width - size.width) / 2 });
    } else setPlace(triggerPlace(selected.end, viewport(), size));
  }, [coarse, root, selected]);

  // with a keyboard, C opens the comment on what is selected, as Comment does
  useEffect(() => {
    if (selected === null || editing !== null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "c" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
      event.preventDefault();
      setEditing(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selected]);

  const close = useCallback(() => { setEditing(null); }, []);
  const save = useCallback((comment: string) => {
    if (editing === null) return;
    addAnnotation(storeKey, { source: editing.source, quote: editing.quote, comment, context: editing.context, turnTs: editing.turnTs });
    setEditing(null);
    setSelected(null);
    document.getSelection()?.removeAllRanges();
  }, [editing, storeKey]);

  return <>
    {selected !== null && editing === null && createPortal(
      <button ref={trigger} type="button" aria-keyshortcuts={coarse ? undefined : "C"} className={`btn chat-annotate-trigger${coarse ? " is-docked" : ""}`} style={place ?? { visibility: "hidden" }}
        onPointerDown={() => { pressing.current = true; }}
        onPointerCancel={() => { pressing.current = false; }}
        // the press must not take the focus or the selection from the message
        onMouseDown={(event) => { event.preventDefault(); }}
        onClick={() => { pressing.current = false; setEditing(selected); }}>
        <MessageSquarePlus aria-hidden="true" />{t("Comment")}
        {!coarse && <kbd className="kbd" aria-hidden="true">C</kbd>}
      </button>,
      document.body,
    )}
    {editing !== null && <AnnotationEditor title={t("Comment on selection")} quote={editing.quote} box={editing.box} onSave={save} onClose={close} />}
  </>;
}

interface EditorProps {
  title: string;
  quote: string;
  /** what the popover goes under; without one it opens as the modal */
  box: Box | null;
  initialComment?: string;
  onSave: (comment: string) => void;
  onClose: () => void;
  /** offered only for an annotation already saved */
  onDelete?: () => void;
}

function AnnotationEditor({ title, quote, box, initialComment = "", onSave, onClose, onDelete }: EditorProps) {
  const t = useT();
  const id = useId();
  const sheet = useMediaQuery(SHEET_QUERY);
  // a touch screen gets the modal (a sheet on a phone, a dialog on a tablet): a popover under the
  // selection would sit behind the on-screen keyboard, which iOS leaves out of innerHeight
  const coarse = useMediaQuery("(pointer: coarse)");
  const modal = sheet || coarse || box === null;
  const field = useRef<HTMLTextAreaElement>(null);
  // only the modal traps Tab; focus never goes back to the composer on touch, which would raise the keyboard
  const surface = useFocusTrap<HTMLDivElement>(modal, { initialFocus: field, shouldRestore: () => !coarse });
  const [comment, setComment] = useState(initialComment);
  // a comment being written or changed is never thrown away by a stray press or swipe; Escape,
  // Cancel and Back still discard it
  const written = comment.trim().length > 0 && comment !== initialComment;
  const writtenRef = useRef(written);
  writtenRef.current = written;
  useSheetSwipe(surface, sheet && !written ? onClose : null);
  useSheetHistory(sheet, onClose);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const empty = comment.trim().length === 0;

  useLayoutEffect(() => {
    const node = surface.current;
    if (modal || node === null || box === null) return;
    setPlace(popoverPlace(box, viewport(), { width: node.offsetWidth, height: node.offsetHeight }));
  }, [box, modal, surface]);
  // the popover is not modal and traps nothing: the field takes the focus once it is placed (a
  // field inside the hidden, unplaced popover would refuse it)
  const placed = place !== null;
  useEffect(() => { if (!modal && placed) field.current?.focus({ preventScroll: true }); }, [modal, placed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    // the popover is not modal: a press outside it closes it, as a menu's does, unless a comment is
    // written in it; Escape and Cancel still discard one
    const onPointer = (event: PointerEvent): void => {
      if (!modal && !writtenRef.current && !surface.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [modal, onClose, surface]);

  const onFieldKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!empty) onSave(comment.trim());
  };

  const body = <>
    <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
    <div className="modal-body chat-annotate-body">
      <blockquote className="chat-annotate-quote">{quote}</blockquote>
      <label className="visually-hidden" htmlFor={`${id}-comment`}>{t("Your comment")}</label>
      <textarea ref={field} id={`${id}-comment`} className="input chat-annotate-field" rows={3} value={comment}
        placeholder={t("What should the agent know about this?")}
        spellCheck autoCapitalize="sentences" autoCorrect="on"
        onChange={(event) => { setComment(event.target.value); }} onKeyDown={onFieldKey} />
    </div>
    <footer className="modal-footer">
      {onDelete && <button type="button" className="btn btn-ghost chat-annotate-delete" onClick={onDelete}><Trash2 aria-hidden="true" />{t("Delete")}</button>}
      <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
      <button type="button" className="btn btn-primary" disabled={empty} onClick={() => { onSave(comment.trim()); }}>{t("Save")}</button>
    </footer>
  </>;

  if (modal) {
    return createPortal(
      <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !writtenRef.current) onClose(); }}>
        <div ref={surface} className="modal chat-annotate-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>{body}</div>
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div ref={surface} className="menu chat-annotate-editor chat-annotate-popover" role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1} style={place ?? { visibility: "hidden" }}>{body}</div>,
    document.body,
  );
}

/** The editor for a saved annotation: change its comment or delete it. `anchor` places the popover. */
export function AnnotationEditDialog({ storeKey, annotation, anchor, onClose }: { storeKey: string; annotation: ChatAnnotation; anchor: DOMRect | null; onClose: () => void }) {
  const t = useT();
  const box = useMemo(() => (anchor === null ? null : boxOf(anchor)), [anchor]);
  const save = useCallback((comment: string) => { updateAnnotation(storeKey, annotation.id, { comment }); onClose(); }, [annotation.id, onClose, storeKey]);
  const remove = useCallback(() => { removeAnnotation(storeKey, annotation.id); onClose(); }, [annotation.id, onClose, storeKey]);
  return <AnnotationEditor title={t("Edit comment")} quote={annotation.quote} box={box} initialComment={annotation.comment} onSave={save} onClose={onClose} onDelete={remove} />;
}

/** Past this many the chips fold into one that says how many, and opens them. */
const CHIPS_SHOWN = 3;

/** The comments waiting for the next message, as chips over the composer's card: tap one to edit it, X to remove it. */
export function ChatAnnotationChips({ storeKey }: { storeKey: string }) {
  const t = useT();
  const annotations = useChatAnnotations(storeKey);
  const coarse = useMediaQuery("(pointer: coarse)");
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<{ id: string; anchor: DOMRect | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  // the place of the chip just removed: the focus goes on to the X now there, or the one before
  const [removedAt, setRemovedAt] = useState<number | null>(null);
  const count = annotations.length;
  // the composer's message box, kept from while the chips were there: they leave with the last one
  const row = useRef<HTMLDivElement | null>(null);
  const messageBox = useRef<HTMLTextAreaElement | null>(null);
  const held = useCallback((node: HTMLDivElement | null) => {
    row.current = node;
    if (node) messageBox.current = node.closest(".composer")?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
  }, []);
  // focus that had nowhere left to go goes on to the message box, but never on touch, where that raises the keyboard
  const refocus = useCallback(() => {
    const focused = document.activeElement;
    if (!coarse && (focused === null || focused === document.body)) messageBox.current?.focus({ preventScroll: true });
  }, [coarse]);
  const before = useRef(count);
  // the last one removed, sent or cleared folds the row again for the next ones
  useEffect(() => {
    const emptied = before.current > 0 && count === 0;
    before.current = count;
    if (!emptied) return;
    setExpanded(false);
    refocus();
  }, [count, refocus]);
  useEffect(() => {
    if (removedAt === null) return;
    setRemovedAt(null);
    const buttons = row.current?.querySelectorAll<HTMLElement>(".chat-annotation-chip-remove");
    const next = buttons?.[removedAt] ?? buttons?.[removedAt - 1];
    if (next) next.focus({ preventScroll: true });
    else refocus();
  }, [annotations, refocus, removedAt]);
  const closeEditor = useCallback(() => {
    const id = editing?.id;
    setEditing(null);
    // the popover traps nothing: the focus goes back to its chip, or on to the box once it is gone
    window.requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (coarse || (focused !== null && focused !== document.body)) return;
      const chip = [...(row.current?.querySelectorAll<HTMLElement>(".chat-annotation-chip-open") ?? [])].find((node) => node.dataset.annotation === id);
      if (chip) chip.focus({ preventScroll: true });
      else refocus();
    });
  }, [coarse, editing, refocus]);

  if (count === 0) return null;
  const many = count > CHIPS_SHOWN;
  const shown = !many || expanded;
  const annotation = editing === null ? undefined : annotations.find((item) => item.id === editing.id);
  return <div className="chat-annotations-bar" ref={held} role="group" aria-label={t("Comments for the next message")}>
    {many && <button type="button" className="chat-annotations-chip chat-annotations-summary" aria-expanded={expanded} onClick={() => { setExpanded((open) => !open); }}>
      <MessageSquareText aria-hidden="true" />{t("{n} comments", { n: count })}
      {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
    </button>}
    {many && <button type="button" className="btn btn-ghost chat-annotations-clear" onClick={() => { setConfirming(true); }}>{t("Clear all")}</button>}
    {shown && annotations.map((item, index) => <span key={item.id} className="chat-annotations-chip chat-annotation-chip">
      <button type="button" className="chat-annotation-chip-open" data-annotation={item.id} aria-haspopup="dialog" title={item.comment}
        onClick={(event) => { setEditing({ id: item.id, anchor: event.currentTarget.getBoundingClientRect() }); }}>
        <MessageSquareText aria-hidden="true" /><span className="chat-annotation-chip-text">{annotationChipLabel(item)}</span>
      </button>
      <button type="button" className="chat-annotation-chip-remove" aria-label={t("Remove comment {n}", { n: index + 1 })} title={t("Remove comment {n}", { n: index + 1 })}
        onClick={() => { removeAnnotation(storeKey, item.id); setRemovedAt(index); }}><X aria-hidden="true" /></button>
    </span>)}
    {annotation !== undefined && editing !== null && <AnnotationEditDialog storeKey={storeKey} annotation={annotation} anchor={editing.anchor} onClose={closeEditor} />}
    {confirming && <ConfirmDialog title={t("Clear all comments?")} body={t("Every comment collected for this chat is removed.")} confirmLabel={t("Clear all")}
      onConfirm={async () => { clearAnnotations(storeKey); setConfirming(false); }} onClose={() => { setConfirming(false); }} />}
  </div>;
}
