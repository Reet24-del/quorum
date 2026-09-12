// Vercel Function behind the demo page (/try). Same response as server.js's /api/transcribe.
//
// Whose key: the visitor's own, if their browser sends one (Authorization header), else
// the project's ASSEMBLYAI_API_KEY if one is configured. With neither, it answers from
// the captured sample and says so (mock: true) - the page then shows its sample notice.

import { runQuorum } from '../src/quorum.js';
import { MissingKey } from '../src/assembly.js';

export async function POST(request) {
  const wav = Buffer.from(await request.arrayBuffer());
  if (!wav.length) return Response.json({ error: 'empty clip' }, { status: 400 });

  const key = request.headers.get('authorization') || process.env.ASSEMBLYAI_API_KEY || '';
  const mock = !key;
  try {
    const run = await runQuorum(wav, { key: key || undefined, mock });
    return Response.json({
      mock,
      bytes: wav.length,
      lanes: run.results,
      votingLaneIds: run.voting.map((r) => r.id),
      merged: run.merged,
      timing: run.timing
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: err instanceof MissingKey ? 401 : 502 });
  }
}
