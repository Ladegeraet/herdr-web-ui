import { useCallback, useSyncExternalStore } from "react";

import type { TextAnchor } from "./chatHighlights.ts";

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
  /** "" flags the passage without a comment */
  comment: string;
  /** Where the quote came from, e.g. "message 4 · 14:32". */
  context?: string;
  /** The `data-annotate-ts` of the message the quote came from, to find it again in the chat. */
  turnTs?: string;
  /** Where the selection stood in that message's words, to mark it again even where its words repeat. */
  anchor?: TextAnchor;
  /** Reserved; no UI sets it yet. */
  tag?: string;
  createdAt: number;
}

export type ChatAnnotationInput = Omit<ChatAnnotation, "id" | "createdAt">;

/** The lines of `text` without CRs, trailing spaces or blank edges. */
function cleanLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A quote longer than this goes in a fenced block, not inline in the heading. */
const INLINE_QUOTE_MAX = 200;

/** One entry: the heading with the quote inline, or a fenced block for a long or multi-line one, then the comment quoted. */
function feedbackEntry(annotation: ChatAnnotation, number: number): string {
  const context = annotation.context?.trim();
  const label = `${annotation.source === "agent" ? "agent message" : "your message"}${context ? `, ${context}` : ""}`;
  const heading = `## ${number}. (${label}) Feedback on:`;
  const quote = cleanLines(annotation.quote);
  const comment = cleanLines(annotation.comment).map((line) => (line === "" ? ">" : `> ${line}`));
  const single = quote.length <= 1 ? (quote[0] ?? "").trim() : null;
  if (single !== null && single.length <= INLINE_QUOTE_MAX) return [`${heading} "${single}"`, ...comment].join("\n");
  // a fence longer than any backtick run in the quote, so the quote cannot close it
  const longest = Math.max(0, ...(annotation.quote.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [heading, fence, ...quote, fence, ...comment].join("\n");
}

/** The annotations as one Markdown feedback block in Plannotator's shape, oldest first; "" when there are none. */
export function formatAnnotationsMarkdown(list: readonly ChatAnnotation[]): string {
  if (list.length === 0) return "";
  const entries = [...list].sort((a, b) => a.createdAt - b.createdAt).map((annotation, index) => feedbackEntry(annotation, index + 1));
  const pieces = list.length === 1 ? "1 piece" : `${list.length} pieces`;
  return ["# Message Feedback", `I've reviewed this conversation and have ${pieces} of feedback:`, ...entries, "---"].join("\n\n");
}

/** One entry read back from a sent feedback block. */
export interface SentAnnotation {
  source: ChatAnnotationSource;
  quote: string;
  /** "" for a passage only flagged */
  comment: string;
  context?: string;
}

const BLOCK_TITLE = "# Message Feedback";
const BLOCK_INTRO = /^I've reviewed this conversation and have (\d+) pieces? of feedback:$/;
const ENTRY_HEADING = /^## (\d+)\. \((agent message|your message)(?:, (.+?))?\) Feedback on:(?: "(.*)")?$/;
const FENCE = /^`{3,}$/;

/** The entries of a block from its title line on, which must run to the end of `lines`; null when it is not one formatAnnotationsMarkdown wrote. */
function parseBlockLines(lines: readonly string[]): SentAnnotation[] | null {
  let at = 1;
  const skipBlank = (): void => { while (at < lines.length && lines[at]?.trim() === "") at += 1; };
  skipBlank();
  const intro = BLOCK_INTRO.exec(lines[at] ?? "");
  if (intro === null) return null;
  at += 1;
  const entries: SentAnnotation[] = [];
  for (;;) {
    skipBlank();
    const line = lines[at];
    if (line === undefined) return null;
    if (line.trim() === "---") break;
    const heading = ENTRY_HEADING.exec(line);
    if (heading === null || Number(heading[1]) !== entries.length + 1) return null;
    at += 1;
    let quote: string;
    if (heading[4] !== undefined) quote = heading[4];
    else {
      const fence = lines[at];
      if (fence === undefined || !FENCE.test(fence)) return null;
      const end = lines.indexOf(fence, at + 1);
      if (end < 0) return null;
      quote = lines.slice(at + 1, end).join("\n");
      at = end + 1;
    }
    const comment: string[] = [];
    for (let next = lines[at]; next !== undefined && next.startsWith(">"); next = lines[at]) {
      comment.push(next.startsWith("> ") ? next.slice(2) : next.slice(1));
      at += 1;
    }
    const context = heading[3];
    entries.push({ source: heading[2] === "agent message" ? "agent" : "user", quote, comment: comment.join("\n"), ...(context === undefined ? {} : { context }) });
  }
  at += 1;
  skipBlank();
  if (at < lines.length || entries.length === 0 || entries.length !== Number(intro[1])) return null;
  return entries;
}

/**
 * A sent message split into what was typed and the feedback block composeWithAnnotations put
 * after it; null when it ends in no such block, or one that does not read back whole. Reads the
 * text alone, so a message from before a reload reads the same.
 */
export function parseAnnotationsBlock(message: string): { text: string; annotations: SentAnnotation[] } | null {
  const lines = message.replace(/\r\n?/g, "\n").split("\n");
  // the first title the rest reads whole from: a title typed above the block, or quoted inside it, is not one
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start] !== BLOCK_TITLE || (start > 0 && lines[start - 1]?.trim() !== "")) continue;
    const annotations = parseBlockLines(lines.slice(start));
    if (annotations !== null) return { text: lines.slice(0, start).join("\n").trim(), annotations };
  }
  return null;
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

const looseQuote = (quote: string): string => quote.replace(/\s+/g, " ").trim();

/** The latest annotation sent from this page that a feedback card read back from a message stands for; undefined after a reload. */
export function sentAnnotationOf(key: string, card: SentAnnotation): ChatAnnotation | undefined {
  const quote = looseQuote(card.quote);
  return [...getSentAnnotations(key)].reverse().find((annotation) => annotation.source === card.source && looseQuote(annotation.quote) === quote);
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
