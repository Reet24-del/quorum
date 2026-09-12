// Lane transforms.
//
// The beta endpoint ignores vocabulary hints (see docs/design.md 5), so lanes are
// differentiated by transforming the AUDIO instead. This is not a workaround bolted
// on - it turns out to be the more interesting finding: the model's output is
// unstable under changes a listener would barely notice, and that instability is
// exactly what gives the vote something to work with.
//
// Measured on one clip, five variants produced four distinct transcripts, and three
// of them recovered a proper noun the untouched audio got wrong.

import { encodeWav, decodeWav } from '../public/wav.js';

export const gain = (samples, g) => {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * g));
  return out;
};

// Shifts every word boundary relative to the model's framing without touching content.
export const pad = (samples, n) => {
  const out = new Float32Array(samples.length + n * 2);
  out.set(samples, n);
  return out;
};

// Linear resample. ratio < 1 slows the speech down, > 1 speeds it up.
export const stretch = (samples, ratio) => {
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    out[i] = (samples[j] || 0) * (1 - f) + (samples[j + 1] || 0) * f;
  }
  return out;
};

// Peak-normalise to a target, leaving very quiet clips alone so we don't amplify
// a room full of nothing into a room full of hiss.
export const normalize = (samples, target = 0.9) => {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak < 0.02 || peak === 0) return samples;
  return gain(samples, target / peak);
};

// Faint white noise. Re-seeded on every call so the same clip always gets the same
// noise: the API is deterministic, and a fresh random seed would make runs unrepeatable.
export const noise = (samples, amp) => {
  let seed = 0x5eed;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] + rnd() * amp));
  return out;
};

const TRANSFORMS = { gain, pad, stretch, normalize, noise };

// Apply a lane's transform to a WAV buffer and hand back a new WAV buffer.
export function applyTransform(wav, transform) {
  if (!transform || transform.op === 'none') return wav;
  const fn = TRANSFORMS[transform.op];
  if (!fn) throw new Error(`unknown transform: ${transform.op}`);

  const { samples, sampleRate } = decodeWav(wav);
  const out = fn(samples, transform.arg);
  return Buffer.from(encodeWav(out, sampleRate));
}
