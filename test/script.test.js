import { scriptOf, guardScript } from '../src/script.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

console.log('\nscript guard');
check('Latin text', scriptOf('Ask Saoirse to check the overlay'), 'Latin');
check('Devanagari text', scriptOf('जाओ मारा फ्लैग डी रिग्रेशन'), 'Devanagari');
check('nothing to judge', scriptOf(''), null);

const lane = (id, text, error) => ({ id, text, words: [], ...(error ? { error } : {}) });
const mixed = [lane('a', 'Tell CEO Bhan'), lane('b', 'Tell CEO Bhan'), lane('c', 'भावेश मूव्ड'), lane('d', 'यूकी सेड')];
const g = guardScript(mixed);
check('Devanagari lanes sit out when English lanes exist', g.voting.length, 2);
check('and are reported as off-script', g.offScript.length, 2);
check('each lane is tagged with its script', mixed[2].script, 'Devanagari');

const allDev = guardScript([lane('a', 'क्यूब फ्लो'), lane('b', 'क्यूब फ्लो')]);
check('if every lane switched, everyone still votes', allDev.voting.length, 2);
check('and that is flagged', allDev.allOffScript, true);

const withError = guardScript([lane('a', 'hello'), lane('b', '', 'HTTP 503')]);
check('a failed lane never votes', withError.voting.length, 1);
check('and is not counted as off-script', withError.offScript.length, 0);
check('a lane that heard silence still votes', guardScript([lane('a', 'hi'), lane('b', '')]).voting.length, 2);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
