# Quorum

**One recording, heard four ways. Keep the best words.**

Built for the AssemblyAI Dictation API hackathon, 9–13 Sep 2026.

---

## The finding

The Dictation model's output is **unstable under changes a listener can't hear.** Double
the gain, add 200ms of silence, slow it by 5%, and you get a different transcript.

Here is a real capture from `dictation.assemblyai.com`, one clip sent four ways:

```
spoken      ask Saoirse to check the kustomize overlay on etcd

Untouched   Ask Sirsha  to check the customize overlay on it.
Amplified   Ask Saoirse to check the customize overlay on Ed.
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

## Results so far

Word error rate on 12 clips, six of them loaded with rare names and niche tooling:

| Untouched | Amplified | Padded | Slowed | **Quorum** |
|---|---|---|---|---|
| 15.9% | 13.1% | 12.1% | 15.0% | **13.1%** |

Quorum beats the untouched recording. It does **not** yet beat the best single variant,
and you can't know in advance which variant that will be. Where it loses, the cause is
visible in the data: three lanes agree on a wrong word at the *same* confidence as the
one lane that got it right, which leaves the vote nothing to act on. That's the case the
vocabulary tie-breaker targets.

**Vocabulary, measured.** With the fixed list in `src/lanes.js` the score doesn't move
(13.1%). That's expected: the list was written before the hard clips and doesn't contain
their names. With an *oracle* list, meaning the answer key (a ceiling, not a result), it
reaches **12.1%**. That recovers `Ngozi` and matches the best single variant. So the
tie-breaker works exactly when you've listed the names you'll say, which is the realistic
case for a team's own vocabulary.

**Control: the disagreement is real, not noise.** The API is deterministic. We sent
identical untouched audio three times on three clips and got identical text and
identical per-word confidences every time. Every difference between lanes is caused by
the transform.

**Caveat:** every eval clip is synthesised speech (macOS `say`), which is cleaner than a
real voice. These numbers show the mechanism works. They are not the final result.

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

Open http://localhost:5173, then hold the button or the spacebar, talk, and let go.

```bash
export ASSEMBLYAI_API_KEY=your_key_here
npm run probe          # what the endpoint actually does, ~15 seconds
npm start
npm test               # plain node scripts, no framework
npm run eval           # WER table from eval/clips/ + eval/manifest.json
npm run eval:real      # the same, on your real recordings only
```

**Record the eval set in your own voice** at http://localhost:5173/record.html. It gives
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
public/             push-to-talk capture and results view
test/               merge, WER, WAV encoding, lane dropout
docs/               design notes and the original PRD
```
