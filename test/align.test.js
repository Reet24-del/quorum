import { merge } from '../src/align.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

// Build a lane from [text, start, end, confidence] tuples.
const lane = (rows) => rows.map(([text, start, end, confidence]) => ({ text, start, end, confidence }));

// ---------------------------------------------------------------------------
// The headline case. Spoken: "push the kubectl config to staging and tell Priya"
// No single lane gets it right.
//   A (no hints)    mangles kubectl AND the name
//   B (dev terms)   nails kubectl, but swallows "staging and" into "stagehand"
//   C (contacts)    nails Priya and staging, but mangles kubectl
// ---------------------------------------------------------------------------
const A = lane([
  ['push', 0.00, 0.22, 0.98], ['the', 0.22, 0.34, 0.97],
  ['cube', 0.34, 0.60, 0.41], ['cuttle', 0.60, 0.90, 0.43],
  ['config', 0.90, 1.35, 0.95], ['to', 1.35, 1.48, 0.96],
  ['staging', 1.48, 1.95, 0.96], ['and', 1.95, 2.10, 0.94],
  ['tell', 2.10, 2.38, 0.95], ['prea', 2.38, 2.85, 0.38]
]);
const B = lane([
  ['push', 0.00, 0.22, 0.98], ['the', 0.22, 0.34, 0.97],
  ['kubectl', 0.34, 0.90, 0.94],
  ['config', 0.90, 1.35, 0.96], ['to', 1.35, 1.48, 0.95],
  ['stagehand', 1.48, 2.10, 0.52],
  ['tell', 2.10, 2.38, 0.90], ['prea', 2.38, 2.85, 0.39]
]);
const C = lane([
  ['push', 0.00, 0.22, 0.98], ['the', 0.22, 0.34, 0.97],
  ['cube', 0.34, 0.60, 0.44], ['cuttle', 0.60, 0.90, 0.45],
  ['config', 0.90, 1.35, 0.95], ['to', 1.35, 1.48, 0.96],
  ['staging', 1.48, 1.95, 0.95], ['and', 1.95, 2.10, 0.93],
  ['tell', 2.10, 2.38, 0.95], ['Priya', 2.38, 2.85, 0.91]
]);

const TRUTH = 'push the kubectl config to staging and tell Priya';
const out = merge([A, B, C]);

console.log('\nlane A  :', A.map((w) => w.text).join(' '));
console.log('lane B  :', B.map((w) => w.text).join(' '));
console.log('lane C  :', C.map((w) => w.text).join(' '));
console.log('quorum  :', out.text);
console.log('truth   :', TRUTH);
console.log(`\ndisputed spots: ${out.disputes}`);
for (const s of out.segments.filter((x) => x.type === 'dispute')) {
  const opts = s.candidates
    .map((c) => `${'ABC'[c.lane]}="${c.text || '(nothing)'}"@${c.confidence.toFixed(2)}${c.won ? ' <-' : ''}`)
    .join('  ');
  console.log(`  -> "${s.text}"   from  ${opts}`);
}

console.log('\ntests');
check('merged beats every individual lane', out.text, TRUTH);
check('lane A alone is wrong', A.map((w) => w.text).join(' ') === TRUTH, false);
check('lane B alone is wrong', B.map((w) => w.text).join(' ') === TRUTH, false);
check('lane C alone is wrong', C.map((w) => w.text).join(' ') === TRUTH, false);
check('found exactly 3 disagreements', out.disputes, 3);

// Same words, different spacing: normalisation folds them into one ballot, so the
// ballot must elect the spelling most lanes actually used, not the first one seen.
const spaced = (text, c) => [{ text, start: 0, end: 0, confidence: c }];
const spacing = merge([
  spaced('Rollback', 0.508),
  spaced('Roll back', 0.751),
  spaced('Roll back', 0.835)
]);
check('majority spelling wins inside a ballot', spacing.text, 'Roll back');

const spacingTie = merge([spaced('Rollback', 0.95), spaced('Roll back', 0.40)]);
check('spelling tie breaks on confidence', spacingTie.text, 'Rollback');

// Unanimous input should pass straight through with nothing disputed.
const u = merge([A, A, A]);
check('unanimous lanes pass through', u.text, A.map((w) => w.text).join(' '));
check('unanimous lanes have no disputes', u.disputes, 0);

// Degenerate inputs must not throw.
check('single lane works', merge([B]).text, B.map((w) => w.text).join(' '));
check('empty lane tolerated', merge([A, [], C]).text.length > 0, true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
