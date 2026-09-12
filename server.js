// Tiny local server. Holds the API key (so the browser never sees it),
// fans one clip out to every lane, merges, returns the whole picture.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES, VOCABULARY } from './src/lanes.js';
import { transcribeAll, MissingKey } from './src/assembly.js';
import { transcribeAllMock } from './src/mock.js';
import { merge } from './src/align.js';
import { guardScript } from './src/script.js';
import { decodeWav } from './public/wav.js';

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
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
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
    try {
      wav = await readBody(req);
    } catch (err) {
      return json(res, 413, { error: err.message });
    }
    if (!wav.length) return json(res, 400, { error: 'empty clip' });

    try {
      const runner = MOCK ? transcribeAllMock : transcribeAll;
      const { results, wallMs } = await runner(wav, LANES);

      // Only lanes that answered, in the expected script, get a vote. The rest still come
      // back to the client so the interface can show which opinion is missing, and why.
      const { voting, offScript } = guardScript(results);
      for (const r of offScript) r.error = `answered in ${r.script}, so it sat out the vote`;
      const merged = merge(voting.map((r) => r.words), { vocabulary: VOCABULARY });
      const slowest = results.reduce((m, r) => Math.max(m, r.ms), 0);
      return json(res, 200, {
        mock: MOCK,
        bytes: wav.length,
        lanes: results,
        votingLaneIds: voting.map((r) => r.id),
        merged,
        timing: {
          wallMs,           // what the user actually waited for all 3
          slowestLaneMs: slowest,
          sumOfLanesMs: results.reduce((s, r) => s + r.ms, 0) // what it WOULD cost in series
        }
      });
    } catch (err) {
      const code = err instanceof MissingKey ? 401 : 502;
      console.error('[transcribe]', err.message);
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

server.listen(PORT, () => {
  console.log(`\n  Quorum listening on http://localhost:${PORT}`);
  console.log(`  mode: ${MOCK ? 'MOCK (no API key needed)' : 'LIVE'}`);
  if (!MOCK && !process.env.ASSEMBLYAI_API_KEY) {
    console.log('  warning: ASSEMBLYAI_API_KEY is not set - run `npm run mock` instead\n');
  } else {
    console.log('');
  }
});
