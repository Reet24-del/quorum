// Quorum: merge N transcripts of the SAME audio into one.
//
// Three stages:
//   1. align   - line the lanes up word-by-word (text similarity + time overlap)
//   2. segment - runs where every lane agrees become anchors; the rest are disputes
//   3. vote    - each dispute is settled between competing PHRASES, not single words
//
// Voting on phrases rather than words is what lets "kubectl" (1 word, 1 lane) beat
// "cube cuttle" (2 words, 2 lanes). Word-level voting cannot express that.

export const DEFAULTS = {
  alpha: 0.5,      // 0 = trust confidence only, 1 = trust the headcount only
  nullConf: 0.55,  // how confident we treat "this lane said nothing here"
  wText: 0.65,     // alignment: weight on word similarity
  wTime: 0.35,     // alignment: weight on timing overlap
  gapPenalty: -0.5,
  vocabBonus: 0.3  // added to a ballot that spells a known term (opts.vocabulary)
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9'_]+/g, '');

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

function textSim(a, b) {
  const x = norm(a.text), y = norm(b.text);
  if (!x.length && !y.length) return 1;
  const maxLen = Math.max(x.length, y.length) || 1;
  return 1 - editDistance(x, y) / maxLen;
}

// Intersection-over-union of the two words' time spans. All lanes heard the same
// audio, so words occupying the same moment are almost certainly the same slot.
function timeSim(a, b) {
  if (![a.start, a.end, b.start, b.end].every(Number.isFinite)) return 0.5;
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

function pairScore(a, b, o) {
  const s = o.wText * textSim(a, b) + o.wTime * timeSim(a, b);
  return 2 * s - 1; // map [0,1] similarity onto [-1,1] so bad matches cost
}

// Classic Needleman-Wunsch global alignment.
function nwAlign(seqA, seqB, simFn, gapPenalty) {
  const n = seqA.length, m = seqB.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const ptr = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  for (let i = 1; i <= n; i++) { dp[i][0] = dp[i - 1][0] + gapPenalty; ptr[i][0] = 1; }
  for (let j = 1; j <= m; j++) { dp[0][j] = dp[0][j - 1] + gapPenalty; ptr[0][j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + simFn(seqA[i - 1], seqB[j - 1]);
      const up = dp[i - 1][j] + gapPenalty;
      const left = dp[i][j - 1] + gapPenalty;
      let best = diag, p = 0;
      if (up > best) { best = up; p = 1; }
      if (left > best) { best = left; p = 2; }
      dp[i][j] = best; ptr[i][j] = p;
    }
  }
  const pairs = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ptr[i][j] === 0) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && (j === 0 || ptr[i][j] === 1)) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return pairs.reverse();
}

// Progressive multiple alignment: fold each lane into a growing column profile.
export function buildColumns(lanes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const L = lanes.length;
  if (L === 0) return [];
  let cols = lanes[0].map((w) => {
    const c = new Array(L).fill(null);
    c[0] = w;
    return c;
  });
  for (let k = 1; k < L; k++) {
    const words = lanes[k];
    // A word's score against a column is its best score against any member.
    const colSim = (col, w) => {
      let best = -1;
      for (const mem of col) {
        if (!mem) continue;
        const s = pairScore(mem, w, o);
        if (s > best) best = s;
      }
      return best;
    };
    const next = [];
    for (const [ci, wi] of nwAlign(cols, words, colSim, o.gapPenalty)) {
      if (ci !== null) {
        const col = cols[ci];
        if (wi !== null) col[k] = words[wi];
        next.push(col);
      } else {
        const col = new Array(L).fill(null);
        col[k] = words[wi];
        next.push(col);
      }
    }
    cols = next;
  }
  return cols;
}

const unanimous = (col) =>
  col.every(Boolean) && col.every((w) => norm(w.text) === norm(col[0].text));

// Normalisation folds away case, punctuation AND spacing, so "Roll back" and
// "Rollback" are treated as the same words - correctly, they are. But they are not
// the same string to a reader or to a word-error-rate scorer, so wherever a set of
// lanes has been judged to agree, the surface form still has to be elected: most
// used wins, ties break on confidence. Without this a 3-1 spelling majority is
// silently discarded in favour of whichever lane happened to be first.
function electForm(entries) {
  const forms = new Map();
  for (const { text, confidence } of entries) {
    const f = forms.get(text) || { n: 0, conf: -1 };
    f.n++;
    f.conf = Math.max(f.conf, Number.isFinite(confidence) ? confidence : 0.5);
    forms.set(text, f);
  }
  let best = '', bestN = -1, bestConf = -1;
  for (const [form, f] of forms) {
    if (f.n > bestN || (f.n === bestN && f.conf > bestConf)) {
      best = form; bestN = f.n; bestConf = f.conf;
    }
  }
  return best;
}

const meanConf = (words, fallback) =>
  words.length
    ? words.reduce((s, w) => s + (Number.isFinite(w.confidence) ? w.confidence : 0.5), 0) / words.length
    : fallback;

// Collapse aligned columns into anchors (everyone agrees) and disputes (they don't).
function toSegments(cols) {
  const segs = [];
  let run = [];
  const flush = () => {
    if (run.length) { segs.push({ type: 'dispute', cols: run }); run = []; }
  };
  for (const col of cols) {
    if (unanimous(col)) {
      flush();
      segs.push({ type: 'agree', col });
    } else {
      run.push(col);
    }
  }
  flush();
  return segs;
}

// The live beta returns per-word confidence but no per-word timings, so every span is
// [0,0] and the time term contributes nothing but a constant offset that distorts the
// comparison against gapPenalty. Detect that and score on text alone.
const hasTimings = (lanes) =>
  lanes.some((words) => words.some((w) => Number(w.end) > 0));

// Client-side vocabulary. The API ignores keyterms, so known terms are applied here -
// but only as a tie-breaker between spellings some lane actually produced. It can promote
// "Ngozi" over "Angozi" when a lane heard "Ngozi"; it can never write a word no lane
// heard, so it cannot hallucinate a term into the transcript. Anchors are untouched.
function isKnown(text, vocab) {
  if (!vocab.size || !text) return false;
  if (vocab.has(norm(text))) return true;
  return text.split(/\s+/).some((t) => vocab.has(norm(t)));
}

export function merge(lanes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (opts.wTime === undefined && !hasTimings(lanes)) { o.wTime = 0; o.wText = 1; }
  const L = lanes.length;
  const vocab = new Set((o.vocabulary || []).map(norm).filter(Boolean));
  const weights = o.laneWeights || new Array(L).fill(1);
  const cols = buildColumns(lanes, o);
  const segments = [];

  for (const seg of toSegments(cols)) {
    if (seg.type === 'agree') {
      const present = seg.col.filter(Boolean);
      segments.push({
        type: 'agree',
        text: electForm(present),
        confidence: meanConf(present, o.nullConf)
      });
      continue;
    }

    // Each lane's phrase across this run of disputed columns.
    const phrases = [];
    for (let k = 0; k < L; k++) {
      const words = seg.cols.map((c) => c[k]).filter(Boolean);
      phrases.push({
        lane: k,
        text: words.map((w) => w.text).join(' '),
        words,
        confidence: meanConf(words, o.nullConf) * weights[k]
      });
    }

    // Lanes proposing the same phrase share one ballot; electForm settles spelling.
    const groups = new Map();
    for (const p of phrases) {
      const key = norm(p.text) || '__GAP__';
      if (!groups.has(key)) groups.set(key, { lanes: [], confs: [], members: [] });
      const g = groups.get(key);
      g.lanes.push(p.lane);
      g.confs.push(p.confidence);
      g.members.push(p);
    }

    let winner = null;
    const ballots = [];
    for (const g of groups.values()) {
      const votes = g.lanes.length;
      const conf = g.confs.reduce((a, b) => a + b, 0) / votes;
      const known = isKnown(g.members[0].text, vocab);
      const score = o.alpha * (votes / L) + (1 - o.alpha) * conf + (known ? o.vocabBonus : 0);
      const ballot = { text: electForm(g.members), lanes: g.lanes, votes, confidence: conf, score, known };
      ballots.push(ballot);
      if (!winner || score > winner.score ||
          (score === winner.score && conf > winner.confidence)) winner = ballot;
    }

    segments.push({
      type: 'dispute',
      text: winner.text,
      winnerLanes: winner.lanes,
      candidates: phrases.map((p) => ({
        lane: p.lane,
        text: p.text,
        confidence: p.confidence,
        won: winner.lanes.includes(p.lane)
      })),
      ballots: ballots.sort((a, b) => b.score - a.score)
    });
  }

  const text = segments.map((s) => s.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const disputes = segments.filter((s) => s.type === 'dispute').length;
  return { text, segments, columns: cols, disputes };
}
