# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Quorum sends one recorded clip to the AssemblyAI Dictation endpoint several times in
parallel, each copy transformed differently, then merges the transcripts using per-word
confidence. Built for the AssemblyAI Dictation hackathon, submission deadline
**13 Sep 2026**. Node 18+, zero dependencies, no build step.

## Repository

`github.com/Reet24-del/quorum` (private until submission). **Commit and push after
each completed change** — the owner asked for the repo to track the work continuously,
not in one batch at the end. Commit messages say *why*, and end with the Claude
co-author trailer.

Git credentials and commit identity are configured **repo-locally**
(`credential.helper = !gh auth git-credential`, noreply email), not globally — a fresh
clone needs `gh auth login` and those two settings again.

## Commands

```bash
npm test                      # all four suites; each is a plain node script
node test/align.test.js       # run one suite - any file in test/ runs standalone
npm run mock                  # server on :5173 with canned lanes, no API key needed (/try shows a sample-mode warning)
npm start                     # live server, needs ASSEMBLYAI_API_KEY
npm run probe                 # interrogates the live endpoint; run before trusting any API assumption
npm run eval                  # WER table from eval/clips/ + eval/manifest.json
QUORUM_MOCK=1 node eval.js    # exercises the eval harness without spending API calls
npm run eval:real             # only real recordings (QUORUM_EVAL_SET=real) - the number worth quoting
curl localhost:5173/transcribe -H "Authorization: $KEY" -F "audio=@clip.wav;type=audio/wav"   # the drop-in endpoint
```

There is no test framework. Each test file prints PASS/FAIL lines and exits non-zero on
failure. Add assertions with the local `check(name, actual, expected)` helper in the file.

Env vars: `ASSEMBLYAI_API_KEY`, `QUORUM_MOCK=1`, `QUORUM_ENDPOINT`, `QUORUM_MODEL`,
`PORT`, and `QUORUM_SEND_HINTS=1` (dormant, see below). Never write the key into a file.

## Architecture

```
public/app.js  --raw WAV-->  server.js  --transformed copy per lane-->  AssemblyAI  (Promise.allSettled)
                                 |
                          src/align.js merge()  -->  { lanes, votingLaneIds, merged, timing }  -->  app.js renders
```

- `src/lanes.js` defines the lanes. Each lane has a `transform` (`none`, `normalize`,
  `pad`, `stretch`, `gain`, `noise`) applied by `src/audio.js` to the WAV before upload. It also
  exports `VOCABULARY`, which the server passes to `merge()`. Lanes and vocabulary are
  the demo's main tuning knobs.
- `src/assembly.js` handles fan-out and lane dropout. A lane that errors or times out (20s; calls measured up to about 7s, and 8s was dropping whole clips)
  comes back with an `error` field and no vote. Only if every lane fails does the call
  throw. The server passes `votingLaneIds` because the merge's candidate indices refer to
  the voting lanes, not all lanes. The UI relies on that mapping.
- `src/quorum.js` `runQuorum()` is the single pipeline (fan-out, `guardScript`, merge)
  behind both `POST /api/transcribe` (the demo UI's shape) and `POST /transcribe` (the
  **drop-in**: AssemblyAI's own request and response shape, via `toAssemblyShape()`;
  `src/multipart.js` parses the `audio` part). The drop-in uses the **caller's**
  `Authorization` header as the AssemblyAI key, with the env key as fallback. Don't
  break the response shape: `test/dropin.test.js` spawns the real server against a
  stub and pins it.
- Pages: `/` landing (`public/index.html`), `/try` live demo (`try.html` + `app.js`),
  `/record` recorder (`record.html` + `record.js`). `server.js` maps extensionless paths
  to `.html` and **binds 127.0.0.1 only**: live mode holds the API key and
  `/api/eval-clip` writes files. Tokens, nav, buttons and footer are in
  `public/site.css`. The nav markup is copied into each page (there's no build step), so
  change all three when you change it.
- `public/wav.js` is imported by the browser (`app.js`) and by Node (`src/audio.js`,
  tests), so it must stay environment-neutral: no DOM, no Node `Buffer` APIs.
- `src/script.js` `guardScript()` runs before every merge, **in both `src/quorum.js` and
  `eval.js`**. Failed lanes and lanes whose output is in the wrong script (default Latin)
  don't vote. The two call sites once drifted apart (the eval let failed lanes vote), so
  keep them on the same rule.
- `src/align.js` is the core of the project. Read `docs/design.md` §3 before changing it.

### The merge (`src/align.js`)

1. **Align**: progressive Needleman–Wunsch across lanes. Scoring combines text similarity
   and time-span overlap. If no word has a non-zero `end`, it switches to text-only
   automatically (`hasTimings`).
2. **Segment**: columns where every lane agrees after `norm()` become anchors and are
   never rewritten. The remaining runs are disputes.
3. **Vote**: disputes are settled between whole **phrases**, not single words. That lets
   a one-word lane (`kubectl`) beat a two-word majority (`cube cuttle`).
   `score = α·votes/L + (1−α)·meanConfidence`.

Invariants you won't see from reading one function:

- `norm()` strips whitespace, so `Roll back` and `Rollback` count as the same ballot. The
  output spelling is picked by `electForm()` (most common form wins, ties go to higher
  confidence) on **both** the anchor path and the dispute path. Emitting `col[0].text` or
  the first-seen form reintroduces a bug that lost real eval cases.
- A lone lane beats a group of `k` when `c_solo − c_group > α(k−1)/((1−α)L)`. Adding lanes
  makes it *harder* for a correct outlier to win. Don't add lanes without adjusting `α`.
- `opts.vocabulary` adds `vocabBonus` (0.3) to a **dispute** ballot whose phrase is a
  known term (`isKnown`). It only chooses between spellings some lane produced. It never
  inserts a word and never touches anchors. Keep it that way: that constraint is why
  it can't hallucinate names. `VOCABULARY` was written before eval clips 07–12 and
  deliberately leaves out their answers. Don't add those answers to it, because that
  would tune the eval to its own test set.

## Facts about the live API (probed 12 Sep 2026)

These override the public docs. They are also recorded in the header of `src/assembly.js`.

- The endpoint **accepts and silently ignores** `keyterms`, `prompt`, `word_boost`, and
  similar fields. Output is byte-identical with and without them, even on clips where the
  model mishears the hinted term. A 200 from an extra field proves nothing. To test a
  parameter, compare transcripts, not status codes. This finding is why lanes transform
  audio instead of passing vocabulary.
- It returns per-word `text` and `confidence` but **no timings**.
- It rejects a multipart audio part that isn't labelled `audio/wav` with **415**. curl's
  `-F` defaults to `application/octet-stream`, so docs must show `;type=audio/wav`.
  Quorum's drop-in accepts either label.
- **The output language can't be pinned.** `language_code`, `language`,
  `language_detection`, an `X-AAI-Language` header and `?language_code=` are all ignored.
  On an accented voice the model sometimes answers in **Devanagari**, spelling English
  phonetically. Padding and slowing make this likelier; faint noise didn't trigger it
  once in screening. `wer.js` keeps `\p{M}` so a script switch scores as substitutions,
  not as hundreds of percent of insertions.
- ×2 gain only diverged on synthesised speech, because it clipped it. On real recordings
  it matched the untouched transcript 19 times out of 20. That's why it was replaced by noise.
- A call takes about 2.3–3.6s, not the documented 134ms. Responses include
  `llm_response`, which suggests an LLM pass. Parallel fan-out still works: 4 lanes cost
  about 1.3× one call.

## Gotchas

- `src/assembly.js` reads env vars at **call time** through accessor functions. Don't
  hoist them into module-level constants. The dropout test redirects `QUORUM_ENDPOINT` to
  a local stub after import, and hoisting once made that test hit the live API.
- `decodeWav` has to honour `byteOffset`, because a Node `Buffer` is a view into a shared
  pool.
- `src/mock.js` is a **real capture** from the live API, not invented data. If you
  change the lanes, re-capture it the same way. Don't hand-edit confidences.
- **Choose lanes with unlabelled screens only**: does a transform change the transcript,
  and does it stay in English. Never use eval WER. Picking lanes by accuracy on the eval
  set tunes them to their own answer key.
- `eval/clips/13–32` are **real recordings** (`synthetic: false`). `npm run eval:real` is
  the number to quote. 01–12 are synthesised placeholders.
- `eval/clips/` holds **synthesised (macOS `say`) placeholders**, marked `synthetic: true`
  in the manifest. TTS is too clean to be a meaningful eval, and `eval.js` prints a warning
  whenever they're used. The submission number needs real recorded speech.
  Record it at `http://localhost:5173/record.html`. That page POSTs to `/api/eval-clip`,
  which writes the next numbered WAV and appends `synthetic: false` to the manifest.
  `record.js` duplicates `app.js`'s capture code on purpose, so the demo's capture path
  (which can't be tested headlessly) stays untouched.
- `test/wav.test.js` reads `eval/clips/01.wav` and skips those assertions if the file is
  missing.
- `try.html` and `app.js` share a set of CSS class names (`.fixed`, `.won`, `.lost`,
  `.dropped`, `.opt`, `.timing`, …). Renaming one means updating both files.

- `public/reel.html` (the demo video) must move **only through `renderAt(t)`**: no CSS
  animations, transitions or timers. `demo/render.swift` renders it frame by frame in a
  hidden WebKit view, so anything that runs on real time would drift or freeze.
  Transcripts come from `demo/captures/*.json`, never typed in by hand. Rebuild the
  data and soundtrack with `node demo/build.mjs`.
- Narration lines live in `NARRATION` in `demo/build.mjs`: `text` is shown, `say` is the
  phonetic spelling fed to macOS `say` (for example "Shivawn" for Siobhan). The build
  **fails** if a line overruns its `until` slot or overlaps the owner's clips, so shorten
  the wording rather than speeding the voice up. `REEL_VOICE` picks the voice (default
  Daniel).

## Docs and their state

- `docs/design.md` §11 is the **visual spec**: warm dark palette, brass (`#E3A44A`)
  reserved for words the vote decided, Spectral for transcripts, Karla for UI, IBM Plex
  Mono for measurements. Update it before changing how the page looks.
- `README.md` is current: it pitches the audio-variation finding and reports eval
  numbers honestly, including where the merge loses. Update its results table when the
  eval changes.
- `docs/design.md` is current as of 12 Sep. The probe findings are folded in, and §7.7
  records why the mechanism changed.
- `docs/prd.html` is the **original plan**, kept as written, with a dated notice at the
  top listing what the probe overturned. Its body still describes vocabulary lanes.
  That's deliberate, as a record. For the current design, use the README.
- The PRD is also published at
  https://claude.ai/code/artifact/e8480306-5496-4508-b35c-262eaa28a172. It moved into
  `docs/`, so republishing requires passing that URL, not just the file path.
