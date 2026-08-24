# CLAUDE.md

Guidance for Claude Code (and the Claude Agent SDK) when working in this project.

## What this is

Tech Interview Copilot: a real-time assistant for the interviewee in a live technical interview
(Google Meet / Teams / Zoom). It captures the interviewers' audio via BlackHole and the user's
mic, transcribes live, detects technical questions, and generates verbal talking points plus
code examples (7 languages, doc-commented, with a select-to-explain popup), grounded by RAG over
five public interview-prep repos and the user's uploaded resume/JD. It is a personal demo tool;
the header disclaimer about covert use in real interviews must stay.

This repo depends on **[copilot-core](https://github.com/gitchrisqueen/copilot-core)** (npm +
pip), a small package shared with the sibling
[hearing-copilot](https://github.com/gitchrisqueen/hearing-copilot) repo. Transcription, the
LLM provider-failover transport, the transcript store, layout, settings persistence, the
secret-injecting web server, the transcript/settings/ASR-proxy log server, and the speaker-ID
embedding math all live there. Everything in `app/` here is this app's own domain logic. See
`index.html` for the exact script load order (core scripts, then app scripts).

**This repo is public.** Never commit anything under `profiles/local/`, `.env`, `logs/`,
`voice-profiles/`, or `docs/uploads/` -- see `profiles/README.md` and the `scrub` CI job.

## Architecture map

| File | Role |
|---|---|
| `index.html` | app shell: left tabs (Answers, Code, Cheat sheets, Prep), Transcript, copilot tabs (Live, Config); script load order matters -- `app/config.js` first (sets `window.CopilotCore` + `window.CONFIG`), then copilot-core's `md.js`/`shell.js`/`settings.js`, then this app's `hl.js`/`profile.js`, then core's `transcript.js`/`asr.js`/`llm-transport.js`, then this app's `llm.js`/`rag.js`/`summary.js`/`qa.js`/`codepanel.js`/`app.js`, then core's `layout.js` last |
| `app/config.js` | committed defaults + `%KEY%` secret placeholders (web-server injects `.env` values at serve time) + `window.CopilotCore` (namespace, transcript persist-keys) |
| `app/domain.css` | this app's styles; the shared shell (grid, panels, dividers, cards, chips, transcript list) is copilot-core's `css/base.css`, loaded first |
| **from copilot-core** (`node_modules/@gitchrisqueen/copilot-core/js/`) | `md.js` (markdown), `shell.js` (`el`/`esc`/`makeLogger`/`makeNotifier`, used by `app.js`), `settings.js` (fetches+merges `app/settings.json`), `transcript.js` (`TLOG`), `asr.js` (`ASR` -- device binding, VAD chunking, tiered transcription, `identifyParams` hook for the speaker sidecar), `llm-transport.js` (`LLM` provider chain + `registerTask`/`runTask`, unused by this app -- see `app/llm.js`) |
| `app/llm.js` | **adds onto** `window.LLM` (never replaces it -- core already set the transport). JSON-mode tasks: `detectQuestion`, `composeAnswer`, `generateCode`, `translateCode`, `explainCode`, `summarize`; grounding guard on detection; doc-comment QA pass on all code |
| `app/qa.js` | `refreshCard()` rebuilds an existing card against the session summary (answer + code); `refreshStale()` handles summarizer-flagged cards, capped per pass. Rolling 25s window of interviewer speech -> detection -> dedup/cooldown -> answer pipeline (retrieve -> compose -> code); offline heuristic detector (interrogative + BEHAVIORAL patterns + tech keyword scoring) when no LLM; owns card state, never touches the DOM |
| `app/summary.js` | also owns the user's NOTES (localStorage, authoritative over inferred context) and `requirementsSig()`/`requirementsList()`, the fingerprint that decides when generated code is out of date. Rolling session summary: incremental passes (previous summary + only new lines) merged as an append-mostly DELTA; `SUMMARY.text()` is the prompt-ready SESSION CONTEXT fed into composeAnswer/generateCode; flags stale cards for rebuild |
| `app/codepanel.js` | code rendering, language pills with per-language cache (switch = translate-not-resolve), Regenerate, select-to-explain popup |
| `app/rag.js` | browser client for rag-server (`/query`, `/docs`, `/docs/context`, `/health`); everything fails soft. The doc-context cache stays `null` after a FAILED fetch (vs `""` for a successful empty one) so a late-starting rag-server is picked up |
| `app/speaker-server.py` | voice-profile HTTP sidecar: session scoping, `/identify`, `/label`, `/confirm`, `/merge`, `/voices`, `/reset`, `/health`, `DELETE /profiles/<pid>`. Wraps `copilot_core.speaker.engine.SpeakerEngine` -- the CAM++ embedding/clustering math lives in copilot-core, not here. Named profiles persist under `voice-profiles/<session>/` (git-ignored) |
| `app/app.js` | all rendering + wiring; uses `CopilotShell` (`el`/`esc`/`dbg`/notifier) from core rather than redefining them; Config tab; transcript Export/Clear session; Voices strip + naming/reassignment; manual entry box; `window.InterviewCopilot` plugin API (`ask()` submits a typed question, `nameVoice()`, `clearSession()`, `exportTranscript()`) |
| `app/hl.js` | zero-dep syntax highlighter (7 languages) |
| `app/profile.js` | interview-profile system: loads `profiles/<id>/profile.json`, renders the COMPANY & INTERVIEW block every prompt includes. See `profiles/README.md` for the public-vs-local-profile split |
| `app/web-server.py`, `app/log-server.py` | thin wrappers around `copilot_core.webserver.serve()` / `copilot_core.logserver.serve()` -- see those for the actual no-cache/secret-injection and `/log`+`/settings`+`/asr` logic |
| `app/rag-server.py` | sqlite + numpy brute-force cosine retrieval over the built index; candidate doc uploads (raw body + query params, no multipart), resume/JD context stuffing, oversized-doc chunk indexing. App-local (no core equivalent) |
| `kb/repos.json` | ingestion manifest (5 repos, include globs, chunking, embedding model) |
| `kb/ingest.py` | shallow-clone + parse + chunk + embed (local Ollama `nomic-embed-text`) -> `kb/index/kb.sqlite`; incremental by content hash; `--no-embed` dry run |
| `cheatsheets/*.md` | static reference content rendered by `MD.render` (copilot-core) |

Data flow: `ASR` (core) -> `app.js onFinalSegment` -> `TLOG` (core) + (remote only) `qa.js` ->
`llm.js`/`rag.js` -> answer cards -> `codepanel.js`. In parallel, `summary.js` folds the transcript
into a cumulative picture that feeds back into composition and can trigger card rebuilds.

Ports: web **8877**, log/settings **8890**, voice profiles **8891**, rag **8892**, ollama bridge
**11501**, whisper **8189**. These are deliberately distinct from the sibling hearing-copilot's
ports; do not change them casually.

## Conventions (follow these)

- **Frontend**: vanilla JS in IIFEs attaching to window globals (`CONFIG`, `CopilotCore`,
  `SETTINGS`, `CopilotShell`, `ASR`, `LLM`, `QA`, `RAG`, `TLOG`, `MD`, `HL`, `CODEPANEL`,
  `InterviewCopilot`). No frameworks, no bundler, no build step, no CDN or external requests from
  the page (copilot-core is loaded from `node_modules/` via plain `<script>` tags, same as any
  other file here). All markdown renders through `MD.render`; all code renders through
  `HL.highlight`.
- **Backend**: Python 3 stdlib only, plus `copilot_core` (also stdlib-only at its core) and the kb
  venv's `numpy`/`pypdf`/`sherpa-onnx`. Do not add dependencies without a strong reason, and keep
  every service that needs one optional.
- **When a change belongs in copilot-core, not here**: if you're touching something that would
  also help hearing-copilot (the ASR pipeline, the LLM transport, layout, settings persistence,
  the speaker-embedding math), it probably belongs in copilot-core instead -- open an issue/PR
  there and bump this repo's pinned version, rather than duplicating the fix here.
- **Secrets** live only in the git-ignored `.env`, injected into config.js placeholders at
  serve time. Never write a key into config.js, settings.json, localStorage, or the repo.
- **Settings** (non-secret) persist server-side via `SETTINGS.save(patch)` -> `/settings` ->
  `app/settings.json`. localStorage is for ephemeral UI state only (active tab, panel sizes,
  last code language).
- **Every network dependency degrades gracefully**: LLM down -> offline heuristic cards; RAG
  down -> unreferenced answers; Together down -> local whisper -> webspeech. Preserve this in
  any change.

## Do not break

- The **JSON contracts** of the llm.js tasks (qa.js, app.js, and codepanel.js parse them).
- The **provider `sequence()` fallback** and its fail-soft null returns (copilot-core).
- The **`/asr` proxy serialization + circuit breaker** (Together 503s on bursts).
- The **grounding guard** in `detectQuestion` (2 shared content words) - it kills hallucinated
  questions from ASR junk.
- The **doc-comment QA pass** (`ensureDocComments`) - generated code must carry doc blocks.
- The **translate-not-resolve** language switch (consistency + speed) and its per-language cache.
- The **offline heuristic tier** in qa.js, including the BEHAVIORAL pattern (behavioral openers
  carry no technical keywords, so without it the most common non-coding question is dropped).
- The **fixed-length embedding standardization** in copilot-core's `speaker/engine.py`
  (`EMBED_SAMPLES`): this CAM++ export returns garbage for certain input durations, so every chunk
  is center-cropped or tiled to exactly 6 s. Removing it silently destroys voice identification.
- **Voice naming is retroactive**: `nameVoice()` patches every past transcript line of that
  cluster. Exports and the durable log must reflect the name, not the raw cluster id.
- The **candidate-document contract**: resume/JD text is stuffed into every `composeAnswer` call
  and the model must return `from_your_docs`. It is force-emptied when no documents are loaded,
  because an invented "from your resume" claim is the one error that embarrasses the user aloud.
- The **summary delta contract**: `summarize` returns add/update/resolve, and `mergeDelta` only
  ever removes on an explicit `resolve`. A lazy or truncated model response must never shrink the
  accumulated picture. The watermark (`S.lastTs`) advances only on a SUCCESSFUL pass, so failed
  passes re-read their lines instead of dropping them. Test with a stubbed `LLM.summarize` that
  returns `{}`, a truncated delta, and `null`.
- The **code requirements chain**: `generateCode`/`translateCode` take a ctx object
  `{sessionSummary, notes, candidateContext}`, and every generated entry is stamped with
  `ctxSig = SUMMARY.requirementsSig()`. `translateCode` MUST receive that ctx (it silently dropped
  every constraint before), and a translation may only run from a canonical whose `ctxSig` is
  current - otherwise generate fresh, or the stale solution is carried into the new language.
- **Notes outrank the summary** in every prompt that takes both. ASR mishears and the summarizer
  generalizes; a note is the user stating a requirement directly.
- The **script load order** in index.html -- see the Architecture map row above.
- **`app/llm.js` must ADD to `window.LLM`, never replace it** (`global.LLM = global.LLM || {}` at
  the top, then assign individual task functions at the bottom). Replacing the object would
  silently delete the transport core just installed.

## How to run / test

- `./launch.command` bootstraps `npm install` + the `kb/venv` Python environment (with
  `copilot-core` installed) if needed, then starts everything; `./stop.command` kills the six
  ports.
- `npm test` (or `node --test test/*.test.js`) -- the only automated suite. Fakes `window`,
  `SETTINGS` and `fetch`, loads `app/profile.js` and `app/rag.js` with `vm`, and covers block
  rendering and caps, per-section budgeting, settings overrides, `sig()` narrowness, and every
  fail-soft path. No dependencies, no servers needed. **Assert content, not length**: a regression
  once kept the answer block inside its cap while silently dropping 11 of 12 curated company
  facts, and length-only assertions passed it.
- Without audio hardware, drive the pipeline from the browser console:
  `InterviewCopilot.ask("Can you reverse a linked list?")` simulates an interviewer line end to
  end (detection -> card -> code).
- Server smoke tests: `curl localhost:8892/health`, `curl -d '{"q":"two sum"}' -H "Content-Type:
  application/json" localhost:8892/query`, `curl localhost:8890/settings`.
- KB dry run without Ollama: `kb/ingest.py --no-embed`.
- Voice sidecar without the native dep: stub `sherpa_onnx` in `sys.modules`, or (simpler) pass
  `embed_fn` directly to `copilot_core.speaker.engine.SpeakerEngine` -- see that package's own
  test suite for the pattern.
- Manual smoke checklist: tabs render and dividers drag; Config tab lists devices and meters
  move; transcript shows Interviewer/Me lines; a technical question spawns a card and small talk
  does not; a coding question yields doc-commented highlighted code; switching language
  regenerates once then swaps instantly; selecting code shows "Explain this code"; uploading a
  resume PDF changes behavioral answers and fills "Mention from your documents"; two speakers
  produce two voice pills, naming one relabels its past lines; the manual entry box spawns a
  card; Export downloads a .txt and Clear session empties lines and cards; the Brief tab fills in
  after a pass and a flagged card rebuilds with an "updated vN" badge; a constraint appearing with
  NO new question still regenerates the code on screen; typing a note and pressing Apply to code
  regenerates with the note in context; killing ollama still yields offline cards.

## Writing style

Plain English, no em dashes (use periods or commas). Comments state constraints the code cannot
show, in the voice of the surrounding files.
