// Vercel Function for the drop-in endpoint (vercel.json rewrites /transcribe here).
// Same request and response shape as AssemblyAI's Dictation API.
//
// On the public deployment this ONLY ever uses the caller's own key. Unlike the local
// server it never falls back to the project's key, so a stranger can't spend it.

import { runQuorum, toAssemblyShape, asWav, durationMs } from '../src/quorum.js';
import { extractAudio } from '../src/multipart.js';
import { MissingKey } from '../src/assembly.js';

export async function POST(request) {
  const key = request.headers.get('authorization');
  if (!key) {
    return Response.json({ error: 'Send your own AssemblyAI key in the Authorization header. The drop-in bills the caller.' }, { status: 401 });
  }
  const body = Buffer.from(await request.arrayBuffer());
  const audio = extractAudio(body, request.headers.get('content-type') || '');
  if (!audio || !audio.length) {
    return Response.json({ error: 'No audio. Send a multipart form with an "audio" file part, or a raw WAV/PCM body.' }, { status: 400 });
  }
  const wav = asWav(audio);
  try {
    const run = await runQuorum(wav, { key, model: request.headers.get('x-aai-model') || undefined });
    return Response.json(toAssemblyShape(run, { audioDurationMs: durationMs(wav) }));
  } catch (err) {
    return Response.json({ error: err.message }, { status: err instanceof MissingKey ? 401 : 502 });
  }
}
