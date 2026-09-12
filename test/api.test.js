// The hosted (Vercel) functions in api/, called directly with Web Requests.
// Pins the two promises the public site makes: no key means a labelled sample, and the
// public drop-in never spends the project's own key.

import { GET as lanes } from '../api/lanes.js';
import { POST as transcribe } from '../api/transcribe.js';
import { POST as dropin } from '../api/dropin.js';
import { encodeWav } from '../public/wav.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

delete process.env.ASSEMBLYAI_API_KEY;
delete process.env.QUORUM_MOCK;
const wav = Buffer.from(encodeWav(new Float32Array(1600), 16000));
const post = (url, body, headers = {}) => new Request(url, { method: 'POST', body, headers });

console.log('\nhosted functions');

let r = await lanes();
let j = await r.json();
check('with no key configured, lanes report sample mode', j.mock, true);
check('and say they are hosted', j.hosted, true);

r = await transcribe(post('http://site/api/transcribe', wav));
j = await r.json();
check('no key anywhere -> the captured sample, labelled as such', j.mock, true);
check('the sample still carries a merged sentence', typeof j.merged?.text === 'string' && j.merged.text.length > 0, true);

r = await transcribe(post('http://site/api/transcribe', Buffer.alloc(0)));
check('an empty clip -> 400', r.status, 400);

process.env.ASSEMBLYAI_API_KEY = 'the-owners-key';
r = await dropin(post('http://site/transcribe', wav));
check("public drop-in refuses without the caller's key, even when the project has one", r.status, 401);
r = await lanes();
check('with a key configured, lanes report live mode', (await r.json()).mock, false);
delete process.env.ASSEMBLYAI_API_KEY;

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
