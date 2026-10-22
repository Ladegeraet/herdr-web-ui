/**
 * Where an annotation's quote stands among a message's text nodes, to mark it in the chat
 * (components/ChatAnnotationMarks.tsx). Whitespace is left out on both sides: the selection's text
 * puts line breaks between blocks the DOM holds none between, and drops a code block's indentation.
 */

/** A position in the `index`th text node, in UTF-16 units as a DOM Range counts them. */
export interface TextPoint {
  node: number;
  offset: number;
}

export interface TextSpan {
  start: TextPoint;
  /** just past the quote's last character */
  end: TextPoint;
}

const SPACE = /\s/;

/** The first place `quote` stands in the nodes' joined text, whitespace aside; null when it is nowhere. */
export function findQuote(nodes: readonly string[], quote: string): TextSpan | null {
  const needle = quote.replace(/\s+/g, "");
  if (needle === "") return null;
  let haystack = "";
  const points: TextPoint[] = [];
  nodes.forEach((text, node) => {
    for (let offset = 0; offset < text.length; offset += 1) {
      const char = text[offset] as string;
      if (SPACE.test(char)) continue;
      haystack += char;
      points.push({ node, offset });
    }
  });
  const at = haystack.indexOf(needle);
  if (at < 0) return null;
  const first = points[at] as TextPoint;
  const last = points[at + needle.length - 1] as TextPoint;
  return { start: first, end: { node: last.node, offset: last.offset + 1 } };
}
