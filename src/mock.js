// Canned lane responses so the whole app runs with no API key: npm run mock
//
// This is NOT invented. It is a real capture from dictation.assemblyai.com on
// 12 Sep 2026 - the clip "ask Saoirse to check the kustomize overlay on etcd"
// sent through all four audio transforms, with the per-word confidence the API
// actually returned. Timings are absent because the beta does not return them.
//
// The untouched lane mishears "Saoirse" as "Sirsha" at 0.28 confidence; two
// transformed lanes hear it correctly at ~0.49, and the merge picks the right one.

const rows = {
  raw: [
    ['Ask', 0.97],
    ['Sirsha', 0.276],
    ['to', 0.999],
    ['check', 1],
    ['the', 0.996],
    ['customize', 0.669],
    ['overlay', 0.997],
    ['on', 0.996],
    ['it.', 0.125]
  ],
  noisy: [
    ['Ask', 0.972],
    ['Saoirse', 0.359],
    ['to', 1],
    ['check', 0.999],
    ['the', 0.998],
    ['customize', 0.763],
    ['overlay', 0.999],
    ['on', 0.998],
    ['it.', 0.735]
  ],
  shifted: [
    ['Ask', 0.991],
    ['Saoirse', 0.48],
    ['to', 1],
    ['check', 1],
    ['the', 0.998],
    ['customize', 0.605],
    ['overlay', 0.999],
    ['on', 0.995],
    ['Edged.', 0.047]
  ],
  slowed: [
    ['Ask', 0.968],
    ['Saoirse', 0.502],
    ['to', 1],
    ['check', 1],
    ['the', 0.998],
    ['customize', 0.694],
    ['overlay', 0.998],
    ['on', 0.998],
    ['it.', 0.319]
  ]
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function transcribeAllMock(wav, lanes) {
  const started = Date.now();
  const results = await Promise.all(lanes.map(async (lane) => {
    const ms = 120 + Math.round(Math.random() * 40);
    await wait(ms);
    const words = (rows[lane.id] || rows.raw).map(([text, confidence]) =>
      ({ text, start: 0, end: 0, confidence }));
    return {
      id: lane.id,
      name: lane.name,
      blurb: lane.blurb,
      text: words.map((w) => w.text).join(' '),
      words,
      ms,
      sessionId: 'mock'
    };
  }));
  return { results, wallMs: Date.now() - started };
}
