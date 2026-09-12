# Quorum

**One recording, heard four ways. Keep the best words.**

Built for the AssemblyAI Dictation API hackathon, 9–13 Sep 2026.

**Live: https://quorum-iota-three.vercel.app.** Try it at `/try`. Paste your own
AssemblyAI key there for live transcription; without one it shows a labelled sample.

---

## The finding

The Dictation model's output is **unstable under changes a listener can't hear.** Double
in faint noise, add 200ms of silence, slow it by 5%, and you get a different transcript.

Here is a real capture from `dictation.assemblyai.com`, one clip sent four ways:

```
spoken      ask Saoirse to check the kustomize overlay on etcd

Untouched   Ask Sirsha  to check the customize overlay on it.
Noised      Ask Saoirse to check the customize overlay on it.
Padded      Ask Saoirse to check the customize overlay on Edged.
Slowed      Ask Saoirse to check the customize overlay on it.
─────────────────────────────────────────────────────────────────
Quorum      Ask Saoirse to check the customize overlay on it.
```

The untouched recording, which is what every dictation app sends, is the one that gets
the name wrong, at **0.28 confidence**. The transformed copies hear it correctly.

Quorum makes that instability useful. It sends every variant **in parallel**, lines the
transcripts up word by word, and settles each disagreement by a vote weighted on the
per-word confidence the API returns. Four calls cost about **1.3× the wall-clock of one**.

## Why audio, not vocabulary

The obvious approach is vocabulary hints: tell the model which names to expect. We built
that first, then measured it against the live endpoint. **The beta accepts `keyterms`,
`prompt`, `word_boost` and similar fields, and ignores them.** Output is byte-identical
with and without, even on clips where the model mishears exactly the hinted term. A 200
response proved nothing; comparing transcripts did.

So vocabulary moved into the merge instead. Quorum keeps a list of terms you're known
to use and uses it **only to break ties between spellings a lane actually heard.** If
three lanes say `Angozi` and one says `Ngozi`, a known `Ngozi` wins. It can never insert
a word no lane produced, so it can't hallucinate a name into your transcript.

## Results

**On 20 real recordings.** One speaker, a laptop mic, and sentences loaded with rare
names and niche tools:

| Untouched | Noised | Padded | Slowed | **Quorum** |
|---|---|---|---|---|
| 30.5% | 19.0% | 33.9% | 35.1% | **16.7%** |

Quorum beats every single lane. It makes **45% fewer errors than sending the recording
untouched**, and 12% fewer than the best variant. It does this without knowing which
variant will be right. On each clip it ties the best lane (19 of 20), but the best lane
changes from clip to clip, so across the whole set it beats any fixed choice.

With the fixed vocabulary list the merge reaches 16.1%. With an oracle list (the answer
key, so a ceiling, not a result) it reaches 15.5%.

**The model switches language on its own.** On an accented voice it sometimes answers in
**Devanagari**, spelling the English phonetically. 10 of the 80 lane calls did this, and
untouched audio did it on 2 of the 20 clips. It can't be switched off: `language_code`,
`language_detection`, a header and a query parameter were all tried, and all were
ignored. Quorum's script guard makes any lane that answers in another script sit out the
vote. The noise lane never switched script, and it rescued both clips where the untouched
audio did.

**Control: the disagreement is real, not noise.** The API is deterministic. We sent
identical audio three times on three clips and got identical text and identical per-word
confidences each time. Every difference between lanes comes from the transform.

**How the lanes were chosen, and the caveat.** Noise replaced an earlier ×2-gain lane
after a screen on these same 20 recordings. The screen used only *unlabelled* measures
(does a transform change the transcript, does it stay in English) and never accuracy,
so the answer key played no part. It is still the same audio, and one speaker. Treat
these numbers as optimistic until they hold on new recordings and new voices.

On 12 synthesised clips (macOS `say`), untouched audio scores 15.9% and Quorum 13.1%.
Synthetic speech is too clean to separate the lanes much.

Other things the probe measured, all of which differ from the public docs:

- typically **1.5–3.5s per call**, occasionally ~7s, not 134ms (responses include an
  `llm_response` field)
- per-word `confidence` is returned, but **no word timings**, so alignment is text-only

---

## Run it

Node 18+, no dependencies.

```bash
npm run mock           # full interface on canned (real, captured) responses, no key needed
```

Open http://localhost:5173 for the landing page. The live demo is at **/try**: hold the
button or the space bar, talk, and let go. Without a key it runs in *sample mode* and
returns one captured example whatever you say; the demo page says so in red.

```bash
export ASSEMBLYAI_API_KEY=your_key_here
npm run probe          # what the endpoint actually does, ~15 seconds
npm start
npm test               # plain node scripts, no framework
npm run eval           # WER table from eval/clips/ + eval/manifest.json
npm run eval:real      # the same, on your real recordings only
```

**Record the eval set in your own voice** at http://localhost:5173/record. It gives
you a sentence to read; hold space, say it, let go, and it's saved straight into
`eval/clips/` with the sentence as its answer key. About twenty takes, then
`npm run eval:real`.

To add a clip without a microphone (placeholder only; real speech is the real test):

```bash
say -v Samantha -o /tmp/c.aiff "your sentence here"
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/c.aiff eval/clips/13.wav
```

**Before a demo, edit `src/lanes.js`.** It holds the four audio transforms and the
vocabulary. Put the names you'll actually say into `VOCABULARY`.

---

## Use it as a drop-in API

Already calling AssemblyAI's Dictation endpoint? Point the same request at Quorum.
Keep the same `audio` form field and the same headers, and change only the URL:

```bash
curl http://localhost:5173/transcribe \
  -H "Authorization: $ASSEMBLYAI_API_KEY" \
  -H "X-AAI-Model: universal-3-5-pro" \
  -F "audio=@clip.wav;type=audio/wav"
```

The same command against both hosts, on a real recording of "tell Siobhan the Grafana
Loki shards are backing up":

```
dictation.assemblyai.com   Tell CEO Bhan the Grafana Loki shards are backing up.
localhost:5173 (Quorum)    Tell Siobhan the Grafana Loki shards are backing up.
```

The response has the API's own shape (`text`, `words` with per-word `confidence`,
`confidence`, `audio_duration_ms`), so an existing client needs no other change. It
also carries an extra `quorum` block, with every lane's transcript, whether it voted,
the number of disputes and the timing, which a client can use or ignore.

**Your `Authorization` header is passed through** as the key for all four lane calls,
so each caller pays for their own usage; the server's key is only a fallback. Raw PCM
bodies (no WAV header, 16 kHz mono assumed) are accepted too, as the API accepts them.

Keep `;type=audio/wav` on the `-F`. AssemblyAI rejects an audio part labelled
`application/octet-stream`, which is curl's default, with **415 Unsupported Media Type**.
Quorum accepts either label, but the command above is the one that works against both.

## Deploy

The repo deploys to Vercel as it is. `public/` is served as static files, and `api/` holds
three functions: `/api/lanes`, `/api/transcribe`, and the drop-in, which is served at
`/transcribe`. `.vercelignore` keeps the eval recordings out of the upload.

**The hosted site has no AssemblyAI key of its own.** A visitor can paste theirs into the
demo page. It stays in their browser and is forwarded with each clip, and is never stored.
Without a key, the demo runs in clearly labelled sample mode. The public drop-in only ever
uses the caller's key. Recording (`/record`) needs the local server, because it writes
into the repo.

```bash
npx vercel deploy          # preview
npx vercel deploy --prod   # production
```

## How the merge works

All in `src/align.js`:

1. **Align.** Line the lanes up word by word (progressive Needleman–Wunsch on spelling
   similarity).
2. **Segment.** Spans where every lane agrees become anchors and are never rewritten.
   Everything else is a dispute.
3. **Vote.** Each dispute is settled between competing *phrases*, scored on headcount
   plus mean confidence, plus a bonus if the phrase is a known term.

Voting on phrases rather than single words matters: one lane's `kubectl` has to be able
to beat two lanes' `cube cuttle`. Where lanes spell the same words differently (`Roll
back` / `Rollback`), the most common spelling wins.

At default settings, a lone lane needs to be about **0.33 more confident** than a pair
to overrule it. Adding more lanes makes that harder, not easier. The derivation and the
alternatives we rejected are in [docs/design.md](docs/design.md).

---

## Demo video

`public/reel.html` is the 90-second demo. Every transcript, confidence and timing in it
comes from real captures (`demo/captures/`). The two live demos play the owner's own
recordings, and an AI narrator (macOS's built-in Daniel voice) describes everything
else. The narration is timed so the two voices never overlap. Preview it with sound at http://localhost:5173/reel. To rebuild the MP4,
using only Apple frameworks (no ffmpeg, no browser install):

```bash
node demo/build.mjs
swiftc -O -swift-version 5 demo/render.swift -o /tmp/render-reel
/tmp/render-reel video "http://localhost:5173/reel?render=1" public/reel/soundtrack.m4a quorum-demo.mp4
```

## Layout

```
src/align.js        align, segment, vote          <- the core
src/lanes.js        the audio transforms and vocabulary: tune this
src/audio.js        gain, pad, stretch, normalise
src/assembly.js     endpoint client, parallel fan-out, lane dropout
src/wer.js          word error rate
src/mock.js         a real capture from the live API, for offline demos
server.js           local server; the only thing that holds the API key
probe.js            endpoint reconnaissance
eval.js             the accuracy harness
public/index.html   landing page
public/try.html     the live demo (with app.js)
public/record.html  the eval recorder (with record.js)
public/site.css     shared tokens, nav, buttons, footer
test/               merge, WER, WAV encoding, lane dropout
docs/               design notes and the original PRD
```
