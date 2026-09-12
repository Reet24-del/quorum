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
import os from 'node:os';
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

// Narration: an AI voice (macOS's built-in `say`, the Daniel voice) describes each scene
// where the owner's voice is not playing. `say` gets phonetic spellings for the names it
// would otherwise mangle - a narrator mispronouncing Siobhan in a video about getting
// names right would be too on the nose. Every line must finish before `until`, and none
// may overlap the owner's recordings: the build fails loudly if one does.
const VOICE = process.env.REEL_VOICE || 'Daniel';
const NARRATION = [
  { at: 1.3, until: 4.9, text: 'This is Quorum. One recording, heard four ways.' },
  { at: 5.5, until: 12.9, text: 'Dictation gets everyday words right. It stumbles on the ones that matter most: names, tools, and jargon.' },
  { at: 13.4, until: 23.8, text: 'Quorum sends each recording to AssemblyAI four ways at once: untouched, with faint noise, padded, and slowed. Where they disagree, the words vote.',
    say: 'Quorum sends each recording to Assembly A.I. four ways at once: untouched, with faint noise, padded, and slowed. Where they disagree, the words vote.' },
  { at: 24.05, until: 25.45, text: 'Here’s my voice.', say: "Here's my voice." },
  { at: 30.0, until: 36.8, text: 'One lane heard “CEO Bhan”, with the highest confidence. Three heard Siobhan, and won the vote.',
    say: 'One lane heard, C.E.O. Bahn, with the highest confidence. Three heard Shivawn, and won the vote.' },
  { at: 37.2, until: 42.6, text: 'All four answers came back in under four seconds.' },
  { at: 43.05, until: 44.15, text: 'Watch this one.' },
  { at: 49.2, until: 57.8, text: 'Three lanes switched to Hindi script. Quorum sat them out and kept the English one. The name isn’t perfect, but it’s readable.',
    say: "Three lanes switched to Hindi script. Quorum sat them out and kept the English one. The name isn't perfect, but it's readable." },
  { at: 58.5, until: 67.6, text: 'On twenty real recordings, Quorum beat every single lane, with forty-five percent fewer errors than the untouched recording.' },
  { at: 68.5, until: 76.6, text: 'For developers, it’s a drop-in. Change one URL, keep your code, and get the names right.',
    say: "For developers, it's a drop-in. Change one U.R.L., keep your code, and get the names right." },
  { at: 77.4, until: 83.6, text: 'And along the way, four things the documentation doesn’t tell you.',
    say: "And along the way, four things the documentation doesn't tell you." },
  { at: 84.6, until: 89.2, text: 'Quorum. Change one URL. Get the names right.', say: 'Quorum. Change one U.R.L. Get the names right.' }
];

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

// ---- narration, placed only in the gaps around the owner's recordings
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-narration-'));
const ownerClips = Object.values(data.clips).map((c) => [c.offset, c.offset + c.duration]);
const problems = [];
data.narration = [];
NARRATION.forEach((line, n) => {
  const aiff = path.join(tmp, `${n}.aiff`), wav = path.join(tmp, `${n}.wav`);
  execFileSync('say', ['-v', VOICE, '-o', aiff, line.say ?? line.text]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]);
  let { samples } = decodeWav(fs.readFileSync(wav));
  // Trim the synthesiser's leading and trailing silence, so `at` is when speech starts.
  let a = 0, b = samples.length;
  while (a < b && Math.abs(samples[a]) < 0.004) a++;
  while (b > a && Math.abs(samples[b - 1]) < 0.004) b--;
  samples = samples.subarray(a, b);
  const end = line.at + samples.length / RATE;
  if (end > line.until) problems.push(`line ${n + 1} runs ${(end - line.until).toFixed(2)}s past its ${line.until}s slot: "${line.text}"`);
  for (const [ca, cb] of ownerClips) {
    if (line.at < cb && end > ca) problems.push(`line ${n + 1} overlaps the owner's recording at ${ca}s: "${line.text}"`);
  }
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.75 / peak : 1;       // a touch quieter than the owner's voice (0.89): theirs is the star
  const start = Math.round(line.at * RATE), fade = 0.01 * RATE;
  for (let i = 0; i < samples.length && start + i < track.length; i++) {
    track[start + i] += samples[i] * g * Math.min(1, i / fade, (samples.length - i) / fade);
  }
  data.narration.push({ at: line.at, end: Number(end.toFixed(2)), until: line.until, text: line.text });
});
fs.rmSync(tmp, { recursive: true, force: true });
if (problems.length) {
  console.error('  narration does not fit:\n    ' + problems.join('\n    '));
  process.exit(1);
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
for (const [n, l] of data.narration.entries()) {
  console.log(`  narration ${String(n + 1).padStart(2)}  ${l.at.toFixed(2)}-${l.end.toFixed(2)}s  (slot ends ${l.until}s, ${(l.until - l.end).toFixed(2)}s spare)  ${l.text.slice(0, 48)}`);
}
console.log(`  wrote public/reel/data.json and soundtrack.m4a (${DURATION}s, narrator: ${VOICE})`);
