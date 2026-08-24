// Tech Interview Copilot — built-in DEFAULTS. Most of these are editable live from the app's
// Config tab; the tab persists changes to app/settings.json via the log-server, and settings.js
// (from copilot-core) deep-merges that file over this object at boot. Edit this file only for
// defaults.
//
// SECRETS: this file contains NO real API keys. The apiKey fields below are %PLACEHOLDERS% that
// web-server.py substitutes at serve time from the git-ignored .env file (copy example.env -> .env).
// The keys stay on your machine and never enter the repo. If you open config.js without the server,
// the placeholders stay literal and those providers simply won't authenticate.

// Namespacing + hooks consumed by copilot-core's shared modules (js/layout.js, js/transcript.js,
// js/asr.js, js/llm-transport.js). Must be set BEFORE those scripts load -- see index.html's
// script order.
window.CopilotCore = {
  ns: "tic",   // localStorage key prefix (keeps this app's saved state separate from any other
               // copilot-core app running on the same machine/browser)
  transcript: {
    persistKeys: ["text", "role", "name"]
  }
};

window.CONFIG = {
  // LLM for question detection + answer/code generation. The local "ollama" server (localhost:11501)
  // is the CORS-friendly bridge that PROXIES Ollama Cloud models to the browser (a browser cannot call
  // ollama.com directly - no CORS headers). Providers are tried in fallback order; first non-empty
  // answer wins. Everything fails soft to the offline heuristic tier.
  llm: {
    enabled: true,
    provider: "ollama",
    fallback: ["ollama", "openai", "groq"],
    // Compose/code tasks; cloud coder models answer in ~3-10s. Raised from 20s when the COMPANY &
    // INTERVIEW block was added: the compose prompt grew by ~4k tokens, and a timeout here degrades
    // the card to the offline tier silently rather than erroring, so headroom is worth more than
    // failing fast.
    timeoutMs: 25000,
    detectTimeoutMs: 8000,   // question detection needs to be snappy
    ollama: { url: "http://localhost:11501", model: "qwen3-coder:480b-cloud" },
    // Detection can use a different (smaller/faster) model than composition; same by default.
    detectModel: "qwen3-coder:480b-cloud",
    openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "%OPENAI_API_KEY%" },
    groq:   { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-20b", apiKey: "%GROQ_API_KEY%" }
  },

  // Speech-to-text. "whisper" posts 16 kHz audio to a local whisper.cpp server; "webspeech" uses the
  // browser's built-in recognition. Hosted transcription (Together AI) activates automatically when a
  // key is present, via the local /asr proxy on the log-server (CORS + key stays on your machine).
  asr: {
    engine: "whisper",
    lang: "en-US",
    whisperUrl: "http://localhost:8189/inference",
    transcriber: "auto",     // "auto" = Together when keyed, local whisper fallback; "whisper" = force local
    together: { url: "http://localhost:8890/asr", model: "nvidia/parakeet-tdt-0.6b-v3", apiKey: "%TOGETHER_API_KEY%" },
    // Capture devices, set from the Config tab (label substring match against enumerated devices).
    inputDeviceLabel: "BlackHole",   // the interviewers' audio (meeting output routed through BlackHole)
    inputLabelName: "Interviewer input",
    selfLabelName: "Your mic",
    captureSelf: true,               // also transcribe your own mic as "Me"
    selfDeviceLabel: "",             // your microphone; empty = pick the first non-BlackHole input
    // Domain priming for whisper (decoder's initial prompt). Cuts technical-term errors.
    prompt: "big-O; hash map; binary search; linked list; dynamic programming; two pointers; sliding window; REST API; microservices; Kubernetes; PostgreSQL; transformer; LLM; RAG; system design; concurrency; race condition; time complexity; space complexity.",
    // Voice-activity chunking: cut on pauses, not on a clock, so questions are not split mid-sentence.
    vad: { threshold: 0.015, silenceMs: 650, minMs: 1200, maxMs: 9000, minVoicedMs: 450, minRms: 0.006 }
  },

  // Question detection behavior.
  qa: {
    windowMs: 25000,        // roll this much recent interviewer speech into each detection pass
    cooldownMs: 20000,      // don't spawn a new card for the same question inside this window
    minChars: 12,           // ignore very short fragments
    minConfidence: 0.6,     // LLM detection confidence floor
    similarity: 0.6         // normalized-token overlap above this = duplicate of an existing card
  },

  // Answer + code generation.
  answers: {
    defaultLanguage: "python",
    languages: ["python", "javascript", "typescript", "java", "go", "cpp", "sql"],
    verbosity: 5,           // max talking points per answer
    // Regenerate a card's code when the interview establishes new requirements (a constraint the
    // interviewer set, or a note you typed), even if no new question was asked. Off = the Code tab
    // still flags the code as out of date and offers an Update button.
    autoUpdateCode: true,
    rag: { enabled: true, url: "http://localhost:8892", topK: 6, timeoutMs: 2500 }
  },

  // Rolling session summary. Per-question answers see only a ~25 s window; this pass reasons over
  // the WHOLE interview and feeds the result back into composition, so later answers obey
  // constraints the interviewer set earlier and stay consistent with what you already said.
  // It runs on its own STRONGER, larger-context model (it is a background pass, so a slower model
  // is fine here) and returns a DELTA that can only add to the picture, never erase it.
  //   everyMs        = how often to consider a pass (only runs when the transcript actually grew)
  //   minNewLines    = wait for this many new transcript lines before spending a pass
  //   maxRebuildsPerPass = cap on cards rebuilt per pass, so one pass cannot fan out
  //   ollama.model   = a strong GENERAL-reasoning cloud model, NOT the coder model. To see your
  //                    available cloud tags: `curl https://ollama.com/api/tags`.
  summarize: {
    enabled: true,
    everyMs: 25000,
    minNewLines: 3,
    maxRebuildsPerPass: 2,
    timeoutMs: 45000,
    providers: ["ollama", "openai"],
    ollama: { model: "gpt-oss:120b-cloud", num_ctx: 16384 },
    openai: { model: "gpt-4o" }
  },

  // Voice profiles (who is speaking). launch.command starts app/speaker-server.py on 8891; each
  // finalized interviewer utterance is fingerprinted there in parallel with transcription, so
  // multiple interviewers get separate voices (V1, V2, ...) in the transcript. Name a voice on the
  // Live tab and every line of that voice, past and future, is relabeled with the name. Named
  // voices persist per session id under voice-profiles/ (git-ignored, biometric-adjacent data).
  // The app degrades silently when the sidecar is not running: lines stay labeled "Interviewer".
  //   accept/suggest thresholds live server-side (see app/speaker_engine.py).
  //   timeoutMs = how long to wait for a verdict before delivering the line without one.
  //   scopeId   = namespaces voice clusters (read by copilot-core's asr.js when calling /identify).
  speakerId: {
    enabled: true,
    url: "http://localhost:8891",
    timeoutMs: 1500,
    scopeId: "default"
  },

  // Which interview this is for. profiles/index.json lists the available profiles; the active one
  // is loaded at boot and rendered into every prompt as a COMPANY & INTERVIEW block, so the copilot
  // knows the company from the first answer instead of waiting for the summarizer to infer it.
  // Edits made in the Prep tab persist to settings.json (profileOverrides) and never touch the
  // committed profile file. Set activeId to "" to run without a profile.
  //
  // "example" ships a fictional company (Acme Robotics) as a working demo. For a REAL interview,
  // put your own profile at profiles/local/<id>/profile.json (the whole profiles/local/ tree is
  // git-ignored -- never committed) with "id": "local/<id>" inside it, then set activeId to
  // "local/<id>" here, or override it per-machine in app/settings.json instead of editing this
  // file: { "profile": { "activeId": "local/<id>" } }. See profiles/README.md.
  profile: { activeId: "example", indexUrl: "profiles/index.json" },

  ui: { notifierMax: 12 },
  debug: true,

  // Durable on-disk transcript log + settings persistence (log-server.py on 8890).
  logServer: { enabled: true, url: "http://localhost:8890/log" },
  settingsUrl: "http://localhost:8890/settings"
};
