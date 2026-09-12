// Record real speech into the eval set: read, hold, release, saved.
//
// Capture mirrors app.js on purpose rather than sharing a module with it - the demo
// page's capture path cannot be exercised headlessly, so it is left untouched.

import { encodeWav } from './wav.js';

// Sentences built to stress the model: rare names, niche tools, mixed in with plain
// English. Edit freely - the textarea is what gets saved as the answer key.
const SUGGESTIONS = [
  'ask Saoirse to check the kustomize overlay on etcd',
  'Ngozi says the Zalando postgres operator is flaking in ArgoCD',
  'tell Siobhan the Grafana Loki shards are backing up',
  'Tadhg wants the Istio sidecar pinned before Thursday',
  'ping Oluwaseun about the ClickHouse migration',
  'Xiomara flagged a regression in the Kubeflow pipeline',
  'push the kubectl config to staging and tell Priya',
  'can Aanya rebase the Terraform branch before the Vercel deploy',
  'the Supabase webhook keeps returning a JWT error',
  'roll back nginx on the Toronto cluster and ping Rahul',
  'Marcus thinks the gRPC endpoint needs an OAuth refresh',
  'Yuki said the Redis eviction policy is still idempotent',
  'schedule a sync with Ines about the AssemblyAI integration',
  'Reet will demo Quorum to the judges on Saturday',
  'Bhavesh moved the Prometheus alerts into PagerDuty',
  'Aoife found a memory leak in the Rust tokio runtime',
  'send Kwame the Figma link and the Linear ticket',
  'Dmitri says the Kafka consumer lag is over ten thousand',
  'Nairobi and Lisbon both reported the Postgres failover',
  'Siddharth wants the Datadog monitors muted until Monday'
];

const truthEl = document.getElementById('truth');
const micBtn = document.getElementById('mic');
const micLabel = document.getElementById('micLabel');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const listEl = document.getElementById('list');
const posEl = document.getElementById('pos');

let at = 0;
let ctx = null, stream = null, node = null, sink = null, chunks = [], recording = false;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(i) {
  at = (i + SUGGESTIONS.length) % SUGGESTIONS.length;
  truthEl.value = SUGGESTIONS[at];
  posEl.textContent = `suggestion ${at + 1} of ${SUGGESTIONS.length}`;
}

function say(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isErr);
}

async function refresh() {
  try {
    const { real } = await (await fetch('/api/eval-clips')).json();
    countEl.innerHTML = `${real.length}<small>of about 20</small>`;
    listEl.innerHTML = real.length
      ? real.slice().reverse().map((i) =>
          `<li><span class="f">${esc(i.file)}</span><span class="t">${esc(i.truth)}</span></li>`).join('')
      : '<li><span></span><span class="empty">Nothing recorded yet.</span></li>';
  } catch {
    say('Could not reach the server. Is it running?', true);
  }
}

async function start() {
  if (recording) return;
  if (!truthEl.value.trim()) return say('Type the sentence you are about to say first.', true);
  recording = true;
  chunks = [];
  micBtn.classList.add('live');
  micLabel.textContent = 'Recording';
  say('release to save');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch {
    recording = false;
    micBtn.classList.remove('live');
    micLabel.textContent = 'Hold to record';
    return say('Microphone blocked. Allow mic access for this page, then reload.', true);
  }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => {
    if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
}

async function stop() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove('live');
  micLabel.textContent = 'Hold to record';

  const rate = ctx ? ctx.sampleRate : 16000;
  try { node.disconnect(); sink.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => t.stop());
  await ctx?.close().catch(() => {});
  ctx = null;

  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total / rate < 0.5) return say('Too short. Hold for the whole sentence.', true);

  const flat = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { flat.set(c, off); off += c.length; }

  say('saving…');
  try {
    const res = await fetch('/api/eval-clip', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Truth': encodeURIComponent(truthEl.value.trim()) },
      body: encodeWav(flat, rate)
    });
    const data = await res.json();
    if (!res.ok) return say(data.error || `Save failed (HTTP ${res.status}).`, true);
    say(`saved ${data.file} · ${data.seconds}s · ${rate} Hz`);
    await refresh();
    show(at + 1);
  } catch {
    say('Could not reach the server. Is it running?', true);
  }
}

document.getElementById('next').addEventListener('click', () => show(at + 1));
micBtn.addEventListener('mousedown', start);
micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
window.addEventListener('mouseup', stop);
window.addEventListener('touchend', stop);
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target !== truthEl) { e.preventDefault(); start(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && e.target !== truthEl) { e.preventDefault(); stop(); }
});

show(0);
refresh();
