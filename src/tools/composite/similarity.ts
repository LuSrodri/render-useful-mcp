/**
 * Ranking helper for resolving human-supplied service names onto Render resources.
 *
 * Models are given names by users ("the api service"), not ids, and those names are often
 * approximate. Exact-match-only lookup fails constantly; ranked matching turns a failed
 * call into a short list the model can choose from.
 */

/**
 * Levenshtein distance using the two-row rolling variant: O(n·m) time, O(min(n,m)) space.
 *
 * Service names are short, so the simple DP is the right trade-off — the rolling rows keep
 * allocation flat when scoring a few hundred candidates per call.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Iterating over the shorter string keeps the working rows as small as possible.
  if (a.length > b.length) [a, b] = [b, a];

  let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
  let current = new Array<number>(a.length + 1);

  for (let row = 1; row <= b.length; row += 1) {
    current[0] = row;
    const bChar = b.charCodeAt(row - 1);
    for (let column = 1; column <= a.length; column += 1) {
      const cost = a.charCodeAt(column - 1) === bChar ? 0 : 1;
      current[column] = Math.min(
        current[column - 1]! + 1, // insertion
        previous[column]! + 1, // deletion
        previous[column - 1]! + cost, // substitution
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[a.length]!;
}

/** Similarity in `[0, 1]`, where 1 is an exact match. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

/**
 * Scores a candidate against a query, in `[0, 1]`.
 *
 * Substring relationships are weighted above edit distance because users abbreviate
 * ("api" for "api-gateway-prod") far more often than they typo.
 */
export function matchScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (q === '' || c === '') return 0;
  if (q === c) return 1;
  if (c.startsWith(q)) return 0.9;
  if (c.includes(q)) return 0.8;
  return similarity(q, c) * 0.7;
}
