// The browser audio path is the one piece that cannot be exercised headlessly end
// to end. This gets as close as possible: encode real speech with the SAME function
// the browser uses, and check the bytes are exactly what the API documents.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav, decodeWav } from '../public/wav.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIP = path.join(HERE, '..', 'eval', 'clips', '01.wav');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

console.log('\nwav encoding');

// --- header is exactly the documented format -------------------------------
const tone = new Float32Array(1600); // 100ms at 16k
for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(2 * Math.PI * 440 * i / 16000) * 0.5;

const encoded = encodeWav(tone, 16000);
const d = decodeWav(encoded);

check('byte length is 44 + 2 per sample', encoded.byteLength, 44 + tone.length * 2);
check('format is PCM', d.format, 1);
check('mono', d.channels, 1);
check('16 kHz', d.sampleRate, 16000);
check('16 bits per sample', d.bitsPerSample, 16);
check('block align is 2', d.blockAlign, 2);
check('byte rate is rate x 2', d.byteRate, 32000);
check('sample count survives', d.samples.length, tone.length);

let worst = 0;
for (let i = 0; i < tone.length; i++) worst = Math.max(worst, Math.abs(tone[i] - d.samples[i]));
check('round-trips within 16-bit quantisation', worst < 1 / 32767 + 1e-7, true);

// clipping must not wrap around to the opposite sign
const hot = encodeWav(new Float32Array([2, -2, 1, -1]), 16000);
const hotBack = decodeWav(hot).samples;
check('over-range positive clips to +1', hotBack[0] > 0.999, true);
check('over-range negative clips to -1', hotBack[1] < -0.999, true);

// --- real speech, produced independently by macOS --------------------------
if (!fs.existsSync(CLIP)) {
  console.log('  SKIP  real speech clip (eval/clips/01.wav not present)');
} else {
  const onDisk = decodeWav(fs.readFileSync(CLIP));
  check('reads a file containing an extra FLLR chunk', onDisk.format, 1);
  check('real clip is mono', onDisk.channels, 1);
  check('real clip is 16 kHz', onDisk.sampleRate, 16000);
  check('real clip is over the 80ms floor', onDisk.durationSec > 0.08, true);
  check('real clip is under the 2 minute ceiling', onDisk.durationSec < 120, true);

  // Re-encode macOS's samples with the browser's encoder and confirm the audio
  // survives unchanged - this is the byte-level claim the live API depends on.
  const reencoded = encodeWav(onDisk.samples, onDisk.sampleRate);
  const back = decodeWav(reencoded);
  check('re-encoded length matches', back.samples.length, onDisk.samples.length);

  let drift = 0;
  for (let i = 0; i < onDisk.samples.length; i++) {
    drift = Math.max(drift, Math.abs(onDisk.samples[i] - back.samples[i]));
  }
  check('speech survives a browser-encoder round trip', drift < 1 / 32767 + 1e-7, true);
  check('no filler chunk in our output', new Uint8Array(reencoded).byteLength,
    44 + onDisk.samples.length * 2);

  console.log(`\n  real clip: ${onDisk.durationSec.toFixed(2)}s, ` +
    `${onDisk.samples.length} samples, max drift ${drift.toExponential(2)}\n`);
}

console.log(`${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
