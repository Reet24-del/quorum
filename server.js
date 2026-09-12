// Tiny local server. Holds the API key (so the browser never sees it),
// fans one clip out to every lane, merges, returns the whole picture.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES } from './src/lanes.js';
import { MissingKey } from './src/assembly.js';
import { decodeWav } from './public/wav.js';
import { runQuorum, toAssemblyShape, asWav, durationMs } from './src/quorum.js';
import { extractAudio } from './src/multipart.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const EVAL_DIR = path.join(HERE, 'eval');
const PORT = Number(process.env.PORT || 5173);
const MOCK = process.env.QUORUM_MOCK === '1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
};

function readBody(req, limit = 45 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('clip too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!path.extname(rel)) rel += '.html'; // pretty URLs: /try -> try.html, /record -> record.html
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'nope' });
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/lanes') {
    return json(res, 200, {
      mock: MOCK,
      lanes: LANES.map(({ id, name, blurb, transform }) => ({ id, name, blurb, transform }))
    });
  }

  if (req.method === 'POST' && req.url === '/api/transcribe') {
    let wav;
    try { wav = await readBody(req); } catch (err) { return json(res, 413, { error: err.message }); }
    if (!wav.length) return json(res, 400, { error: 'empty clip' });
    try {
      const run = await runQuorum(wav, { mock: MOCK });
      return json(res, 200, {
        mock: MOCK,
        bytes: wav.length,
        lanes: run.results,
        votingLaneIds: run.voting.map((r) => r.id),
        merged: run.merged,
        timing: run.timing
      });
    } catch (err) {
      const code = err instanceof MissingKey ? 401 : 502;
      console.error('[transcribe]', err.message);
      return json(res, code, { error: err.message });
    }
  }

  // Drop-in replacement for AssemblyAI's Dictation endpoint: same path, same multipart
  // "audio" field, same response shape (plus a `quorum` block). Point a client's base URL
  // here and it gets the four-lane vote with no other change. The caller's Authorization
  // header is used as the AssemblyAI key, so each caller pays for their own lane calls.
  if (req.method === 'POST' && req.url === '/transcribe') {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 413, { error: err.message }); }
    const audio = extractAudio(body, req.headers['content-type']);
    if (!audio || !audio.length) {
      return json(res, 400, { error: 'No audio. Send a multipart form with an "audio" file part, or a raw WAV/PCM body.' });
    }
    const wav = asWav(audio);
    try {
      const run = await runQuorum(wav, {
        key: req.headers.authorization,
        model: req.headers['x-aai-model'],
        mock: MOCK
      });
      return json(res, 200, toAssemblyShape(run, { audioDurationMs: durationMs(wav) }));
    } catch (err) {
      const code = err instanceof MissingKey ? 401 : 502;
      console.error('[drop-in]', err.message);
      return json(res, code, { error: err.message });
    }
  }

  // Saves a real recording straight into the eval set, so measuring on your own voice
  // is one gesture per utterance rather than a convert-rename-edit-JSON chore.
  if (req.method === 'POST' && req.url === '/api/eval-clip') {
    const truth = decodeURIComponent(req.headers['x-truth'] || '').trim();
    if (!truth) return json(res, 400, { error: 'Missing the sentence the clip contains (X-Truth header).' });
    let wav;
    try { wav = await readBody(req); } catch (err) { return json(res, 413, { error: err.message }); }
    let info;
    try { info = decodeWav(wav); } catch { return json(res, 400, { error: 'That upload is not a WAV file.' }); }
    if (info.durationSec < 0.08 || info.durationSec > 120) {
      return json(res, 400, { error: `Clip is ${info.durationSec.toFixed(2)}s; it needs to be between 0.08s and 2 minutes.` });
    }
    const manifestPath = path.join(EVAL_DIR, 'manifest.json');
    const items = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => '[]'));
    const next = items.reduce((m, i) => Math.max(m, parseInt(i.file, 10) || 0), 0) + 1;
    const file = `${String(next).padStart(2, '0')}.wav`;
    await fs.mkdir(path.join(EVAL_DIR, 'clips'), { recursive: true });
    await fs.writeFile(path.join(EVAL_DIR, 'clips', file), wav);
    items.push({ file, truth, synthetic: false, recorded: new Date().toISOString() });
    await fs.writeFile(manifestPath, JSON.stringify(items, null, 2) + '\n');
    return json(res, 200, {
      file, seconds: Number(info.durationSec.toFixed(2)),
      real: items.filter((i) => !i.synthetic).length
    });
  }

  if (req.method === 'GET' && req.url === '/api/eval-clips') {
    const items = JSON.parse(await fs.readFile(path.join(EVAL_DIR, 'manifest.json'), 'utf8').catch(() => '[]'));
    return json(res, 200, { real: items.filter((i) => !i.synthetic) });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use - an older Quorum is probably still running.\n`);
    console.error(`    lsof -ti:${PORT} | xargs kill`);
    console.error(`    PORT=5174 npm run mock      # or just use another port\n`);
    process.exit(1);
  }
  throw err;
});

// Loopback only. Live mode holds an API key, and /api/eval-clip writes files - neither
// should be reachable by anything else on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Quorum listening on http://localhost:${PORT}  (demo at /try, recorder at /record)`);
  console.log(`  mode: ${MOCK ? 'MOCK (no API key needed)' : 'LIVE'}`);
  if (!MOCK && !process.env.ASSEMBLYAI_API_KEY) {
    console.log('  warning: ASSEMBLYAI_API_KEY is not set - run `npm run mock` instead\n');
  } else {
    console.log('');
  }
});
