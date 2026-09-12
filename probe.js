// Answers the two blocking questions from the PRD, before you build on guesses:
//
//   1. Does the beta host accept vocabulary hints, and under what field name?
//   2. Can one key run three calls concurrently, or do they serialise?
//
//   node probe.js                 use a generated tone
//   node probe.js clip.wav        use your own recording (better signal)

import fs from 'node:fs';

const KEY = process.env.ASSEMBLYAI_API_KEY;
const ENDPOINT = process.env.QUORUM_ENDPOINT || 'https://dictation.assemblyai.com/transcribe';
const MODEL = process.env.QUORUM_MODEL || 'universal-3-5-pro';

const KEYTERM_FIELDS = ['keyterms', 'keyterms_prompt', 'word_boost', 'keywords', 'vocabulary'];
const PROMPT_FIELDS = ['prompt', 'context', 'contextual_prompt'];
const TERMS = ['kubectl', 'Priya', 'AssemblyAI', 'idempotent'];

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!KEY) {
  console.error(bad('\nASSEMBLYAI_API_KEY is not set.\n'));
  process.exit(1);
}

// 0.6s of a 220Hz tone with a little vibrato - real enough not to be rejected as silence.
function tone(sampleRate = 16000, seconds = 0.6) {
  const n = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const v = Math.sin(2 * Math.PI * 220 * t) * Math.sin(2 * Math.PI * 3 * t) * 0.35;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const wav = process.argv[2] ? fs.readFileSync(process.argv[2]) : tone();

async function call(extra = {}) {
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: KEY, 'X-AAI-Model': MODEL },
    body: form
  });
  const body = await res.text();
  return { status: res.status, ms: Date.now() - t0, body };
}

console.log(`\n  endpoint  ${ENDPOINT}`);
console.log(`  model     ${MODEL}`);
console.log(`  audio     ${process.argv[2] || 'generated tone'} (${wav.length} bytes)\n`);

// --- 1. baseline ------------------------------------------------------------
console.log('1. baseline, no hints');
const base = await call();
if (base.status !== 200) {
  console.log(`   ${bad('FAILED')} HTTP ${base.status}`);
  console.log(dim(`   ${base.body.slice(0, 500)}`));
  console.log(bad('\n   Stop here. Nothing else matters until this returns 200.\n'));
  process.exit(1);
}
console.log(`   ${ok('200')} in ${base.ms} ms`);

let json;
try { json = JSON.parse(base.body); } catch {
  console.log(bad('   response was not JSON')); process.exit(1);
}

const words = json.words || json.result?.words || json.utterances || [];
const w0 = words[0] || {};
console.log(`   top-level keys : ${Object.keys(json).join(', ')}`);
console.log(`   words returned : ${words.length}`);
if (words.length) {
  console.log(`   word keys      : ${Object.keys(w0).join(', ')}`);
  const maxEnd = words.reduce((m, w) => Math.max(m, Number(w.end ?? w.end_time ?? 0)), 0);
  console.log(`   timings        : ${maxEnd > 1000 ? 'milliseconds' : 'seconds'} (max end ${maxEnd})`);
  console.log(`   confidence     : ${'confidence' in w0 || 'conf' in w0 ? ok('present') : bad('ABSENT - merge degrades')}`);
} else {
  console.log(dim('   (no words - expected for a tone; rerun with a real clip to check shape)'));
}

// --- 2. hint field names ----------------------------------------------------
console.log('\n2. vocabulary hint field names');
const acceptedKeyterm = [];
for (const field of KEYTERM_FIELDS) {
  const r = await call({ [field]: JSON.stringify(TERMS) });
  const good = r.status === 200;
  if (good) acceptedKeyterm.push(field);
  console.log(`   ${good ? ok('accepted') : bad('rejected')}  ${field.padEnd(16)} ${dim(`HTTP ${r.status}`)}`);
  if (!good && r.body) console.log(dim(`             ${r.body.slice(0, 160)}`));
}

const acceptedPrompt = [];
for (const field of PROMPT_FIELDS) {
  const r = await call({ [field]: 'Technical dictation. Expect CLI tools and names.' });
  const good = r.status === 200;
  if (good) acceptedPrompt.push(field);
  console.log(`   ${good ? ok('accepted') : bad('rejected')}  ${field.padEnd(16)} ${dim(`HTTP ${r.status}`)}`);
}

// --- 3. concurrency ---------------------------------------------------------
console.log('\n3. three concurrent calls');
const t0 = Date.now();
const three = await Promise.all([call(), call(), call()]);
const wall = Date.now() - t0;
const sum = three.reduce((s, r) => s + r.ms, 0);
const failed = three.filter((r) => r.status !== 200);
console.log(`   statuses  ${three.map((r) => r.status).join(', ')}`);
console.log(`   wall      ${wall} ms`);
console.log(`   serial    ${sum} ms`);
console.log(`   ratio     ${(wall / (sum / 3)).toFixed(2)}x a single call`);

// --- verdict ----------------------------------------------------------------
console.log('\n' + '-'.repeat(62));
const parallel = wall < sum * 0.75;

if (acceptedKeyterm.length) {
  console.log(ok(`  HINTS OK`) + `  use  QUORUM_KEYTERM_FIELD=${acceptedKeyterm[0]}` +
    (acceptedPrompt.length ? ` QUORUM_PROMPT_FIELD=${acceptedPrompt[0]}` : ''));
  console.log(dim('           set it in src/assembly.js or the environment.'));
} else {
  console.log(bad('  NO HINTS') + '  the beta rejects every keyterm field name.');
  console.log(dim('           Fall back to audio-variation lanes (docs/design.md 7.5) -'));
  console.log(dim('           gain and clip-boundary padding instead of vocabulary.'));
}

if (failed.length) {
  console.log(bad('  THROTTLED') + `  ${failed.length} of 3 concurrent calls failed.`);
  console.log(dim('           Check the rate limit before relying on the fan-out.'));
} else if (parallel) {
  console.log(ok('  PARALLEL OK') + `  3 calls in ${wall} ms, not ${sum} ms. The thesis holds.`);
} else {
  console.log(bad('  SERIALISED') + `  3 calls took ${wall} ms against ${sum} ms serial.`);
  console.log(dim('           Concurrency is capped. The latency claim needs rethinking.'));
}
console.log('-'.repeat(62) + '\n');
