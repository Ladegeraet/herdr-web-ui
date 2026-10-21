/**
 * Where a chat annotation's controls go, and what a selection in the chat is about. The DOM side
 * (ChatAnnotations.tsx) reads the selection; these are its pure parts.
 */
import type { ChatAnnotationSource } from "./chatAnnotations.ts";

export interface Box { top: number; bottom: number; left: number; right: number }
export interface Size { width: number; height: number }

/** Room kept to the screen's edges, and between a selection and what floats beside it. */
export const EDGE = 8;
export const GAP = 6;

/** The source a message's `data-annotate` names, or null for anything else. */
export function annotationSource(value: string | undefined | null): ChatAnnotationSource | null {
  return value === "agent" || value === "user" ? value : null;
}

/** "14:32", the turn's local time, for the agent to find the message by; nothing without a time. */
export function annotationContext(ts: string | null | undefined): string | undefined {
  if (!ts) return undefined;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Under the selection's last line, its right edge at the selection's end; above that line when the
 * screen ends first. Always inside the screen.
 */
export function triggerPlace(end: Box, view: Size, size: Size): { top: number; left: number } {
  const below = end.bottom + GAP;
  const top = below + size.height + EDGE > view.height ? end.top - GAP - size.height : below;
  const left = end.right - size.width;
  return {
    top: Math.max(EDGE, Math.min(top, view.height - size.height - EDGE)),
    left: Math.max(EDGE, Math.min(left, view.width - size.width - EDGE)),
  };
}

/**
 * The comment popover: under the selection, left edges aligned; above it when there is more room
 * there; with neither side tall enough, where it fits best inside the screen.
 */
export function popoverPlace(selection: Box, view: Size, size: Size): { top: number; left: number } {
  const roomBelow = view.height - selection.bottom - GAP - EDGE;
  const roomAbove = selection.top - GAP - EDGE;
  const up = size.height > roomBelow && roomAbove > roomBelow;
  const top = up ? selection.top - GAP - size.height : selection.bottom + GAP;
  return {
    top: Math.max(EDGE, Math.min(top, view.height - size.height - EDGE)),
    left: Math.max(EDGE, Math.min(selection.left, view.width - size.width - EDGE)),
  };
}
