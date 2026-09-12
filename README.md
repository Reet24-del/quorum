# Quorum

**Transcribe every utterance three ways at once, then let the words vote.**

Built for the AssemblyAI Dictation API hackathon, 9–13 Sep 2026.

---

## The idea

Speech-to-text mishears unusual words — names, CLI tools, product nouns. The Dictation
API can fix this: pass a list of expected terms with the audio and word error rate drops
**10.2%**, concentrated on exactly those words.

But you have to choose the hint list *before* the person speaks, and real speech is
mixed. One sentence holds a teammate's name, a deploy command, and plain English.
Priming for one degrades the others.

So don't choose. The endpoint answers in ~134 ms, which makes it cheap enough to call
**redundantly**. Send the same clip to three hint sets at once, and merge the answers
using the per-word confidence scores that come back with them.

```
A · no hints     push the cube cuttle config to staging and tell prea
B · dev terms    push the kubectl config to stagehand tell prea
C · contacts     push the cube cuttle config to staging and tell Priya
─────────────────────────────────────────────────────────────────────
Quorum           push the kubectl config to staging and tell Priya
```

No individual lane is correct. B knows `kubectl` but breaks "staging and"; C knows Priya
but not the tool. **The merged line is a sentence none of the three returned.**

This only works on an API this fast. Three sequential calls anywhere else would take
three seconds and feel broken.

---

## Run it

Needs Node 18+. No dependencies.

**Without an API key** — canned responses, full interface, good for building:

```bash
npm run mock
```

Open http://localhost:5173, hold the button (or the spacebar), talk, let go.

**With a key** — check the endpoint first:

```bash
export ASSEMBLYAI_API_KEY=your_key_here
npm run probe          # answers the two blocking questions, ~15 seconds
npm start
```

`npm run probe` reports whether the beta accepts vocabulary hints and under which
parameter name, whether per-word confidence and timings come back, and whether three
concurrent calls actually run in parallel. It prints the exact env vars to set. Run it
before trusting anything else.

```bash
npm test               # 51 assertions, no framework
npm run eval           # accuracy table from eval/clips/ + eval/manifest.json
```

To record eval clips without a microphone (placeholders only — see Status):

```bash
say -v Samantha -o /tmp/c.aiff "push the kubectl config to staging and tell Priya"
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/c.aiff eval/clips/01.wav
```

---

## Layout

```
src/align.js           align → segment → vote           ← the project
src/assembly.js        endpoint client, fan-out, lane dropout
src/wer.js             word error rate
src/lanes.js           the three vocabularies — tune this for your demo
src/mock.js            canned lanes, runs without a key
server.js              HTTP, custody of the API key
probe.js               endpoint reconnaissance — run this first
eval.js                the accuracy measurement
public/wav.js          WAV encoding, shared with the tests
public/                push-to-talk capture and the three-lane view
test/                  51 assertions: merge, WER, WAV encoding, lane dropout
docs/design.md         how the merge works, and what was rejected
docs/prd.html          requirements, metrics, schedule
```

**`src/lanes.js` is the file to edit before a demo.** Put the names and terms you will
actually say into the lane vocabularies — a judge's own name in the contacts lane is the
single best thing you can do to the demo.

---

## How the merge works

Three stages, all in `src/align.js`:

1. **Align** — line the lanes up word by word, scoring on spelling similarity *and*
   time-span overlap. All three heard the same audio, so words occupying the same moment
   are probably the same slot even when the text differs completely.
2. **Segment** — spans where every lane agrees become anchors and are never rewritten.
   Everything else is a dispute.
3. **Vote** — each disputed span is settled between competing *phrases*, scored on vote
   count and mean confidence together.

Voting on phrases rather than single words is the load-bearing decision. `kubectl` is one
word where the other lanes heard two (`cube cuttle`); word-by-word voting lets the
two-vote majority survive and yields `kubectl cuttle`. Grouping the span first lets one
confident lane outvote a confident-sounding pair.

At the default settings a lone lane needs to be **0.33 more confident** than a pair to
overrule it. Full derivation, tuning table, and the alternatives that were considered
and rejected are in [docs/design.md](docs/design.md).

---

## Status

**Complete and verified**, 51 tests passing, ~1,500 lines, zero dependencies.

The merge, the parallel fan-out, push-to-talk capture, the three-lane view, the
endpoint probe, mock mode, the word-error-rate harness, and lane failure tolerance —
a lane that errors or times out drops out and the survivors still vote.

Verified end to end in mock mode: a clip goes in, three transcripts come back,
the merge repairs all three disagreements, and the interface renders it in
**150 ms wall against 420 ms serial**.

Two things remain, and both need something only you can supply:

- **Run the probe** (needs your API key). Everything assumes vocabulary hints are
  accepted and that three calls run concurrently. Neither is confirmed against the
  beta host. The probe answers both in about 15 seconds.
- **Record the eval set** (needs your voice). There are six synthesised placeholder
  clips in `eval/clips/` so the harness runs today, but text-to-speech is cleaner and
  more canonical than a real voice - it flatters every lane and understates what the
  merge is worth. `eval.js` warns you about this on every run. Replace them with your
  own recordings; twenty is the floor for a credible number.

---

## Docs

- [docs/prd.html](docs/prd.html) — problem, goals, non-goals, requirements, metrics, schedule.
  Published at https://claude.ai/code/artifact/e8480306-5496-4508-b35c-262eaa28a172
  *(updating that page means republishing against the URL, not the file path)*
- [docs/design.md](docs/design.md) — architecture, the merge in detail, tuning parameters,
  failure modes, rejected alternatives.
