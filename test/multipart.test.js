import { extractAudio } from '../src/multipart.js';
import { encodeWav } from '../public/wav.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

// Serialise a real FormData exactly as fetch would send it.
async function formBody(form) {
  const req = new Request('http://local/', { method: 'POST', body: form });
  return { buf: Buffer.from(await req.arrayBuffer()), ct: req.headers.get('content-type') };
}

// Binary audio with arbitrary bytes - including sequences that look like CRLF and dashes.
const bytes = Buffer.from(encodeWav(new Float32Array(800).map((_, i) => Math.sin(i) * 0.9), 16000));
const same = (a, b) => Boolean(a) && Buffer.compare(a, b) === 0;

console.log('\nmultipart parsing');
{
  const f = new FormData();
  f.append('model', 'universal-3-5-pro');
  f.append('audio', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
  const { buf, ct } = await formBody(f);
  check('finds the audio part among other fields, byte for byte', same(extractAudio(buf, ct), bytes), true);
}
{
  const f = new FormData();
  f.append('file', new Blob([bytes], { type: 'audio/wav' }), 'clip.wav');
  const { buf, ct } = await formBody(f);
  check('falls back to the first file part', same(extractAudio(buf, ct), bytes), true);
}
{
  const f = new FormData();
  f.append('note', 'hello');
  const { buf, ct } = await formBody(f);
  check('a form with no file part yields nothing', extractAudio(buf, ct), null);
}
check('a raw body is the audio', same(extractAudio(bytes, 'audio/wav'), bytes), true);
check('an empty raw body yields nothing', extractAudio(Buffer.alloc(0), 'audio/wav'), null);
check('multipart without a boundary yields nothing', extractAudio(bytes, 'multipart/form-data'), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
