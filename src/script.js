// Script guard.
//
// The model picks the output language itself and cannot be told otherwise: every
// language / detection parameter tried (body, header, query) is accepted and ignored.
// On an accented voice it sometimes answers in Devanagari, spelling the English words
// phonetically, and audio transforms make that more likely. A lane answering in a
// different script cannot vote on English spelling, so it sits the vote out.

const DEVANAGARI = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z\u00C0-\u024F]/g;

export function scriptOf(text) {
  const s = String(text || '');
  const d = (s.match(DEVANAGARI) || []).length;
  const l = (s.match(LATIN) || []).length;
  if (!d && !l) return null; // nothing to judge - e.g. the lane heard silence
  return d > l ? 'Devanagari' : 'Latin';
}

// Tags each answered lane with .script and splits them. If no lane is in the expected
// script there is nothing better to vote with, so everyone votes and allOffScript says so.
export function guardScript(results, expected = process.env.QUORUM_SCRIPT || 'Latin') {
  const answered = results.filter((r) => !r.error);
  for (const r of answered) r.script = scriptOf(r.text);
  const onScript = answered.filter((r) => r.script === null || r.script === expected);
  if (!onScript.length) return { voting: answered, offScript: [], allOffScript: answered.length > 0 };
  return { voting: onScript, offScript: answered.filter((r) => !onScript.includes(r)), allOffScript: false };
}
