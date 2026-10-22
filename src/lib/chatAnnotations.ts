import { useCallback, useSyncExternalStore } from "react";

/**
 * Comments the user pins to text they selected in a chat, collected per conversation (the pane
 * id) and handed back to the agent as Markdown. Held in memory only: a reload starts empty.
 */
export type ChatAnnotationSource = "agent" | "user";

export interface ChatAnnotation {
  id: string;
  source: ChatAnnotationSource;
  /** The selected text. */
  quote: string;
  comment: string;
  /** Where the quote came from, e.g. "message 4 · 14:32". */
  context?: string;
  /** The `data-annotate-ts` of the message the quote came from, to find it again in the chat. */
  turnTs?: string;
  /** Reserved; no UI sets it yet. */
  tag?: string;
  createdAt: number;
}

export type ChatAnnotationInput = Omit<ChatAnnotation, "id" | "createdAt">;

/** Each line of `text` as a Markdown quote line, without CRs, trailing spaces or blank edges. */
function quoteLines(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return ">";
  return lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
}

/** The annotations as one Markdown message, oldest first; "" when there are none. */
export function formatAnnotationsMarkdown(list: readonly ChatAnnotation[]): string {
  return [...list]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((annotation, index) => {
      const on = annotation.source === "agent" ? "**On agent message**" : "**On your message**";
      const context = annotation.context?.trim();
      return [
        `## Annotation ${index + 1}`,
        context ? `${on} (${context})` : on,
        "",
        "Comment on:",
        quoteLines(annotation.quote),
        "",
        "User comment:",
        quoteLines(annotation.comment),
      ].join("\n");
    })
    .join("\n\n");
}

/** The message as sent: the typed text first, then the annotations' block; `text` as is without any. */
export function composeWithAnnotations(text: string, list: readonly ChatAnnotation[]): string {
  if (list.length === 0) return text;
  const block = formatAnnotationsMarkdown(list);
  const typed = text.trim();
  return typed === "" ? block : `${typed}\n\n${block}`;
}

/**
 * What a Send from the composer carries. The annotations go only with a message delivered at once
 * and not as an answer to the agent's open question: one held in the queue, or taken as the
 * answer, goes as typed and they stay for the next. `sentIds` are those to mark sent once it went.
 */
export type AnnotatedSend =
  | { kind: "send"; message: string; sentIds: readonly string[]; heldBack: boolean }
  | { kind: "refuse"; reason: "question" | "queued" | "too-long" };

export function planAnnotatedSend(text: string, list: readonly ChatAnnotation[], { immediate, answering, max }: { immediate: boolean; answering: boolean; max: number }): AnnotatedSend {
  if (list.length === 0) return { kind: "send", message: text, sentIds: [], heldBack: false };
  if (answering || !immediate) {
    if (text.trim() === "") return { kind: "refuse", reason: answering ? "question" : "queued" };
    return { kind: "send", message: text, sentIds: [], heldBack: true };
  }
  const message = composeWithAnnotations(text, list);
  if (message.length > max) return { kind: "refuse", reason: "too-long" };
  return { kind: "send", message, sentIds: list.map((annotation) => annotation.id), heldBack: false };
}

/** A chip's words: the comment, or the quote when it has none, on one line and cut at `max` characters. */
export function annotationChipLabel(annotation: Pick<ChatAnnotation, "comment" | "quote">, max = 64): string {
  const words = (annotation.comment.trim() || annotation.quote).replace(/\s+/g, " ").trim();
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

const EMPTY: readonly ChatAnnotation[] = Object.freeze([]);
const store = new Map<string, readonly ChatAnnotation[]>();
/** Those already sent with a message, kept so the chat can still mark what they were on. */
const sentStore = new Map<string, readonly ChatAnnotation[]>();
const listeners = new Map<string, Set<() => void>>();
let lastId = 0;

function publish(key: string, next: readonly ChatAnnotation[]): void {
  if (next.length === 0) store.delete(key);
  else store.set(key, next);
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
}

/** The same array until the conversation's annotations change, as useSyncExternalStore needs. */
export function getAnnotations(key: string): readonly ChatAnnotation[] {
  return store.get(key) ?? EMPTY;
}

export function addAnnotation(key: string, input: ChatAnnotationInput): ChatAnnotation {
  lastId += 1;
  // createdAt never repeats within a conversation, so the oldest-first order stays the order added
  const latest = getAnnotations(key).reduce((max, annotation) => Math.max(max, annotation.createdAt), 0);
  const annotation: ChatAnnotation = { ...input, id: `annotation-${Date.now().toString(36)}-${lastId}`, createdAt: Math.max(Date.now(), latest + 1) };
  publish(key, [...getAnnotations(key), annotation]);
  return annotation;
}

export function updateAnnotation(key: string, id: string, patch: Partial<Pick<ChatAnnotation, "comment" | "tag">>): void {
  const current = getAnnotations(key);
  if (!current.some((annotation) => annotation.id === id)) return;
  publish(key, current.map((annotation) => (annotation.id === id ? { ...annotation, ...patch } : annotation)));
}

export function removeAnnotation(key: string, id: string): void {
  const current = getAnnotations(key);
  if (!current.some((annotation) => annotation.id === id)) return;
  publish(key, current.filter((annotation) => annotation.id !== id));
}

export function clearAnnotations(key: string): void {
  if (getAnnotations(key).length === 0) return;
  publish(key, EMPTY);
}

/** Moves `ids` from the pending annotations to the sent ones, once their message went out. */
export function markAnnotationsSent(key: string, ids: readonly string[]): void {
  const current = getAnnotations(key);
  const moving = current.filter((annotation) => ids.includes(annotation.id));
  if (moving.length === 0) return;
  sentStore.set(key, [...getSentAnnotations(key), ...moving]);
  publish(key, current.filter((annotation) => !ids.includes(annotation.id)));
}

/** The same array until the conversation's sent annotations change. */
export function getSentAnnotations(key: string): readonly ChatAnnotation[] {
  return sentStore.get(key) ?? EMPTY;
}

export function subscribeAnnotations(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    current?.delete(listener);
    if (current?.size === 0) listeners.delete(key);
  };
}

export function useChatAnnotations(key: string): readonly ChatAnnotation[] {
  const subscribe = useCallback((listener: () => void) => subscribeAnnotations(key, listener), [key]);
  return useSyncExternalStore(subscribe, () => getAnnotations(key));
}

export function useSentAnnotations(key: string): readonly ChatAnnotation[] {
  const subscribe = useCallback((listener: () => void) => subscribeAnnotations(key, listener), [key]);
  return useSyncExternalStore(subscribe, () => getSentAnnotations(key));
}
