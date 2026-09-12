// A lane that fails must not take the request down with it.
// Runs against a local stub, never the real API.

import http from 'node:http';
import { LANES } from '../src/lanes.js';
import { transcribeAll, MissingKey } from '../src/assembly.js';
import { merge } from '../src/align.js';
import { encodeWav } from '../public/wav.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

// Lanes now transform the audio, so the stub needs a decodable WAV, not junk bytes.
const wavFixture = () => Buffer.from(encodeWav(new Float32Array(1600), 16000));

const words = (t) => t.split(' ').map((text, i) =>
  ({ text, start: i * 0.3, end: i * 0.3 + 0.28, confidence: 0.9 }));

// failAt: which request index returns 503. -1 for none, 'all' for every one.
function stub(failAt) {
  let n = 0;
  const server = http.createServer((req, res) => {
    const i = n++;
    req.resume();
    req.on('end', () => {
      if (failAt === 'all' || i === failAt) { res.writeHead(503); return res.end('lane exploded'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'hello there world', words: words('hello there world') }));
    });
  });
  return server;
}

async function withStub(failAt, fn) {
  const server = stub(failAt);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.QUORUM_ENDPOINT = `http://127.0.0.1:${server.address().port}/transcribe`;
  process.env.ASSEMBLYAI_API_KEY = 'stub-key';
  try { return await fn(); } finally { server.close(); }
}

console.log('\nlane dropout');

// --- one lane fails, the rest still vote -----------------------------------
await withStub(1, async () => {
  const { results } = await transcribeAll(wavFixture(), LANES);
  const alive = results.filter((r) => !r.error);
  const dead = results.filter((r) => r.error);
  check('all lanes are reported back', results.length, LANES.length);
  check('all but one lane survives', alive.length, LANES.length - 1);
  check('one lane is marked failed', dead.length, 1);
  check('the failure carries a reason', /503/.test(dead[0].error), true);
  check('survivors still merge', merge(alive.map((r) => r.words)).text, 'hello there world');
});

// --- nothing fails ----------------------------------------------------------
await withStub(-1, async () => {
  const { results } = await transcribeAll(wavFixture(), LANES);
  check('healthy run has no failures', results.filter((r) => r.error).length, 0);
});

// --- everything fails: that IS an error ------------------------------------
await withStub('all', async () => {
  let threw = null;
  try { await transcribeAll(wavFixture(), LANES); } catch (e) { threw = e; }
  check('total failure throws rather than returning silence', threw !== null, true);
});

// --- a missing key is reported as such, not as a dead lane -----------------
{
  const saved = process.env.ASSEMBLYAI_API_KEY;
  delete process.env.ASSEMBLYAI_API_KEY;
  let threw = null;
  try { await transcribeAll(wavFixture(), LANES); } catch (e) { threw = e; }
  check('missing key surfaces as MissingKey', threw instanceof MissingKey, true);
  process.env.ASSEMBLYAI_API_KEY = saved;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
