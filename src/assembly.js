// Talks to the AssemblyAI Dictation (sync) endpoint.

import { applyTransform } from './audio.js';

//
// ===========================================================================
// PROBED 12 Sep 2026 against dictation.assemblyai.com:
//   - 200 OK, per-word `confidence` present
//   - NO per-word timings (alignment is text-only; align.js sets wTime 0)
//   - keyterms / prompt / word_boost / keywords are ACCEPTED AND IGNORED -
//     output is byte-identical on clips where the model mishears the hinted
//     term. Lanes are differentiated by audio transform instead. See src/audio.js.
//   - ~2.7s per call, not the documented 134ms; the response carries an
//     `llm_response` field, so there is a language-model pass in the path.
//   - 3 concurrent calls cost 1.26x one call, so the fan-out is still nearly free.
// ===========================================================================

// Read at call time, not at import. Binding these to constants on module load makes
// the endpoint impossible to redirect from a test, which is exactly how the first
// dropout test ended up firing at the live API.
const endpoint = () => process.env.QUORUM_ENDPOINT || 'https://dictation.assemblyai.com/transcribe';
const model = () => process.env.QUORUM_MODEL || 'universal-3-5-pro';

// Kept, unused, behind a flag: if the beta ever starts honouring hints, set
// QUORUM_SEND_HINTS=1 and give lanes a `keyterms` array again.
const sendHints = () => process.env.QUORUM_SEND_HINTS === '1';
const hintFields = () => ({
  keyterms: process.env.QUORUM_KEYTERM_FIELD || 'keyterms',
  prompt: process.env.QUORUM_PROMPT_FIELD || 'prompt'
});

export class MissingKey extends Error {}

function buildForm(wav, lane) {
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  if (sendHints()) {
    const fields = hintFields();
    if (lane.keyterms?.length) form.append(fields.keyterms, JSON.stringify(lane.keyterms));
    if (lane.prompt) form.append(fields.prompt, lane.prompt);
  }
  return form;
}

// Responses vary in shape across AssemblyAI products, so parse defensively:
// words may be `words` or `utterances`; timings may be seconds or milliseconds.
export function parseWords(json) {
  const raw = json.words || json.result?.words || json.utterances || [];
  const words = raw.map((w) => ({
    text: w.text ?? w.word ?? '',
    start: Number(w.start ?? w.start_time ?? 0),
    end: Number(w.end ?? w.end_time ?? 0),
    confidence: Number(w.confidence ?? w.conf ?? 0.5)
  })).filter((w) => w.text);

  // Heuristic: a clip is at most 2 minutes, so an end time past 1000 means ms.
  const maxEnd = words.reduce((m, w) => Math.max(m, w.end), 0);
  if (maxEnd > 1000) {
    for (const w of words) { w.start /= 1000; w.end /= 1000; }
  }
  return words;
}

export async function transcribeLane(wav, lane, { timeoutMs = 8000 } = {}) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new MissingKey('ASSEMBLYAI_API_KEY is not set');

  const started = Date.now();
  const audio = applyTransform(wav, lane.transform);
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: key, 'X-AAI-Model': model() },
    body: buildForm(audio, lane),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`lane "${lane.id}" -> HTTP ${res.status}: ${body.slice(0, 400)}`);
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`lane "${lane.id}" -> response was not JSON: ${body.slice(0, 200)}`);
  }

  const words = parseWords(json);
  return {
    id: lane.id,
    name: lane.name,
    blurb: lane.blurb,
    text: json.text ?? json.transcript ?? words.map((w) => w.text).join(' '),
    words,
    ms: Date.now() - started,
    sessionId: json.session_id ?? json.id ?? null
  };
}

// The whole point: every lane leaves at the same time, so three calls cost
// about as much wall-clock as one.
//
// A lane that errors or times out does not fail the request - it drops out and the
// merge runs on whoever came back. Two opinions still vote; one still transcribes.
export async function transcribeAll(wav, lanes, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  const settled = await Promise.allSettled(
    lanes.map((lane) => transcribeLane(wav, lane, { timeoutMs }))
  );

  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const { id, name, blurb } = lanes[i];
    const reason = s.reason;
    return {
      id, name, blurb,
      text: '', words: [], ms: Date.now() - started, sessionId: null,
      error: reason?.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : reason?.message || 'request failed'
    };
  });

  // Every lane failing is a real failure - surface the first cause rather than
  // returning an empty transcript that looks like silence.
  if (results.every((r) => r.error)) {
    const first = settled.find((s) => s.status === 'rejected');
    throw first.reason;
  }

  return { results, wallMs: Date.now() - started };
}
