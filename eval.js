// Measures whether the merge is actually better than its lanes.
//
//   1. record clips into eval/clips/ (16kHz mono WAV, under 2 minutes)
//   2. write eval/manifest.json:  [ { "file": "01.wav", "truth": "what you said" } ]
//   3. ASSEMBLYAI_API_KEY=... node eval.js
//
// Prints word error rate per lane and for the merge, plus the number that matters:
// how often the merge beat the best single lane on the same audio.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES } from './src/lanes.js';
import { transcribeAll } from './src/assembly.js';
import { transcribeAllMock } from './src/mock.js';
import { merge } from './src/align.js';
import { wer } from './src/wer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'eval');
const MANIFEST = path.join(DIR, 'manifest.json');
const MOCK = process.env.QUORUM_MOCK === '1';

if (!fs.existsSync(MANIFEST)) {
  console.error(`\n  No manifest at eval/manifest.json\n
  Record some clips, then write:

    [ { "file": "01.wav", "truth": "push the kubectl config to staging and tell Priya" } ]

  Aim for 20 utterances, each with at least one name or technical term.
  Say them naturally - reading stiffly makes every lane look better than it is.\n`);
  process.exit(1);
}

const items = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
if (!Array.isArray(items) || !items.length) {
  console.error('  manifest.json must be a non-empty array'); process.exit(1);
}

const pad = (s, n) => String(s).padEnd(n);
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
const runner = MOCK ? transcribeAllMock : transcribeAll;

const totals = LANES.map(() => ({ err: 0, n: 0 }));
const mergedTotal = { err: 0, n: 0 };
let mergeWins = 0, mergeTies = 0, mergeLosses = 0;
const wallTimes = [];
const rows = [];

console.log(`\n  ${items.length} utterances, ${LANES.length} lanes${MOCK ? '  [MOCK]' : ''}\n`);

for (const [i, item] of items.entries()) {
  const file = path.join(DIR, 'clips', item.file);
  if (!fs.existsSync(file)) { console.error(`  missing clip: ${item.file}`); continue; }

  const wav = fs.readFileSync(file);
  let results, wallMs;
  try {
    ({ results, wallMs } = await runner(wav, LANES));
  } catch (err) {
    console.error(`  ${item.file}: ${err.message}`);
    continue;
  }
  wallTimes.push(wallMs);

  const laneScores = results.map((r) => wer(item.truth, r.text));
  const m = merge(results.map((r) => r.words));
  const mergedScore = wer(item.truth, m.text);

  laneScores.forEach((s, k) => { totals[k].err += s.sub + s.del + s.ins; totals[k].n += s.n; });
  mergedTotal.err += mergedScore.sub + mergedScore.del + mergedScore.ins;
  mergedTotal.n += mergedScore.n;

  const best = Math.min(...laneScores.map((s) => s.wer));
  if (mergedScore.wer < best - 1e-9) mergeWins++;
  else if (mergedScore.wer > best + 1e-9) mergeLosses++;
  else mergeTies++;

  const flag = mergedScore.wer < best - 1e-9 ? 'better'
    : mergedScore.wer > best + 1e-9 ? 'WORSE' : 'tie';
  rows.push({ i: i + 1, file: item.file, lanes: laneScores, merged: mergedScore, best, flag, m });

  console.log(`  ${pad(i + 1, 3)} ${pad(item.file, 14)} ` +
    laneScores.map((s) => pct(s.wer)).join(' ') +
    `  ->${pct(mergedScore.wer)}  ${flag}`);
}

// ---------------------------------------------------------------- summary
const line = '-'.repeat(64);
console.log('\n' + line);
console.log('  ' + pad('', 20) + LANES.map((l) => pad(l.name.slice(0, 12), 14)).join('') + 'MERGE');
console.log('  ' + pad('word error rate', 20) +
  totals.map((t) => pad(pct(t.n ? t.err / t.n : 0), 14)).join('') +
  pct(mergedTotal.n ? mergedTotal.err / mergedTotal.n : 0));
console.log(line);

const bestLane = totals.reduce((b, t, k) =>
  (t.n ? t.err / t.n : 1) < (b.rate ?? 1) ? { k, rate: t.err / t.n } : b, {});
const mergedRate = mergedTotal.n ? mergedTotal.err / mergedTotal.n : 0;
const relative = bestLane.rate ? (bestLane.rate - mergedRate) / bestLane.rate : 0;

console.log(`\n  best single lane   ${LANES[bestLane.k]?.name} at ${pct(bestLane.rate ?? 0)}`);
console.log(`  quorum             ${pct(mergedRate)}`);
console.log(`  relative reduction ${(relative * 100).toFixed(1)}%`);
console.log(`\n  merge beat the best lane on ${mergeWins}/${rows.length} utterances` +
  `  (${mergeTies} tied, ${mergeLosses} worse)`);

if (wallTimes.length) {
  const sorted = [...wallTimes].sort((a, b) => a - b);
  console.log(`  fan-out latency    p50 ${sorted[Math.floor(sorted.length / 2)]} ms` +
    `   p95 ${sorted[Math.floor(sorted.length * 0.95)]} ms`);
}

// Two ways this table can lie. Say so loudly, right under the number.
if (MOCK) {
  console.log(`\n  !! MOCK MODE - these numbers mean nothing.`);
  console.log(`     Every clip gets the same canned transcript regardless of its audio.`);
  console.log(`     This run only proves the harness works. Set ASSEMBLYAI_API_KEY.`);
}
const synthetic = items.filter((i) => i.synthetic).length;
if (synthetic) {
  console.log(`\n  !! ${synthetic} of ${items.length} clips are synthesised speech.`);
  console.log(`     Text-to-speech is cleaner and more canonical than a real voice, so`);
  console.log(`     it flatters every lane and understates what the merge is worth.`);
  console.log(`     Re-record these yourself before quoting the number anywhere.`);
}

const losses = rows.filter((r) => r.flag === 'WORSE');
if (losses.length) {
  console.log('\n  where the merge made things worse - read these before tuning alpha:');
  for (const r of losses.slice(0, 5)) {
    console.log(`    ${r.file}  merged ${pct(r.merged.wer)} vs best lane ${pct(r.best)}`);
    console.log(`      "${r.m.text}"`);
  }
}
console.log('');
