// Plain Levenshtein edit distance — used by read's ENOENT "did you mean" suggestions and by
// patch.ts's nearest-match failure reporting. Filenames and single lines are short, so the
// classic O(n*m) DP table is fine; no need for a banded/linear-space variant here.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1]! : 1 + Math.min(prev[j - 1]!, prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// 1 = identical, 0 = completely different. Normalises by the longer string's length so a short
// near-miss ("foo" vs "fooo") doesn't look worse than a long one purely by raw distance.
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}
