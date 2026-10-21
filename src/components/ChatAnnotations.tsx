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
 * - `ChatAnnotationsBar`, over the composer: the count, and a dialog to look through, remove, clear,
 *   insert into the message draft or send them.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, MessageSquareText, Trash2, X } from "lucide-react";

import "./ChatAnnotations.css";

import { addAnnotation, clearAnnotations, formatAnnotationsMarkdown, removeAnnotation, useChatAnnotations, type ChatAnnotationSource } from "../lib/chatAnnotations.ts";
import { annotationContext, annotationSource, boxesMeet, popoverPlace, triggerPlace, type Box } from "../lib/chatSelection.ts";
import { useT } from "../lib/i18n.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack, useSheetHistory } from "../lib/sheetHistory.ts";
import { quotedText } from "../lib/terminalQuote.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** What was selected, read while it still was. */
interface Selected {
  source: ChatAnnotationSource;
  quote: string;
  context?: string;
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
  return { source, quote, context: annotationContext(start.dataset.annotateTs), box: boxOf(range.getBoundingClientRect()), end: boxOf(last) };
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

  const close = useCallback(() => { setEditing(null); }, []);
  const save = useCallback((comment: string) => {
    if (editing === null) return;
    addAnnotation(storeKey, { source: editing.source, quote: editing.quote, comment, context: editing.context });
    setEditing(null);
    setSelected(null);
    document.getSelection()?.removeAllRanges();
  }, [editing, storeKey]);

  return <>
    {selected !== null && editing === null && createPortal(
      <button ref={trigger} type="button" className={`btn chat-annotate-trigger${coarse ? " is-docked" : ""}`} style={place ?? { visibility: "hidden" }}
        onPointerDown={() => { pressing.current = true; }}
        onPointerCancel={() => { pressing.current = false; }}
        // the press must not take the focus or the selection from the message
        onMouseDown={(event) => { event.preventDefault(); }}
        onClick={() => { pressing.current = false; setEditing(selected); }}>
        <MessageSquarePlus aria-hidden="true" />{t("Comment")}
      </button>,
      document.body,
    )}
    {editing !== null && <AnnotationEditor selected={editing} onSave={save} onClose={close} />}
  </>;
}

function AnnotationEditor({ selected, onSave, onClose }: { selected: Selected; onSave: (comment: string) => void; onClose: () => void }) {
  const t = useT();
  const id = useId();
  const sheet = useMediaQuery(SHEET_QUERY);
  // a touch screen gets the modal (a sheet on a phone, a dialog on a tablet): a popover under the
  // selection would sit behind the on-screen keyboard, which iOS leaves out of innerHeight
  const coarse = useMediaQuery("(pointer: coarse)");
  const modal = sheet || coarse;
  const field = useRef<HTMLTextAreaElement>(null);
  // only the modal traps Tab; focus never goes back to the composer on touch, which would raise the keyboard
  const surface = useFocusTrap<HTMLDivElement>(modal, { initialFocus: field, shouldRestore: () => !coarse });
  useSheetSwipe(surface, sheet ? onClose : null);
  useSheetHistory(sheet, onClose);
  const [comment, setComment] = useState("");
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const empty = comment.trim().length === 0;

  useLayoutEffect(() => {
    const node = surface.current;
    if (modal || node === null) return;
    setPlace(popoverPlace(selected.box, viewport(), { width: node.offsetWidth, height: node.offsetHeight }));
  }, [modal, selected, surface]);
  // the popover is not modal and traps nothing: the field takes the focus once it is placed (a
  // field inside the hidden, unplaced popover would refuse it)
  const placed = place !== null;
  useEffect(() => { if (!modal && placed) field.current?.focus({ preventScroll: true }); }, [modal, placed]);
  // read by the outside press: a comment being written is never thrown away by a stray click
  const written = useRef(false);
  written.current = comment.trim().length > 0;

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
      if (!modal && !written.current && !surface.current?.contains(event.target as Node)) onClose();
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
    <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Comment on selection")}</h2></header>
    <div className="modal-body chat-annotate-body">
      <blockquote className="chat-annotate-quote">{selected.quote}</blockquote>
      <label className="visually-hidden" htmlFor={`${id}-comment`}>{t("Your comment")}</label>
      <textarea ref={field} id={`${id}-comment`} className="input chat-annotate-field" rows={3} value={comment}
        placeholder={t("What should the agent know about this?")}
        spellCheck autoCapitalize="sentences" autoCorrect="on"
        onChange={(event) => { setComment(event.target.value); }} onKeyDown={onFieldKey} />
    </div>
    <footer className="modal-footer">
      <button type="button" className="btn" onClick={onClose}>{t("Cancel")}</button>
      <button type="button" className="btn btn-primary" disabled={empty} onClick={() => { onSave(comment.trim()); }}>{t("Save")}</button>
    </footer>
  </>;

  if (modal) {
    return createPortal(
      <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
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

interface BarProps {
  storeKey: string;
  sendDisabled: boolean;
  /** appends the Markdown to the message draft; a refusal's words, or null once it is there */
  onInsert: (markdown: string) => string | null;
  /** sends the Markdown as the user's message: true once it went out, else why not */
  onSend: (markdown: string) => Promise<true | string>;
}

/** The annotations collected for the composer's pane: a count over the card, and their dialog. */
export function ChatAnnotationsBar({ storeKey, sendDisabled, onInsert, onSend }: BarProps) {
  const t = useT();
  const annotations = useChatAnnotations(storeKey);
  const [open, setOpen] = useState(false);
  const coarse = useMediaQuery("(pointer: coarse)");
  const count = annotations.length;
  // the composer's message box, kept from while the chip was there: the chip leaves with the last one
  const messageBox = useRef<HTMLTextAreaElement | null>(null);
  const held = useCallback((node: HTMLDivElement | null) => {
    if (node) messageBox.current = node.closest(".composer")?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
  }, []);
  const before = useRef(count);
  // the last one removed, inserted, sent or cleared takes the dialog and the chip with it (the next
  // first one does not reopen it): the focus they held goes on to the message box, but never on
  // touch, where that raises the keyboard
  useEffect(() => {
    const emptied = before.current > 0 && count === 0;
    before.current = count;
    if (!emptied) return;
    setOpen(false);
    const focused = document.activeElement;
    if (!coarse && (focused === null || focused === document.body)) messageBox.current?.focus({ preventScroll: true });
  }, [coarse, count]);
  if (count === 0) return null;
  const label = count === 1 ? t("1 annotation") : t("{n} annotations", { n: count });
  return <div className="chat-annotations-bar" ref={held}>
    <button type="button" className="chat-annotations-chip" aria-haspopup="dialog" onClick={() => { setOpen(true); }}>
      <MessageSquareText aria-hidden="true" />{label}
    </button>
    {open && <AnnotationsDialog storeKey={storeKey} sendDisabled={sendDisabled} onInsert={onInsert} onSend={onSend} onClose={() => { setOpen(false); }} />}
  </div>;
}

function AnnotationsDialog({ storeKey, sendDisabled, onInsert, onSend, onClose }: BarProps & { onClose: () => void }) {
  const t = useT();
  const id = useId();
  const annotations = useChatAnnotations(storeKey);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // the place of the row just removed: the focus goes on to the Remove now there, or the one before
  const [removedAt, setRemovedAt] = useState<number | null>(null);
  const mounted = useRef(true);
  // set again on mount: StrictMode runs the cleanup once in development
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const surface = useFocusTrap<HTMLDivElement>(!confirming, { initialFocus: closeButton });
  useSheetSwipe(surface, sending || confirming ? null : onClose);
  usePhoneSheetBack(() => { if (sending) return false; onClose(); }, !confirming);

  useEffect(() => {
    if (confirming) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      if (!sending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirming, onClose, sending]);

  useEffect(() => {
    if (removedAt === null) return;
    setRemovedAt(null);
    const buttons = surface.current?.querySelectorAll<HTMLElement>(".chat-annotations-remove");
    (buttons?.[removedAt] ?? buttons?.[removedAt - 1] ?? surface.current)?.focus({ preventScroll: true });
  }, [annotations, removedAt, surface]);

  const markdown = formatAnnotationsMarkdown(annotations);
  const insert = (): void => {
    const refused = onInsert(markdown);
    if (refused !== null) { setError(refused); return; }
    clearAnnotations(storeKey);
    onClose();
  };
  const send = (): void => {
    setSending(true);
    setError(null);
    void onSend(markdown).then((result) => {
      if (result === true) { clearAnnotations(storeKey); if (mounted.current) onClose(); return; }
      if (mounted.current) setError(result);
    }).finally(() => { if (mounted.current) setSending(false); });
  };

  if (confirming) {
    return <ConfirmDialog title={t("Clear all annotations?")} body={t("Every comment collected for this chat is removed.")} confirmLabel={t("Clear all")}
      onConfirm={async () => { clearAnnotations(storeKey); onClose(); }} onClose={() => { setConfirming(false); }} />;
  }

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
      <div ref={surface} className="modal chat-annotations-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Annotations")}</h2>
          <button ref={closeButton} type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} disabled={sending} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body">
          <ol className="chat-annotations-list">
            {annotations.map((annotation, index) => <li key={annotation.id} className="chat-annotations-item">
              <div className="chat-annotations-item-head">
                <span className="chat-annotations-item-source">
                  {t(annotation.source === "agent" ? "On agent message" : "On your message")}
                  {annotation.context && <> · {annotation.context}</>}
                </span>
                <button type="button" className="icon-button chat-annotations-remove" aria-label={t("Remove annotation {n}", { n: index + 1 })} title={t("Remove annotation {n}", { n: index + 1 })} disabled={sending}
                  onClick={() => { removeAnnotation(storeKey, annotation.id); setRemovedAt(index); }}><Trash2 aria-hidden="true" /></button>
              </div>
              <blockquote className="chat-annotate-quote">{annotation.quote}</blockquote>
              <p className="chat-annotations-item-comment">{annotation.comment}</p>
            </li>)}
          </ol>
          {/* a refusal's own way on (Send anyway, clearing the box) is the composer's: the way there is Insert */}
          {error !== null && <p className="chat-annotations-error" role="alert">{error} {t("Use Insert into message to send them from the message box instead.")}</p>}
        </div>
        <footer className="modal-footer chat-annotations-footer">
          <button type="button" className="btn btn-ghost chat-annotations-clear" disabled={sending} onClick={() => { setConfirming(true); }}>{t("Clear all")}</button>
          <button type="button" className="btn" disabled={sending} onClick={insert}>{t("Insert into message")}</button>
          <button type="button" className="btn btn-primary" disabled={sending || sendDisabled} onClick={send}>{t("Send")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
