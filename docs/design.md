# Quorum — Design

Technical design for the merge. The PRD covers *what* and *why*; this covers *how*,
and records the decisions that were live options at the time so they don't get
relitigated at 2am on Saturday.

---

## 1. Overview

One clip of audio goes to the AssemblyAI Dictation endpoint **N times concurrently**,
each request carrying a different vocabulary hint. The responses disagree. Quorum
aligns them, finds the spans where they disagree, and settles each span by a vote
weighted on per-word confidence.

The whole design rests on one property of the endpoint: at ~134 ms, a transcription
is cheap enough to be called redundantly. Nothing here works on an API that takes a
second.

---

## 2. Architecture

```
browser                      localhost:5173                  AssemblyAI
───────                      ──────────────                  ──────────
mic capture
  │ Float32 @ 16kHz
  ▼
WAV encode (PCM S16LE)
  │
  │  POST /api/transcribe
  │  body: raw WAV bytes
  ▼
                        server.js
                             │  fan out, Promise.all
                             ├──────────────────────────────▶ lane: cold
                             ├──────────────────────────────▶ lane: code
                             └──────────────────────────────▶ lane: people
                                                                  │
                             ┌────────────────────────────────────┘
                             ▼
                        align.js  →  merge()
                             │
  ◀──────────────────────────┘
  │  { lanes[], merged, timing }
  ▼
render three lanes + merged
```

**Why a local server at all.** The API key cannot ship to the browser. The server is
the only component that holds it. It's ~110 lines of `node:http` with no dependencies.

**Why raw WAV as the request body** rather than multipart from the browser: the server
has to rebuild the multipart for AssemblyAI anyway, and raw bytes mean no multipart
parser on the Node side. `Content-Type: audio/wav`, body is the file, done.

---

## 3. The merge

Three stages. Stage 3 is where the idea lives; stages 1 and 2 exist to make stage 3
possible.

### Stage 1 — Align

The lanes return different word counts for the same audio, so the sequences have to be
lined up before anything can be compared.

**Pairwise similarity** between two words blends text and time:

```
textSim = 1 − levenshtein(normA, normB) / max(len)      // normalised: lowercase, [a-z0-9'_]
timeSim = |overlap| / |union|                            // IoU of the two [start,end] spans
sim     = 0.65·textSim + 0.35·timeSim
score   = 2·sim − 1                                      // → [−1, 1] so a bad match costs
```

Timing carries real signal here: every lane heard the *same* audio, so two words
occupying the same moment are almost certainly the same slot even when the text differs
wildly (`cube` vs `kubectl`). Text is weighted higher because word *boundaries* shift
exactly where lanes disagree — which is why timing alone is not enough (see §7.6).

If a response has no timings, `timeSim` returns a constant 0.5 and alignment falls back
to text similarity. It still works; it gets worse on repeated words.

**Alignment** is Needleman–Wunsch, gap penalty −0.5.

**More than two lanes** are handled by progressive alignment: lane 0 seeds a column
profile, each subsequent lane is aligned against that profile, and a word's score
against a column is its best score against any member of that column. Gaps introduced
by a later lane insert new columns.

Cost is `O(L · C · n)` — three lanes, a few hundred words. Immeasurable next to the
network call.

### Stage 2 — Segment

Walk the columns. A column where **every lane is present and all agree** (after
normalisation) is an *anchor*. Runs of everything else become *dispute segments*.

Anchors are never rewritten. If all three lanes agree on a word, no voting can touch it
— this is what stops the merge from being able to make things worse on easy input.

### Stage 3 — Vote

For each dispute segment, every lane contributes the **phrase** formed by its words
across that whole run — possibly empty, if it had nothing there.

Lanes proposing the same phrase share one ballot:

```
score = α · (votes / L)  +  (1 − α) · meanConfidence
```

with `α = 0.5`, and an absent phrase scored at `nullConf = 0.55` so that "this lane
heard nothing here" is a real ballot rather than an automatic loss.

Highest score wins; ties break on confidence.

#### The decision boundary

A lone lane (1 vote) overrules a group of `k` agreeing lanes when

```
c_solo − c_group  >  α·(k−1) / ((1−α)·L)
```

For the case that actually occurs at three lanes — one against two — that evaluates to
**1/3 at the default α**: a single lane must be 0.33 more confident than the pair to
overrule it. That number is the personality of the whole system, and it is the thing
to tune:

| α    | threshold (L=3, k=2) | behaviour |
|------|----------------------|-----------|
| 0.3  | 0.14                 | confidence-led; a sure lane overrules easily. Noisier. |
| 0.5  | 0.33                 | **default.** A pair is overruled only by real certainty. |
| 0.7  | 0.78                 | headcount-led; a lone lane almost never wins. Close to majority vote. |

Verified against the implementation by bisecting the flip point: measured and predicted
agree to four decimals across α ∈ {0.3, 0.5, 0.7}.

Note the `(k−1)/L` term. **Adding lanes makes it harder for a lone correct lane to
win**, not easier — at five lanes with four agreeing, the threshold is 0.60, which a
real confidence score rarely clears. This is an argument against scaling lane count
naively, and it feeds §10.1.

#### Worked example

Spoken: *"push the kubectl config to staging and tell Priya"*

| dispute | lane A | lane B | lane C | scores | winner |
|---|---|---|---|---|---|
| 1 | `cube cuttle` ·42 | `kubectl` ·94 | `cube cuttle` ·45 | pair .550 / solo **.637** | `kubectl` |
| 2 | `staging and` ·95 | `stagehand` ·52 | `staging and` ·94 | pair **.806** / solo .427 | `staging and` |
| 3 | `prea` ·38 | `prea` ·39 | `Priya` ·91 | pair .526 / solo **.622** | `Priya` |

Result: `push the kubectl config to staging and tell Priya` — which **no individual lane
returned.** Dispute 2 is the important one: it shows the majority winning when it
deserves to, so dispute 1 and 3 aren't just "always trust the outlier."

---

## 4. Tuning parameters

All in `DEFAULTS` in `src/align.js`, all overridable per call.

| param | default | effect |
|---|---|---|
| `alpha` | 0.50 | headcount vs confidence. See the table above. |
| `nullConf` | 0.55 | how much weight "this lane heard nothing" carries. Raise it to delete more aggressively; lower it to keep more words. |
| `wText` | 0.65 | alignment: weight on word spelling |
| `wTime` | 0.35 | alignment: weight on time overlap. Set to 0 if the API returns no timings. |
| `gapPenalty` | −0.50 | alignment: cost of an unmatched word. Less negative → more gaps, more columns. |
| `laneWeights` | all 1 | per-lane confidence multiplier. The hook for calibration (§6). |

---

## 5. API contract

**Confirmed** (public documentation):

```
POST https://dictation.assemblyai.com/transcribe
Authorization: <key>
X-AAI-Model: universal-3-5-pro
multipart: audio = WAV or PCM S16LE, 16kHz, 80ms–2min, ≤40MB
```

**Not confirmed:** the parameter names for the vocabulary hints. `src/assembly.js`
isolates them in one constant:

```js
const HINT_FIELDS = { keyterms: 'keyterms', prompt: 'prompt' };
```

Overridable by env (`QUORUM_KEYTERM_FIELD`, `QUORUM_PROMPT_FIELD`) so the probe can find
the right names without a code change. Candidates if these are rejected:
`keyterms_prompt`, `word_boost`, `keywords`.

**Response parsing is defensive by design** — `parseWords()` accepts `words` or
`utterances`, `text`/`word`, `confidence`/`conf`, and detects milliseconds by checking
whether any end time exceeds 1000 (a clip is capped at two minutes, so it cannot
legitimately reach 1000 seconds).

---

## 6. Failure modes

| what breaks | what happens | status |
|---|---|---|
| Hints unsupported by the beta | Lanes become identical; every column is an anchor; output equals a single call. **Fallback:** differentiate lanes on audio instead (gain, clip-boundary padding). | Thesis survives |
| No per-word timings | `timeSim` → constant; alignment is text-only. Worse on repeated words. | Degrades |
| A lane errors or times out | Drops out (8s timeout); survivors still vote. Returned to the client marked failed so the interface can show the missing opinion. | Tested |
| *Every* lane fails | Throws the first cause rather than returning an empty transcript that reads as silence. | Tested |
| Concurrency capped at 1 | Lanes serialise; wall-clock ≈ 3× single. Latency claim dies. | **Blocking unknown** |
| Confidence miscalibrated across lanes | A primed lane is confidently wrong; votes skew. Mitigate with `laneWeights` fitted on the eval set. | Open risk |
| All lanes agree | Zero disputes, passthrough. | Tested |
| Differing word counts | NW gaps absorb it. | Tested (8 vs 10 words) |
| Empty lane | Contributes gap ballots; effectively abstains. | Tested |

---

## 7. Rejected alternatives

**7.1 Word-level voting (classic ROVER).** The obvious approach, and wrong here. With
`cube|cuttle` against `kubectl`, word-level voting aligns `kubectl` to one of the two
and leaves the other facing a gap — where a 2-vote majority keeps `cuttle`, producing
`kubectl cuttle`. Word-level voting cannot express a many-to-one correspondence.
Phrase-level segmentation is the fix and is the central design decision of the project.

**7.2 An LLM as the merger.** Hand three transcripts to a model, ask for the best
sentence. Rejected on three counts: it adds 400–800 ms to a pipeline whose entire claim
is latency; it is non-deterministic, so the error-rate table stops being reproducible;
and it makes the result unattributable — you could no longer say the *confidence scores*
did the work, which is the interesting finding.

**7.3 A classifier picking one lane up front.** This is the thing the project argues
against. It also needs labelled training data we don't have.

**7.4 Sequential lanes with early exit** (skip the rest if lane A is confident). Saves
quota, kills the demo — the parallelism is the visible idea. Worse, "confident but
wrong" is the exact failure mode being corrected.

**7.5 Audio-variation lanes as the primary axis.** Kept as the fallback (§6), not the
headline, because vocabulary hints have a published WER figure to point at and audio
jitter does not.

**7.6 Timing-only alignment.** Tempting given all lanes share a clock, but word
boundaries diverge precisely where lanes disagree — `kubectl` spans two words' worth of
time. Timing alone misaligns exactly where alignment matters most. Hence the 0.65/0.35
blend favouring text.

---

## 8. Testing

`test/align.test.js`, no framework, `node test/align.test.js`. 9 assertions, all
passing.

The fixture is the worked example above, with hand-written timings that reproduce the
real structure of the problem: lane B collapses two words into one (`kubectl`) and
swallows a word into the next (`stagehand`). Both are the cases that break naive
merging.

What it proves:

- the merged text equals ground truth
- **each lane alone does not** — asserted explicitly, so the test fails if the fixture
  ever drifts into "one lane was right all along"
- exactly 3 disputes are found
- unanimous input passes through with 0 disputes
- single-lane and empty-lane inputs don't throw

`test/wer.test.js` covers the scoring itself — substitutions, deletions, insertions,
case and punctuation folding — plus the comparison the harness actually makes: on the
fixture, the lanes score 33.3% / 33.3% / 22.2% and the merge scores 0%.

`test/dropout.test.js` runs against a local stub server, never the live API, and
asserts that one failing lane leaves the other two voting, that total failure throws
rather than returning silence, and that a missing key is reported as a missing key.

Writing that test surfaced a real defect: the endpoint URL was bound to a module-level
constant at import time, so it could not be redirected — the first run of the test
fired at the live API instead of the stub and came back 401. Endpoint, model, and hint
field names are now read at call time.

`test/wav.test.js` covers the riskiest untested path. It encodes real macOS-synthesised
speech with the *same* function the browser uses and asserts the bytes are exactly the
documented format - PCM, mono, 16 kHz, 16-bit, no extra chunks - and that audio survives
the round trip to within one quantisation step. It also proves the decoder skips the
`FLLR` padding chunk `afconvert` emits, which our own encoder never writes.

Writing it surfaced a second defect: `decodeWav` handed `buf.buffer` to `DataView`
without the byte offset. A Node Buffer is a view into a shared pool, so that reads
whatever else happens to be in the pool rather than the file.

What is still not covered: live API responses, and `getUserMedia` itself - whether the
browser honours the requested 16 kHz is the one thing only a real microphone can tell
you.

---

## 9. File map

```
src/align.js          align → segment → vote              226 lines   ← the project
public/app.js         mic → WAV → POST → render           224 lines
probe.js              endpoint reconnaissance             156 lines
src/assembly.js       client, fan-out, lane dropout       125 lines
server.js             HTTP, key custody                   123 lines
eval.js               the accuracy measurement            122 lines
test/dropout.test.js  8 assertions                         80 lines
test/align.test.js    9 assertions                         79 lines
src/wer.js            word error rate                      52 lines
public/wav.js         WAV encode/decode, shared with tests  70 lines
src/mock.js           canned lanes, runs without a key     49 lines
test/wer.test.js      15 assertions                        44 lines
src/lanes.js          the three vocabularies — tune this   37 lines
public/index.html     three-lane view
docs/prd.html         requirements, metrics, schedule
docs/design.md        this document
```

~1,500 lines of JavaScript, no dependencies, 51 assertions passing.

Verified end to end in mock mode: a clip POSTed to the server returns three lane
transcripts and a merge that repairs all three disagreements, rendered at **150 ms wall
against 420 ms serial**. The lane-dropout path is verified against a local stub that
fails one of the three requests.

---

## 10. Open decisions

1. **Lane count.** Three is the minimum where voting is meaningful. Five was the obvious
   upgrade until §3 showed the threshold scales with `(k−1)/L` — at five lanes a lone
   correct lane needs a 0.60 confidence margin to be heard, so extra lanes actively
   suppress the outlier this design exists to surface. Staying at three. Going higher
   would require lowering α in step, which is a different tuning problem than it looks.
2. **Where calibration happens.** `laneWeights` exists but nothing fits it. Fitting on
   the eval set risks overfitting 20 utterances; leaving it at 1.0 risks the
   overconfidence skew. Decide after seeing the first live confidence distributions.
3. **Whether to show confidence numbers in the UI.** They make the mechanism legible and
   they make the page busier. Currently shown small, next to disputed phrases only.

---

## 11. Visual design

The interface is where a judge meets the idea, so it has a spec too. Change the page by
changing this section first.

**Direction: warm dark.** An espresso ground with a single brass accent. Chosen over a
warm cream page deliberately — cream + serif + terracotta is the most recognisable
generated-design look going, and a deep warm ground reads richer on screen recordings,
which is where this will actually be judged.

**One rule carries the whole palette: the winning word is the only saturated thing on
the page.** Brass is reserved for what the vote decided. Losing candidates recede into
struck-through warm grey rather than going red, because being outvoted isn't an error —
it's the mechanism working.

| token | hex | used for |
|---|---|---|
| `--ground` | `#15110D` | page |
| `--raise` | `#1D1813` | the control |
| `--sunk` | `#100D09` | ballot chips |
| `--ink` | `#F2E9DC` | primary text — warm paper, never pure white |
| `--muted` | `#A89684` | secondary text, lane names |
| `--faint` | `#756554` | labels, losing candidates, struck-through words |
| `--rule` | `#2B2219` | hairlines |
| `--brass` | `#E3A44A` | **the vote's decision, and nothing else** |
| `--brass-dim` | `#6B4F20` | edges of winning chips, underline on repaired words |
| `--clay` | `#C4705E` | error headings |
| `--ember` | `#E0563F` | recording state, dropped lanes |

**Type: three faces, three jobs.**

- **Spectral** (serif, light) — every transcript, and the wordmark. Speech that has
  become text is set as text. The merged sentence is the largest thing on the page.
- **Karla** (sans) — interface chrome: the control, lane names, buttons.
- **IBM Plex Mono** — anything that's a measurement: confidences, milliseconds, section
  labels. Tabular figures so columns of numbers line up.

**Form.** 2px corner radius throughout — squared-off reads as instrument, rounded reads as
app. Structure comes from hairline rules, not boxes; the merged transcript sits on the
ground with no card around it, because a border would compete with it.
