/**
 * Fuzzy matching for quick open: the typed characters must appear in order in the path.
 * Matches in the file name beat matches spread over folders; consecutive characters and
 * characters at word starts (after `/ . - _`, or a lower-to-upper case change) score more.
 */

const WORD_SEPARATORS = new Set(['/', '\\', '.', '-', '_', ' ']);

/** Score of `query` (lower case) as a subsequence of `text`, or undefined when it is not one. */
function subsequenceScore(text: string, query: string): number | undefined {
  const lower = text.toLowerCase();
  let score = 0;
  let position = 0;
  let previousMatch = -2;
  for (const char of query) {
    const found = lower.indexOf(char, position);
    if (found < 0) {
      return undefined;
    }
    score += 1;
    if (found === previousMatch + 1) {
      score += 5;
    }
    const before = text[found - 1];
    if (found === 0 || (before !== undefined && WORD_SEPARATORS.has(before))) {
      score += 3;
    } else if (before !== undefined && before === before.toLowerCase() && text[found] !== text[found]!.toLowerCase()) {
      score += 3;
    }
    previousMatch = found;
    position = found + 1;
  }
  return score;
}

/**
 * Where the typed characters (spaces ignored) fall in `text`, taking each at its first
 * place in order, as `[start, end)` runs; undefined when they are not all in it in order.
 */
export function matchRanges(text: string, typed: string): [number, number][] | undefined {
  const query = typed.toLowerCase().replace(/\s+/g, '');
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  let position = 0;
  for (const char of query) {
    const found = lower.indexOf(char, position);
    if (found < 0) {
      return undefined;
    }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) {
      last[1] = found + 1;
    } else {
      ranges.push([found, found + 1]);
    }
    position = found + 1;
  }
  return ranges;
}

/**
 * Scores a workspace-relative path (`/` separators) against the typed text. Spaces in the
 * query are ignored, like VS Code's quick open.
 */
export function scorePath(path: string, typed: string): number | undefined {
  const query = typed.toLowerCase().replace(/\s+/g, '');
  if (!query) {
    return 0;
  }
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const inName = subsequenceScore(name, query);
  if (inName !== undefined) {
    return 1000 + inName * 10 - path.length * 0.01;
  }
  const inPath = subsequenceScore(path, query);
  return inPath === undefined ? undefined : inPath * 10 - path.length * 0.01;
}
