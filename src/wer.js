// Word error rate. The measurement that turns the demo into a result.
//
//   WER = (substitutions + deletions + insertions) / words in the reference
//
// Standard scoring: lowercase, strip punctuation, collapse whitespace. Combining marks
// (\p{M}) are kept: in Devanagari the vowel signs are marks, and stripping them split
// every word into fragments - scoring a script switch as 250%+ word error rate. Numbers and
// hyphenated tokens are left alone - "sub-second" stays one token in both strings,
// so it can only ever be right or wrong, never half-credited.

export const tokenize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}'\-_\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

export function wer(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  const n = ref.length, m = hyp.length;

  if (n === 0) return { wer: m === 0 ? 0 : 1, sub: 0, del: 0, ins: m, n: 0, hits: 0 };

  // Levenshtein over words, tracking which edit each cell came from.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const op = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0 hit 1 sub 2 del 3 ins
  for (let i = 1; i <= n; i++) { dp[i][0] = i; op[i][0] = 2; }
  for (let j = 1; j <= m; j++) { dp[0][j] = j; op[0][j] = 3; }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      const diag = dp[i - 1][j - 1] + (same ? 0 : 1);
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      let best = diag, o = same ? 0 : 1;
      if (del < best) { best = del; o = 2; }
      if (ins < best) { best = ins; o = 3; }
      dp[i][j] = best; op[i][j] = o;
    }
  }

  let i = n, j = m, sub = 0, del = 0, ins = 0, hits = 0;
  while (i > 0 || j > 0) {
    const o = i === 0 ? 3 : j === 0 ? 2 : op[i][j];
    if (o === 0) { hits++; i--; j--; }
    else if (o === 1) { sub++; i--; j--; }
    else if (o === 2) { del++; i--; }
    else { ins++; j--; }
  }

  return { wer: (sub + del + ins) / n, sub, del, ins, n, hits };
}
