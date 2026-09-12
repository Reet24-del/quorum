// WAV encoding, kept out of app.js so it can be tested from node.
// The API wants PCM S16LE, mono, 16kHz - this writes exactly that, no extra chunks.

export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);   // file size - 8
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);                        // fmt chunk size
  view.setUint16(20, 1, true);                         // PCM
  view.setUint16(22, 1, true);                         // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);            // byte rate = rate * channels * 2
  view.setUint16(32, 2, true);                         // block align
  view.setUint16(34, 16, true);                        // bits per sample
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

// Inverse, for tests and for loading a clip back off disk.
export function decodeWav(buf) {
  // A Node Buffer is a view into a shared pool, so its byteOffset is rarely 0 -
  // handing .buffer straight to DataView would read whatever else is in that pool.
  const view = buf instanceof ArrayBuffer
    ? new DataView(buf)
    : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (off) => String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

  let off = 12, fmt = null, data = null;
  while (off + 8 <= view.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, view.byteLength - body) };
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');

  const n = Math.floor(data.size / 2);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(data.offset + i * 2, true);
    samples[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return { ...fmt, samples, durationSec: n / (fmt.sampleRate || 1) };
}
