import { wer, tokenize } from '../src/wer.js';

let pass = 0, fail = 0;
const near = (a, b) => Math.abs(a - b) < 1e-9;
function check(name, actual, expected) {
  const ok = typeof expected === 'number' ? near(actual, expected) : actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

console.log('\nword error rate');

check('identical is zero', wer('one two three', 'one two three').wer, 0);
check('one substitution of five', wer('a b c d e', 'a b X d e').wer, 0.2);
check('one deletion of three', wer('a b c', 'a c').wer, 1 / 3);
check('one insertion of two', wer('a b', 'a X b').wer, 0.5);
check('case is ignored', wer('Priya', 'priya').wer, 0);
check('punctuation is ignored', wer('staging, and tell.', 'staging and tell').wer, 0);
check('hyphenated stays one token', tokenize('sub-second').length, 1);
check('Devanagari words stay whole (vowel signs are marks)', tokenize('क्यूब फ्लो पाइपलाइन').length, 3);
check('identical Devanagari scores zero', wer('क्यूब फ्लो', 'क्यूब फ्लो').wer, 0);
check('a script switch is substitution, not an insertion storm', wer('Kube flow pipeline', 'क्यूब फ्लो पाइपलाइन').wer, 1);
check('empty hypothesis is total loss', wer('a b c', '').wer, 1);
check('empty reference with output counts as error', wer('', 'a b').wer, 1);
check('both empty is zero', wer('', '').wer, 0);

const counts = wer('a b c d', 'a X c d e');
check('counts substitutions', counts.sub, 1);
check('counts insertions', counts.ins, 1);
check('counts hits', counts.hits, 3);

// The real comparison the eval harness makes.
const TRUTH = 'push the kubectl config to staging and tell Priya';
const laneA = 'push the cube cuttle config to staging and tell prea';
const laneB = 'push the kubectl config to stagehand tell prea';
const laneC = 'push the cube cuttle config to staging and tell Priya';
const quorum = 'push the kubectl config to staging and tell Priya';

const scores = [laneA, laneB, laneC].map((t) => wer(TRUTH, t).wer);
console.log(`\n  lane A ${(scores[0] * 100).toFixed(1)}%   lane B ${(scores[1] * 100).toFixed(1)}%   ` +
  `lane C ${(scores[2] * 100).toFixed(1)}%   quorum ${(wer(TRUTH, quorum).wer * 100).toFixed(1)}%\n`);

check('quorum scores zero on the fixture', wer(TRUTH, quorum).wer, 0);
check('every lane scores worse than quorum', scores.every((s) => s > 0), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
