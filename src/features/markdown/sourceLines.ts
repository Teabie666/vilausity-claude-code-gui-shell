/**
 * Source lines of text selected in a rendered Markdown preview. The preview marks where each
 * top-level block starts (its first source line); these find the lines inside the block.
 */

/** A top-level block of a Markdown document: its first line (1-based) and its source. */
export interface SourceBlock {
  readonly line: number;
  readonly raw: string;
}

/** The marker the preview puts before a block's rendered HTML (hidden, kept by the sanitizer). */
export const LINE_MARKER_ATTRIBUTE = 'data-source-line';

export function lineMarker(line: number): string {
  return `<span hidden ${LINE_MARKER_ATTRIBUTE}="${line}"></span>`;
}

export function countLineBreaks(text: string): number {
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    count++;
  }
  return count;
}

/** Whitespace runs as single spaces, trimmed. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A Markdown line as it reads rendered: markers, emphasis, link targets and tags removed. */
export function plainMarkdownLine(line: string): string {
  const text = line
    // Block prefixes: headings, quotes, list items, task boxes.
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)+/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    // Images and links keep their text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    // Emphasis, code and strike-through marks; table pipes.
    .replace(/(\*\*|__|~~|[*_`])/g, '')
    .replace(/\|/g, ' ');
  return normalize(text);
}

/**
 * Index of the first line at or after `from` that contains `needle`, trying shorter forms of
 * it (rendered text joins soft-wrapped source lines, so a long needle may span several).
 */
function findLine(lines: readonly string[], needle: string, from: number, fromEnd: boolean): number | undefined {
  const words = needle.split(' ');
  const candidates = [needle];
  for (const count of [6, 3, 1]) {
    if (words.length > count) {
      candidates.push((fromEnd ? words.slice(-count) : words.slice(0, count)).join(' '));
    }
  }
  for (const candidate of candidates) {
    if (candidate.length < 2 && candidates.length > 1) {
      continue;
    }
    for (let index = from; index < lines.length; index++) {
      if (lines[index]!.includes(candidate)) {
        return index;
      }
    }
  }
  return undefined;
}

/**
 * The 1-based source lines that `selected` (text selected in the rendered block) came from,
 * found in the block's source; the block's first line when it cannot be told.
 */
export function locateLines(
  block: SourceBlock,
  selected: string,
): { readonly start: number; readonly end: number; readonly endLength: number } {
  const rawLines = block.raw.split('\n');
  const plain = rawLines.map(plainMarkdownLine);
  const wanted = selected
    .split('\n')
    .map(normalize)
    .filter((line) => line !== '');
  const first = wanted.length > 0 ? findLine(plain, wanted[0]!, 0, false) : undefined;
  const startIndex = first ?? 0;
  let endIndex = startIndex;
  if (wanted.length > 1) {
    endIndex =
      findLine(plain, wanted[wanted.length - 1]!, startIndex, true) ?? Math.min(rawLines.length - 1, startIndex + wanted.length - 1);
  }
  // A trailing empty line of the block (e.g. before the next one) is no part of it.
  while (endIndex > startIndex && rawLines[endIndex]!.trim() === '') {
    endIndex--;
  }
  return { start: block.line + startIndex, end: block.line + endIndex, endLength: rawLines[endIndex]!.length };
}
