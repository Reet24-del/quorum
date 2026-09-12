// End-to-end check of the drop-in contract: spawn the real server against a stub
// upstream, send it an AssemblyAI-style request, and confirm it answers in the
// AssemblyAI shape and forwards the CALLER's key. Never touches the live API.

import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LANES } from '../src/lanes.js';
import { encodeWav } from '../public/wav.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}`);
  if (!ok) { console.log(`        expected ${expected}, got ${actual}`); fail++; } else pass++;
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Stub upstream that remembers what each lane call carried.
const seen = [];
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    seen.push({ auth: req.headers.authorization, model: req.headers['x-aai-model'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      text: 'hello world',
      words: [{ text: 'hello', confidence: 0.9 }, { text: 'world', confidence: 0.8 }]
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));

const port = await freePort();
const env = {
  ...process.env,
  PORT: String(port),
  QUORUM_ENDPOINT: `http://127.0.0.1:${stub.address().port}/transcribe`
};
delete env.ASSEMBLYAI_API_KEY; // prove the caller's key is what gets used
delete env.QUORUM_MOCK;
const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const wav = Buffer.from(encodeWav(new Float32Array(3200).map((_, i) => Math.sin(i / 8) * 0.3), 16000));
const form = (withAudio = true) => {
  const f = new FormData();
  if (withAudio) f.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  else f.append('note', 'no audio here');
  return f;
};

try {
  console.log('\ndrop-in /transcribe');
  let r = await fetch(base + '/transcribe', {
    method: 'POST',
    headers: { Authorization: 'caller-key', 'X-AAI-Model': 'caller-model' },
    body: form()
  });
  const j = await r.json();
  check('an AssemblyAI-style request is accepted', r.status, 200);
  check('answers with top-level text', j.text, 'hello world');
  check('answers with per-word confidence', j.words?.length === 2 && typeof j.words[0].confidence === 'number', true);
  check('reports audio duration like the API does', j.audio_duration_ms, 200);
  check('adds a quorum block covering every lane', j.quorum?.lanes?.length, LANES.length);
  check('makes one upstream call per lane', seen.length, LANES.length);
  check("forwards the caller's key, not the server's", seen.every((s) => s.auth === 'caller-key'), true);
  check("forwards the caller's model", seen.every((s) => s.model === 'caller-model'), true);

  r = await fetch(base + '/transcribe', { method: 'POST', body: form() });
  check('no key from caller or server -> 401', r.status, 401);

  r = await fetch(base + '/transcribe', { method: 'POST', headers: { Authorization: 'k' }, body: form(false) });
  check('a form with no audio -> 400', r.status, 400);

  r = await fetch(base + '/transcribe', {
    method: 'POST',
    headers: { Authorization: 'k', 'Content-Type': 'application/octet-stream' },
    body: wav.subarray(44) // raw PCM S16LE, no WAV header
  });
  check('a raw PCM body is wrapped and accepted', r.status, 200);
} finally {
  server.kill();
  stub.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
