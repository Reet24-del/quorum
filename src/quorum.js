// The whole pipeline as one call: fan out, guard scripts, vote. Both the demo's
// /api/transcribe and the drop-in /transcribe go through here, so they can never drift.

import { LANES, VOCABULARY } from './lanes.js';
import { transcribeAll } from './assembly.js';
import { transcribeAllMock } from './mock.js';
import { guardScript } from './script.js';
import { merge } from './align.js';
import { encodeWav, decodeWav } from '../public/wav.js';

export async function runQuorum(wav, { key, model, mock = false } = {}) {
  const runner = mock ? transcribeAllMock : transcribeAll;
  const { results, wallMs } = await runner(wav, LANES, { key, model });

  // Only lanes that answered, in the expected script, get a vote. The rest still come
  // back so a client can show which opinion is missing, and why.
  const { voting, offScript } = guardScript(results);
  for (const r of offScript) r.error = `answered in ${r.script}, so it sat out the vote`;

  const merged = merge(voting.map((r) => r.words), { vocabulary: VOCABULARY });
  return {
    mock,
    results,
    voting,
    merged,
    timing: {
      wallMs,                                                     // what the caller waited
      slowestLaneMs: results.reduce((m, r) => Math.max(m, r.ms), 0),
      sumOfLanesMs: results.reduce((s, r) => s + r.ms, 0)         // what it would cost in series
    }
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round3 = (x) => Math.round(x * 1000) / 1000;

// Reshape into the AssemblyAI Dictation response, so an existing client needs no change:
// the same top-level text / words / confidence, plus a `quorum` block it can ignore.
export function toAssemblyShape(run, { audioDurationMs = null } = {}) {
  const words = [];
  for (const s of run.merged.segments) {
    const conf = s.type === 'agree'
      ? s.confidence
      : mean(s.candidates.filter((c) => c.won).map((c) => c.confidence));
    for (const w of String(s.text || '').split(/\s+/).filter(Boolean)) {
      words.push({ text: w, confidence: round3(conf) });
    }
  }
  return {
    text: run.merged.text,
    words,
    confidence: round3(mean(words.map((w) => w.confidence))),
    audio_duration_ms: audioDurationMs,
    request_time_ms: run.timing.wallMs,
    quorum: {
      mock: run.mock,
      lanes: run.results.map((r) => ({
        id: r.id,
        name: r.name,
        text: r.text,
        voted: run.voting.includes(r),
        ...(r.error ? { error: r.error } : {})
      })),
      disputes: run.merged.disputes,
      timing: run.timing
    }
  };
}

// AssemblyAI also accepts raw PCM S16LE. Anything that isn't a WAV is taken as that, at
// the API's default 16 kHz mono, and wrapped so the lane transforms can read it.
export function asWav(buf) {
  try {
    decodeWav(buf);
    return buf;
  } catch {
    const n = Math.floor(buf.length / 2);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2);
      f[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
    }
    return Buffer.from(encodeWav(f, 16000));
  }
}

export function durationMs(wav) {
  try {
    return Math.round(decodeWav(wav).durationSec * 1000);
  } catch {
    return null;
  }
}
