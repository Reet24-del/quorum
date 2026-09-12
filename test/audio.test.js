import { noise, gain, pad, stretch } from '../src/audio.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

console.log('\naudio transforms');
const tone = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5);
const a = noise(tone, 0.005), b = noise(tone, 0.005);
check('noise is deterministic - same clip, same noise', a.every((v, i) => v === b[i]), true);
check('noise actually changes the audio', a.some((v, i) => v !== tone[i]), true);
check('noise stays within its amplitude', a.every((v, i) => Math.abs(v - tone[i]) <= 0.005 + 1e-9), true);
check('noise never clips past full scale', noise(new Float32Array(100).fill(1), 0.5).every((v) => v <= 1), true);
check('gain clips rather than wrapping', gain(new Float32Array([0.8]), 2)[0], 1);
check('pad adds silence both sides', pad(tone, 100).length, tone.length + 200);
check('stretch 0.95 lengthens the clip', stretch(tone, 0.95).length > tone.length, true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
