/**
 * Where an annotation's passage stands in a message, to mark it in the chat
 * (components/ChatAnnotationMarks.tsx). The anchor follows the W3C Web Annotation model (a text
 * position checked by a text quote with its context), as T3 Code's assistantTextSelection does:
 *
 * - The message's words are one normalized text: its text nodes joined, each run of whitespace one
 *   space, one space where a block (a paragraph, a list item) ends, no space at either edge.
 * - A passage saved from a selection keeps its start and end in that text, its words there, and
 *   about 32 characters on either side (`anchorOf`).
 * - `resolvePassage` takes the saved place when its words are still there; else it looks for the
 *   words, whitespace aside (a selection's text puts line breaks between blocks the DOM holds none
 *   between, and drops a code block's indentation), and when they stand in more than one place it
 *   takes the one whose context matches best, or none when no one does: never the wrong words.
 */

/** A position in the `node`th piece, in UTF-16 units as a DOM Range counts them. */
export interface TextPoint {
  node: number;
  offset: number;
}

export interface TextSpan {
  start: TextPoint;
  /** just past the passage's last character */
  end: TextPoint;
}

/** A message's text nodes in document order, `null` where a block starts or ends. */
export type TextPiece = string | null;

/** The normalized text, and where each of its characters came from (null for a block's space). */
export interface FlatText {
  text: string;
  points: readonly (TextPoint | null)[];
}

/** A saved passage's place in its message's normalized text. */
export interface TextAnchor {
  start: number;
  end: number;
  /** the normalized text from `start` to `end` */
  exact: string;
  prefix: string;
  suffix: string;
}

/** How much context an anchor keeps on either side. */
export const CONTEXT_CHARS = 32;

const SPACE = /\s/;

/** As much of a DOM node as the walk reads, so a test can hand it plain objects. */
export interface WalkNode {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<WalkNode>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
/** Elements whose start and end part words as a line break would. */
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TD", "TH", "TR", "UL"]);

/** The text nodes under `root` in document order with the block edges between them, leaving out the elements `skip` names. */
export function textPieces(root: WalkNode, skip: (element: WalkNode) => boolean): { pieces: TextPiece[]; nodes: (WalkNode | null)[] } {
  const pieces: TextPiece[] = [];
  const nodes: (WalkNode | null)[] = [];
  const edge = (): void => { if (pieces.length > 0 && pieces[pieces.length - 1] !== null) { pieces.push(null); nodes.push(null); } };
  const visit = (parent: WalkNode): void => {
    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const node = parent.childNodes[index] as WalkNode;
      if (node.nodeType === TEXT_NODE) {
        pieces.push(node.nodeValue ?? "");
        nodes.push(node);
      } else if (node.nodeType === ELEMENT_NODE && !skip(node)) {
        const block = BLOCKS.has(node.nodeName.toUpperCase());
        if (block) edge();
        visit(node);
        if (block) edge();
      }
    }
  };
  visit(root);
  return { pieces, nodes };
}

export function flattenText(pieces: readonly TextPiece[]): FlatText {
  let text = "";
  const points: (TextPoint | null)[] = [];
  // a space owed before the next character, and where it came from
  let gap: { point: TextPoint | null } | null = null;
  pieces.forEach((piece, node) => {
    if (piece === null) {
      if (text !== "" && gap === null) gap = { point: null };
      return;
    }
    for (let offset = 0; offset < piece.length; offset += 1) {
      const char = piece[offset] as string;
      if (SPACE.test(char)) {
        if (text !== "" && gap === null) gap = { point: { node, offset } };
        continue;
      }
      if (gap !== null) {
        text += " ";
        points.push(gap.point);
        gap = null;
      }
      text += char;
      points.push({ node, offset });
    }
  });
  return { text, points };
}

const before = (a: TextPoint, b: TextPoint): boolean => a.node < b.node || (a.node === b.node && a.offset < b.offset);

/** How many characters of the normalized text come before `point`. */
export function flatOffset(flat: FlatText, point: TextPoint): number {
  const at = flat.points.findIndex((source) => source !== null && !before(source, point));
  return at < 0 ? flat.text.length : at;
}

/** The anchor of the normalized text from `start` to `end`, spaces at its edges left out; null when nothing is left. */
export function anchorOf(flat: FlatText, start: number, end: number): TextAnchor | null {
  let from = Math.max(0, start);
  let to = Math.min(flat.text.length, end);
  while (from < to && flat.text[from] === " ") from += 1;
  while (to > from && flat.text[to - 1] === " ") to -= 1;
  if (from >= to) return null;
  return {
    start: from,
    end: to,
    exact: flat.text.slice(from, to),
    prefix: flat.text.slice(Math.max(0, from - CONTEXT_CHARS), from),
    suffix: flat.text.slice(to, to + CONTEXT_CHARS),
  };
}

/** The span of the normalized text from `start` to `end`, which start and end on a character. */
function spanOf(flat: FlatText, start: number, end: number): TextSpan | null {
  const first = flat.points[start];
  const last = flat.points[end - 1];
  if (!first || !last) return null;
  return { start: first, end: { node: last.node, offset: last.offset + 1 } };
}

const squeeze = (text: string): string => text.replace(/\s+/g, "");

/** How many characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function overlap(a: string, b: string, fromEnd: boolean): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n += 1;
  return n;
}

export type PassageMatch = TextSpan | "ambiguous" | null;

/**
 * Where the passage stands: the anchor's place when its words are still there, else the one place
 * its words (the anchor's, or the quote's without one) stand, whitespace aside. Several places:
 * the one whose context matches the anchor's best; "ambiguous" when none stands out. Null when the
 * words are nowhere.
 */
export function resolvePassage(flat: FlatText, quote: string, anchor?: TextAnchor): PassageMatch {
  if (anchor && anchor.end > anchor.start && flat.text.slice(anchor.start, anchor.end) === anchor.exact) {
    return spanOf(flat, anchor.start, anchor.end);
  }
  const needle = squeeze(anchor?.exact ?? quote);
  if (needle === "") return null;
  // the text without spaces, and where each of its characters stands in the normalized text
  let haystack = "";
  const at: number[] = [];
  for (let index = 0; index < flat.text.length; index += 1) {
    if (flat.text[index] === " ") continue;
    haystack += flat.text[index];
    at.push(index);
  }
  const found: number[] = [];
  for (let hit = haystack.indexOf(needle); hit >= 0; hit = haystack.indexOf(needle, hit + 1)) found.push(hit);
  if (found.length === 0) return null;
  const place = (hit: number): TextSpan | null => spanOf(flat, at[hit] as number, (at[hit + needle.length - 1] as number) + 1);
  if (found.length === 1) return place(found[0] as number);
  if (!anchor) return "ambiguous";
  const prefix = squeeze(anchor.prefix);
  const suffix = squeeze(anchor.suffix);
  const scores = found.map((hit) => overlap(haystack.slice(0, hit), prefix, true) + overlap(haystack.slice(hit + needle.length), suffix, false));
  const best = Math.max(...scores);
  if (best === 0 || scores.filter((score) => score === best).length > 1) return "ambiguous";
  return place(found[scores.indexOf(best)] as number);
}

/** The one place `quote` stands among the pieces, whitespace aside; null when it is nowhere or in several places. */
export function findQuote(pieces: readonly TextPiece[], quote: string): TextSpan | null {
  const match = resolvePassage(flattenText(pieces), quote);
  return match === "ambiguous" ? null : match;
}

/** Words to find a quote by: no whitespace, no Markdown marks (the chat draws neither). */
export const looseWords = (text: string): string => text.replace(/[\s*_~`#>|[\]()\\]+/g, "");

// at a line's start: blockquote marks, then a list item's marker and task box, or a heading's hashes
const LINE_MARKS = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}(?:[ \t]+|$))?/;
// a table's separator row, a code fence's line
const SYNTAX_LINE = /^[ \t]*(?:\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)*\|?|`{3,}.*|~{3,}.*)[ \t]*$/;

/**
 * A message's Markdown as `looseWords` of the text the chat draws from it: a list item's marker, a
 * heading's hashes, blockquote marks, a table's pipes and separator row, fence lines and link
 * targets left out. So a quote selected across two list items or table cells, whose text holds
 * none of them, is found in the turn it came from.
 */
export function markdownLooseWords(markdown: string): string {
  return looseWords(markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !SYNTAX_LINE.test(line))
    .map((line) => line.replace(LINE_MARKS, ""))
    .join("\n")
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1"));
}
