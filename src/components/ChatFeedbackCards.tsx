/**
 * The feedback block a message carried (lib/chatAnnotations.ts) drawn under its typed words as
 * small attachment cards, in the composer chips' register: an accent rail, the quote muted on two
 * lines at most, where it came from, and the comment. Three or more fold into one "{n} comments"
 * row. A tap on a quote finds its passage in an earlier message and lights it for a moment; one
 * that is not found does nothing. The card's words are the block's: the message's copy keeps the
 * whole text as sent.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { createContext, useContext } from "react";

import "./ChatFeedbackCards.css";

import type { SentAnnotation } from "../lib/chatAnnotations.ts";
import { useChatRowToggle } from "../lib/chatRowState.tsx";
import { passageMatch } from "../lib/chatPassage.ts";
import { annotationContext } from "../lib/chatSelection.ts";
import { useT } from "../lib/i18n.ts";
import { flashPassage } from "./ChatAnnotationMarks.tsx";

/** From this many annotations on, the cards fold into one row. */
const FOLD_AT = 3;

/**
 * Finds the passage among the messages before `from` that are mounted: the latest of its side
 * whose time matches, else the latest of its side. Lights it and reports true; false when it is not
 * there, or its words stand in more than one place of the first message that holds them.
 */
export function jumpToMountedPassage(from: Element, annotation: SentAnnotation): boolean {
  const own = from.closest("[data-annotate]");
  const root = from.closest(".chat-frame-body") ?? document;
  const before = [...root.querySelectorAll<HTMLElement>(`[data-annotate="${annotation.source}"]`)]
    .filter((message) => message !== own && (message.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    .reverse();
  const timed = annotation.context === undefined ? [] : before.filter((message) => annotationContext(message.dataset.annotateTs) === annotation.context);
  for (const message of [...timed, ...before]) {
    const range = passageMatch(message, annotation.quote);
    if (range === null) continue;
    // its words stand twice in that message: lighting either could be the wrong one
    if (range === "ambiguous") return false;
    flashPassage(range);
    return true;
  }
  return false;
}

/** How the chat finds a card's passage; ChatView adds the turns its list has not mounted. */
export const FeedbackJumpContext = createContext<(from: Element, annotation: SentAnnotation) => void>((from, annotation) => { jumpToMountedPassage(from, annotation); });

/** The quote as the card shows it: one run of words, so the two lines it has show its second paragraph too. */
const cardQuote = (quote: string): string => quote.replace(/\s*\n\s*/g, " ");

function FeedbackCard({ annotation }: { annotation: SentAnnotation }) {
  const t = useT();
  const jump = useContext(FeedbackJumpContext);
  const side = annotation.source === "agent" ? t("agent") : t("you");
  return <li className="chat-feedback-card">
    <span className="chat-feedback-meta">{annotation.context ? `${side} · ${annotation.context}` : side}</span>
    <button type="button" className="chat-feedback-quote" title={t("Show the passage")} onClick={(event) => { jump(event.currentTarget, annotation); }}>{cardQuote(annotation.quote)}</button>
    {annotation.comment !== "" && <p className="chat-feedback-comment">{annotation.comment}</p>}
  </li>;
}

export function ChatFeedbackCards({ annotations }: { annotations: readonly SentAnnotation[] }) {
  const t = useT();
  const [chosen, setOpen] = useChatRowToggle("feedback", false);
  const folds = annotations.length >= FOLD_AT;
  const open = !folds || chosen === true;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="chat-feedback">
    {folds && <button type="button" className="chat-feedback-summary" aria-expanded={open} onClick={() => { setOpen(!open); }}>
      {t("{n} comments", { n: annotations.length })}<Chevron aria-hidden="true" />
    </button>}
    {open && <ul className="chat-feedback-list" aria-label={t("Comments sent with this message")}>
      {annotations.map((annotation, index) => <FeedbackCard key={index} annotation={annotation} />)}
    </ul>}
  </div>;
}
