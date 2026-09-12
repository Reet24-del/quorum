// Push-to-talk -> 16kHz mono WAV -> POST -> render three lanes and the merge.

import { encodeWav } from './wav.js';

const micBtn = document.getElementById('mic');
const micLabel = document.getElementById('micLabel');
const replayBtn = document.getElementById('replay');
const out = document.getElementById('out');
const modeBadge = document.getElementById('mode');
const tag = document.getElementById('tag');

let ctx = null, stream = null, node = null, sink = null, chunks = [], recording = false;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- audio
async function startRecording() {
  if (recording) return;
  recording = true;
  chunks = [];
  micBtn.classList.add('live');
  micLabel.textContent = 'Listening…';

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch {
    recording = false;
    micBtn.classList.remove('live');
    micLabel.textContent = 'Hold to talk';
    return showError('Microphone blocked.', 'Allow mic access for this page, then reload.');
  }

  ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  // Route into a muted sink so the processor runs without feeding audio back out.
  sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove('live');
  micLabel.textContent = 'Hold to talk';

  const rate = ctx ? ctx.sampleRate : 16000;
  try { node.disconnect(); sink.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  await ctx?.close().catch(() => {});
  ctx = null;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total / rate < 0.08) return;            // under the API's 80ms floor

  const flat = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { flat.set(c, at); at += c.length; }
  await send(encodeWav(flat, rate));
}

// ---------------------------------------------------------------- request

// Kept so you can change src/lanes.js and re-run the *same* audio through the new
// vocabularies. Also the safety net if the mic fails in front of a judge.
let lastWav = null;

async function send(wav) {
  lastWav = wav;
  replayBtn.hidden = false;
  out.innerHTML = '<section><div class="idle">Asking three times…</div></section>';
  let res, data;
  try {
    res = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav
    });
    data = await res.json();
  } catch (err) {
    return showError('Could not reach the server.', 'Is it still running on port 5173?');
  }
  if (!res.ok) {
    const hint = res.status === 401
      ? 'Set ASSEMBLYAI_API_KEY, or run <code>npm run mock</code> to work without one.'
      : 'Check the server log for the full response.';
    return showError(esc(data.error || `HTTP ${res.status}`), hint);
  }
  render(data);
}

function showError(msg, hint) {
  out.innerHTML = `<section><div class="err"><b>${msg}</b><br>${hint}</div></section>`;
}

// ---------------------------------------------------------------- render

// Replay a single lane through the merged alignment, so every row lines up
// with the others and its wins and losses are visible in place.
function laneLine(segments, k) {
  return segments.map((s) => {
    if (s.type === 'agree') return esc(s.text);
    const c = s.candidates[k];
    if (!c || !c.text) return '<span class="lost">&mdash;</span>';
    return `<span class="${c.won ? 'won' : 'lost'}">${esc(c.text)}</span>`;
  }).join(' ');
}

function render(d) {
  const segs = d.merged.segments;

  const finalLine = segs.map((s) =>
    s.type === 'agree' ? esc(s.text) : `<span class="fixed">${esc(s.text)}</span>`
  ).join(' ');

  const serial = d.timing.sumOfLanesMs;
  const wall = d.timing.wallMs;
  const factor = wall > 0 ? (serial / wall).toFixed(1) : '—';

  // Candidates are indexed by position among the lanes that actually voted,
  // which is not the same list as all lanes once one has dropped out.
  const voting = d.votingLaneIds || d.lanes.map((l) => l.id);
  const lanes = d.lanes.map((l) => {
    const k = voting.indexOf(l.id);
    const said = l.error
      ? `<span class="dropped">dropped &mdash; ${esc(l.error)}</span>`
      : laneLine(segs, k);
    return `
    <div class="lane">
      <div class="who"><b>${esc(l.name)}</b>${esc(l.blurb || '')}</div>
      <div class="said">${said}</div>
    </div>`;
  }).join('');

  const dropped = d.lanes.filter((l) => l.error).length;

  const disputes = segs.filter((s) => s.type === 'dispute');
  const disputeBlocks = disputes.map((s, i) => `
    <div class="dispute">
      <div class="head">${i + 1}. settled on <b>${esc(s.text)}</b></div>
      <div class="opts">${s.candidates.map((c) => `
        <span class="opt ${c.won ? 'won' : ''}">${esc(c.text || '(nothing)')}<span class="c">${c.confidence.toFixed(2)}</span></span>
      `).join('')}</div>
    </div>`).join('');

  out.innerHTML = `
    <section>
      <h2>Merged</h2>
      <div class="final">${finalLine}</div>
      <div class="timing">
        <span><b>${voting.length}</b> transcriptions${dropped ? ` <i>(${dropped} dropped)</i>` : ''}</span>
        <span><b>${wall} ms</b> waited</span>
        <span><b>${serial} ms</b> if run one after another &middot; ${factor}&times; saved</span>
        <span><b>${disputes.length}</b> contested</span>
      </div>
    </section>
    <section>
      <h2>What each lane heard</h2>
      ${lanes}
    </section>
    ${disputes.length ? `<section><h2>Where they disagreed</h2>${disputeBlocks}</section>` : ''}
  `;
}

// ---------------------------------------------------------------- input

micBtn.addEventListener('mousedown', startRecording);
micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); }, { passive: false });
window.addEventListener('mouseup', stopRecording);
window.addEventListener('touchend', stopRecording);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target === document.body) { e.preventDefault(); startRecording(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); stopRecording(); }
});

replayBtn.addEventListener('click', () => { if (lastWav) send(lastWav); });

const WORDS = ['', 'one way', 'two ways', 'three ways', 'four ways', 'five ways', 'six ways'];

fetch('/api/lanes').then((r) => r.json()).then((d) => {
  // The tagline states the lane count, so it has to come from the config rather
  // than being written into the markup - the count changes when lanes.js changes.
  const n = d.lanes?.length || 0;
  if (n) tag.textContent = `One recording, heard ${WORDS[n] || n + ' ways'}. Keep the best words.`;
  if (d.mock) {
    modeBadge.textContent = 'mock data';
    modeBadge.hidden = false;
    // Mock ignores the audio, so seed a clip and let the whole view be
    // exercised with no microphone at all.
    lastWav = encodeWav(new Float32Array(1600), 16000);
    replayBtn.textContent = 'Run a sample';
    replayBtn.hidden = false;
  }
}).catch(() => {});
