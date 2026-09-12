// Builds the demo reel's data and soundtrack from REAL captures and REAL recordings.
//
//   node demo/build.mjs
//
// In:  demo/captures/clip14.json, clip17.json   /api/transcribe responses, captured live
//      eval/clips/14.wav, 17.wav                the owner's own voice
// Out: public/reel/data.json                    everything public/reel.html shows
//      public/reel/soundtrack.m4a               the voice track, placed on the reel's timeline
//
// Nothing in the reel is typed in by hand: every transcript, confidence and timing
// comes from the captures, so the video can't drift from what the API actually said.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav } from '../public/wav.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(ROOT, ...p);

const DURATION = 90;   // seconds; public/reel.html's timeline is built around this
const RATE = 48000;

const NAMES = { raw: 'Untouched', noisy: 'Faint noise', shifted: '+200 ms silence', slowed: '0.95× speed' };

// offset = the second on the reel's timeline at which the recording starts playing
const CLIPS = {
  c14: {
    file: '14.wav', capture: 'clip14.json', offset: 25.5,
    eyebrow: 'Live, in my own voice',
    caption: 'Three lanes out-vote one confident mistake.'
  },
  c17: {
    file: '17.wav', capture: 'clip17.json', offset: 44.2,
    eyebrow: 'When the model switches language',
    caption: 'Three lanes answered in Hindi script. Quorum sat them out and kept the English one.',
    note: 'Not perfect: it heard “Jawmara”. But it is English you can correct.'
  }
};

const manifest = JSON.parse(fs.readFileSync(at('eval', 'manifest.json'), 'utf8'));
const track = new Float32Array(DURATION * RATE);
const data = { duration: DURATION, clips: {} };

for (const [id, c] of Object.entries(CLIPS)) {
  const cap = JSON.parse(fs.readFileSync(at('demo', 'captures', c.capture), 'utf8'));
  const { samples, sampleRate } = decodeWav(fs.readFileSync(at('eval', 'clips', c.file)));

  // Place the voice on the timeline: resample to 48 kHz, level to a common peak, and
  // fade the first and last 20 ms so the cut never clicks.
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const gain = peak ? 0.89 / peak : 1;
  const ratio = sampleRate / RATE;
  const n = Math.floor(samples.length / ratio);
  const start = Math.round(c.offset * RATE);
  const fade = 0.02 * RATE;
  for (let i = 0; i < n && start + i < track.length; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    const v = ((samples[j] || 0) * (1 - f) + (samples[j + 1] || 0) * f) * gain;
    track[start + i] += v * Math.min(1, i / fade, (n - i) / fade);
  }

  // Loudness envelope for the on-screen waveform.
  const BARS = 96;
  const per = Math.floor(samples.length / BARS);
  const env = [];
  for (let b = 0; b < BARS; b++) {
    let sq = 0;
    for (let k = 0; k < per; k++) { const s = samples[b * per + k] || 0; sq += s * s; }
    env.push(Math.sqrt(sq / per));
  }
  const top = Math.max(...env) || 1;

  // Per lane: what it heard, whether it voted, and its side of the first dispute.
  const voting = cap.votingLaneIds;
  const disputes = cap.merged.segments.filter((s) => s.type === 'dispute');
  const lanes = cap.lanes.map((l) => {
    const k = voting.indexOf(l.id);
    const cand = k < 0 ? null : disputes.map((s) => s.candidates[k]).find((x) => x && x.text) || null;
    return {
      id: l.id,
      name: NAMES[l.id] || l.name,
      text: l.text,
      satOut: Boolean(l.error),
      script: l.script || null,
      dispute: cand ? { phrase: cand.text, conf: Number(cand.confidence.toFixed(2)), won: cand.won } : null
    };
  });

  data.clips[id] = {
    offset: c.offset,
    duration: Number((samples.length / sampleRate).toFixed(3)),
    said: manifest.find((i) => i.file === c.file).truth,
    eyebrow: c.eyebrow,
    caption: c.caption,
    note: c.note || null,
    envelope: env.map((v) => Number(Math.sqrt(v / top).toFixed(3))),
    lanes,
    verdict: cap.merged.segments.filter((s) => s.text).map((s) => ({ text: s.text, pick: s.type === 'dispute' })),
    timing: { wallMs: cap.timing.wallMs, sumOfLanesMs: cap.timing.sumOfLanesMs }
  };
}

fs.mkdirSync(at('public', 'reel'), { recursive: true });
fs.writeFileSync(at('public', 'reel', 'data.json'), JSON.stringify(data, null, 2) + '\n');

const wavPath = at('public', 'reel', 'soundtrack.wav');
const m4aPath = at('public', 'reel', 'soundtrack.m4a');
fs.writeFileSync(wavPath, Buffer.from(encodeWav(track, RATE)));
execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '192000', wavPath, m4aPath]);

for (const [id, c] of Object.entries(data.clips)) {
  console.log(`  ${id}: "${c.said}" at ${c.offset}s for ${c.duration}s, ${c.lanes.length} lanes, verdict "${c.verdict.map((p) => p.text).join(' ')}"`);
}
console.log(`  wrote public/reel/data.json and soundtrack.m4a (${DURATION}s)`);
