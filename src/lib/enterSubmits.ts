/**
 * Whether a key in a message field sends it (the composer) or saves it (an annotation's comment),
 * by the "Enter sends" setting: on, Enter does and Shift+Enter is a new line; off, Cmd/Ctrl+Enter
 * does and Enter is a new line. A touch screen follows the same setting (Settings words it "Return
 * inserts a new line" there). An IME keeps its keys: WebKit can send the committing Enter after
 * compositionend, as key code 229.
 */
export interface EnterKey {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

export function enterSubmits(event: EnterKey, enterSends: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  return enterSends
    ? !event.shiftKey && !event.metaKey && !event.ctrlKey
    : (event.metaKey || event.ctrlKey) && !event.shiftKey;
}

/** The shortcut that submits, for `aria-keyshortcuts`. */
export function enterSubmitShortcut(enterSends: boolean): string {
  return enterSends ? "Enter" : "Control+Enter Meta+Enter";
}
