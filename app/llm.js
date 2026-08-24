// Interview-copilot LLM tasks. The provider-failover transport (chatJSON/available/providerList)
// lives in copilot-core's llm-transport.js, loaded before this file, which already sets
// window.LLM. This file ADDS the app's domain prompts onto that same object -- it never replaces
// it, since replacing window.LLM here would silently delete the transport core just installed.
(function (global) {
  var LLM = global.LLM = global.LLM || {};
  function cfg() { return (global.CONFIG && global.CONFIG.llm) || {}; }
  function chatJSON(sys, usr, opts) { return LLM.chatJSON(sys, usr, opts); }
  // The COMPANY & INTERVIEW block is pulled HERE rather than passed in through ctx, deliberately.
  // Every prompt-building path (compose, refresh, generate, translate, regenerate, summarize) then
  // gets it automatically and no caller is able to drop it - the failure mode this file has hit
  // before, where a rebuild silently lost its context fields. Fails soft to "".
  function profileBlock(mode) {
    try { return (global.PROFILE && PROFILE.block(mode)) || ""; } catch (e) { return ""; }
  }

  // ---- grounding: a detected question must share real words with what was actually heard ----
  function contentWords(s) {
    var STOP = { the: 1, a: 1, an: 1, of: 1, to: 1, in: 1, on: 1, is: 1, are: 1, was: 1, do: 1, does: 1,
      you: 1, your: 1, can: 1, could: 1, would: 1, how: 1, what: 1, why: 1, and: 1, or: 1, for: 1,
      with: 1, about: 1, me: 1, us: 1, we: 1, it: 1, that: 1, this: 1, tell: 1, please: 1 };
    return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter(function (w) { return w.length >= 3 && !STOP[w]; });
  }
  function grounded(normalized, heard) {
    var want = contentWords(normalized);
    if (!want.length) return false;
    var have = {}; contentWords(heard).forEach(function (w) { have[w] = 1; });
    var hit = 0;
    want.forEach(function (w) { if (have[w]) hit++; });
    return hit >= Math.min(2, want.length);   // at least 2 shared content words (or all of a tiny question)
  }

  // ---- Task 1: question detection ----
  // Fast pass over the interviewer's recent speech. prev = the previous question's normalized text
  // (so follow-ups can be recognized). Returns the parsed verdict or null.
  function detectQuestion(windowText, prev) {
    var t = (windowText || "").trim();
    var qcfg = (global.CONFIG && global.CONFIG.qa) || {};
    if (t.length < (qcfg.minChars || 12)) return Promise.resolve(null);
    var sys = "You monitor a live technical job interview and watch the INTERVIEWER'S recent speech " +
      "(imperfect ASR transcription - expect garbled words). Decide whether it contains a question or task " +
      "directed at the candidate.\n" +
      "- type: \"coding\" = write/trace an algorithm or code; \"system-design\" = design a system/architecture; " +
      "\"conceptual\" = explain a technology, tradeoff, or concept; \"behavioral\" = experience/situational " +
      "('tell me about a time'); \"followup\" = refines or extends the PREVIOUS question (previous question is " +
      "supplied); \"smalltalk\" = greetings, logistics, chit-chat (question=false for these).\n" +
      "- normalized: a clean one-sentence restatement of the question, built ONLY from what was said. " +
      "Do not invent content the input does not imply.\n" +
      "- topics: 1-4 short lowercase tags (e.g. \"arrays\", \"two-pointers\", \"rest api\", \"llm\").\n" +
      "- needsCode: true when a code example would genuinely help answer it.\n" +
      "- language_hint: a programming language if the interviewer named one, else null.\n" +
      "Respond ONLY as JSON: {\"question\":true|false,\"type\":\"coding|system-design|conceptual|behavioral|" +
      "followup|smalltalk\",\"normalized\":\"...\",\"topics\":[\"...\"],\"needsCode\":true|false," +
      "\"language_hint\":null,\"confidence\":0.0-1.0}";
    var usr = "INTERVIEWER SAID (recent):\n" + t + (prev ? "\n\nPREVIOUS QUESTION: " + prev : "");
    var opts = { timeoutMs: cfg().detectTimeoutMs || 8000, maxTokens: 500 };
    if (cfg().detectModel) opts.models = { ollama: cfg().detectModel };
    return chatJSON(sys, usr, opts).then(function (o) {
      if (!o || typeof o !== "object" || !o.question) return o ? { question: false } : null;
      if (!o.normalized || !grounded(o.normalized, t)) {
        try { if (global.console) console.log("[copilot] detect: dropped ungrounded question:", o.normalized); } catch (e) {}
        return { question: false };
      }
      return o;
    });
  }

  // ---- Task 2: compose verbal talking points ----
  // q = the detected question object; ctx = { ragChunks:[{repo,path,title,text}], candidateContext:"",
  // verbosity:5, prevAnswer: {headline,talking_points} for follow-ups }. Returns parsed object or null.
  function composeAnswer(q, ctx) {
    ctx = ctx || {};
    var verbosity = ctx.verbosity || 5;
    var behavioral = q.type === "behavioral";
    var sys = "You are a real-time interview copilot for the CANDIDATE in a live technical job interview. " +
      "The interviewer just asked the question below. Produce concise VERBAL talking points the candidate " +
      "can speak naturally - first person, confident, plain English, about 15-45 seconds of speech total.\n" +
      (behavioral
        ? "- This is a BEHAVIORAL question: structure the points as STAR (Situation, Task, Action, Result). " +
          "Draw the situation from CANDIDATE CONTEXT (their resume) when it contains something relevant; " +
          "if it does not, give a strong generic skeleton the candidate can fill with their own story. " +
          "Never invent specific employers, projects, or numbers that are not in the context.\n"
        : "- For coding questions, structure = clarify constraints, state the brute force, improve to the " +
          "optimal approach, give complexity. For design/conceptual, lead with the direct answer, then " +
          "the reasoning and tradeoffs.\n") +
      "- CANDIDATE CONTEXT is the candidate's OWN uploaded material (resume, job description, other " +
      "docs). It is the highest-value input you have: it is what makes the answer THEIRS and aligned " +
      "with THIS role. Whenever it contains something the answer can stand on - a project, an employer, " +
      "a technology, a metric, a responsibility named in the job description - build the answer around " +
      "it and record it in \"from_your_docs\" so the candidate knows to say it out loud. Never invent " +
      "an experience, employer, or number that is not in the context.\n" +
      "- from_your_docs: 0-3 entries, each {\"point\": \"the exact thing to mention, in speakable form\", " +
      "\"source\": \"resume\"|\"job description\"|the document name, \"why\": \"<=12 words on why it fits " +
      "here\"}. Leave it empty ONLY when the context genuinely has nothing relevant - do not force it.\n" +
      "- Where a talking point is carried by the candidate's own material, phrase it in the first person " +
      "so it can be spoken as-is (\"At <employer> I built...\").\n" +
      "- COMPANY & INTERVIEW is researched fact about the specific company, role, and interviewer for " +
      "THIS call, established before it started. It is separate from CANDIDATE CONTEXT and it is " +
      "binding: frame every answer for this company and this role. Never state a fact about the " +
      "company that is not listed there, and never assert one marked (unconfirmed) - allude to it at " +
      "most. Obey DO NOT SAY absolutely. Company facts are NOT the candidate's documents: never " +
      "report one under \"from_your_docs\".\n" +
      "- SESSION CONTEXT is what this interview has already established: constraints the " +
      "interviewer set, what the candidate has already claimed about themselves, topics covered, " +
      "and open threads. Treat it as binding. Obey every stated constraint even if the question " +
      "does not restate it, never contradict something the candidate already said, and do not " +
      "re-explain ground already covered - build on it instead.\n" +
      "- Use REFERENCE NOTES (retrieved study material) for correctness only - never quote them " +
      "verbatim and never mention that notes exist.\n" +
      "- talking_points: 3-" + verbosity + " short speakable bullets, most important first. No fluff.\n" +
      "- complexity: time/space of the recommended approach for algorithm questions, else null.\n" +
      "- pitfalls: 0-3 traps to avoid saying or doing. followups_to_expect: 0-3 likely next questions.\n" +
      "- wants_code: true when walking through actual code would strengthen the answer.\n" +
      "Respond ONLY as JSON: {\"headline\":\"one-line direct answer\",\"talking_points\":[\"...\"]," +
      "\"structure\":\"clarify -> brute force -> optimize -> complexity\"," +
      "\"complexity\":{\"time\":\"O(n)\",\"space\":\"O(1)\"},\"pitfalls\":[\"...\"]," +
      "\"followups_to_expect\":[\"...\"],\"from_your_docs\":[{\"point\":\"...\",\"source\":\"resume\"," +
      "\"why\":\"...\"}],\"wants_code\":true|false}";
    var refs = (ctx.ragChunks || []).map(function (c, i) {
      return "[" + (i + 1) + "] (" + c.repo + "/" + c.path + ") " + String(c.text || "").slice(0, 1200);
    }).join("\n---\n");
    // The question anchors the task, so it stays first; the company block sits directly under it
    // because it frames everything below, and the long low-priority reference notes stay last.
    var company = profileBlock("answer");
    var usr = "QUESTION (" + (q.type || "conceptual") + "): " + q.normalized +
      (q.topics && q.topics.length ? "\nTOPICS: " + q.topics.join(", ") : "") +
      (company ? "\n\n" + company : "") +
      (ctx.prevAnswer ? "\n\nPREVIOUS QUESTION'S ANSWER (this is a follow-up; build on it, don't repeat it):\n" +
        (ctx.prevAnswer.headline || "") + "\n- " + (ctx.prevAnswer.talking_points || []).join("\n- ") : "") +
      (ctx.sessionSummary ? "\n\nSESSION CONTEXT - what this interview has already established " +
        "(binding; obey constraints, stay consistent with prior claims):\n" + ctx.sessionSummary : "") +
      "\n\nCANDIDATE CONTEXT - the candidate's own uploaded documents (may be empty):\n" +
      (ctx.candidateContext || "(none uploaded)") +
      "\n\nREFERENCE NOTES (retrieved; may be empty):\n" + (refs || "(none)");
    return chatJSON(sys, usr, { maxTokens: 1800 }).then(function (o) {
      if (!o || !o.talking_points || !o.talking_points.length) return null;
      o.talking_points = o.talking_points.slice(0, verbosity);
      // Drop doc references when nothing was uploaded: with an empty context any entry here is
      // invented, which is the one failure mode that would embarrass the candidate out loud.
      if (!ctx.candidateContext) o.from_your_docs = [];
      else if (Array.isArray(o.from_your_docs)) o.from_your_docs = o.from_your_docs.slice(0, 3);
      else o.from_your_docs = [];
      return o;
    });
  }

  // ---- doc-comment QA: every generated example must carry real documentation comments ----
  // Checked after generation (prompts alone are unevenly obeyed): a top documentation block in the
  // language's native convention plus at least one inline comment. If missing, one revision is
  // requested; if the revision still lacks it, the draft is accepted as-is (fail-soft).
  var DOC_PATTERNS = {
    python:     [/"""[\s\S]*?"""|'''[\s\S]*?'''/],
    javascript: [/\/\*\*[\s\S]*?\*\//],
    typescript: [/\/\*\*[\s\S]*?\*\//],
    java:       [/\/\*\*[\s\S]*?\*\//],
    cpp:        [/\/\*\*[\s\S]*?\*\/|\/\/\/.*/],
    go:         [/(^|\n)\s*\/\/.*\n\s*func\s/],
    sql:        [/(^|\n)\s*--.*/]
  };
  var INLINE_PATTERNS = {
    python: /(^|\n)\s*#(?!!)/, go: /\/\//, sql: /--/,
    javascript: /\/\//, typescript: /\/\//, java: /\/\//, cpp: /\/\//
  };
  function hasDocComments(code, lang) {
    var pats = DOC_PATTERNS[lang] || DOC_PATTERNS.javascript;
    var doc = pats.some(function (p) { return p.test(code || ""); });
    var inline = (INLINE_PATTERNS[lang] || INLINE_PATTERNS.javascript).test(code || "");
    return doc && inline;
  }
  var DOC_CONVENTION = {
    python: "a top-level docstring (\"\"\"...\"\"\") stating purpose, params, returns, and complexity",
    javascript: "a JSDoc block (/** ... */) stating purpose, @param, @returns, and complexity",
    typescript: "a TSDoc block (/** ... */) stating purpose, @param, @returns, and complexity",
    java: "a Javadoc block (/** ... */) stating purpose, @param, @return, and complexity",
    go: "a godoc comment (// lines above the func) stating purpose, params, returns, and complexity",
    cpp: "a Doxygen-style block (/** ... */) stating purpose, @param, @return, and complexity",
    sql: "a leading -- comment header stating purpose, inputs, and output"
  };
  function docRules(lang) {
    return "DOCUMENTATION IS REQUIRED: the code MUST begin with " +
      (DOC_CONVENTION[lang] || DOC_CONVENTION.javascript) +
      ", and the key steps MUST carry short inline comments in the language's native style. " +
      "Code without the documentation block is an invalid answer.";
  }
  function ensureDocComments(result, lang, sys, usr) {
    if (!result || !result.code || hasDocComments(result.code, lang)) return Promise.resolve(result);
    try { if (global.console) console.log("[copilot] codegen: doc comments missing; asking for one revision"); } catch (e) {}
    var fixUsr = usr + "\n\n=== REVISION REQUIRED ===\nYour draft below is missing the required documentation " +
      "comments. Rewrite it with " + (DOC_CONVENTION[lang] || DOC_CONVENTION.javascript) + " and short inline " +
      "comments on the key steps. Keep the algorithm identical. Respond with the same JSON shape.\n\nYOUR DRAFT:\n" +
      result.code;
    return chatJSON(sys, fixUsr, { maxTokens: 2500 }).then(function (fixed) {
      if (fixed && fixed.code && hasDocComments(fixed.code, lang)) return fixed;
      return result;   // fail-soft: an undocumented answer beats no answer mid-interview
    });
  }

  // Everything generated code must satisfy right now, in priority order. The user's typed notes
  // outrank the inferred summary: ASR mishears and the summarizer generalizes, but a note is the
  // candidate stating a requirement directly.
  function requirementsBlock(ctx) {
    ctx = ctx || {};
    var out = [];
    // Background framing, above the authoritative notes but explicitly non-overriding.
    var company = profileBlock("code");
    if (company) out.push(company);
    if (ctx.notes && ctx.notes.trim()) {
      out.push("YOUR NOTES - written by the candidate, AUTHORITATIVE. These override anything " +
        "inferred from the audio. If a note conflicts with the transcript summary, follow the note:\n" +
        ctx.notes.trim());
    }
    if (ctx.sessionSummary) {
      out.push("SESSION CONTEXT - what this interview has established. Every CONSTRAINT listed here " +
        "is binding on the code (language, complexity limits, allowed libraries, data stores, API " +
        "shape). Apply them even when the question does not restate them:\n" + ctx.sessionSummary);
    }
    if (ctx.candidateContext) {
      out.push("CANDIDATE CONTEXT - their resume and the job description, for idiom and stack " +
        "alignment only:\n" + String(ctx.candidateContext).slice(0, 2500));
    }
    return out.length ? "\n\n" + out.join("\n\n") : "";
  }
  var REQ_RULES = "REQUIREMENTS COME FIRST: before writing anything, work out the full list of " +
    "requirements from the notes and session context, and satisfy every one of them. If a " +
    "requirement makes the obvious solution wrong (an O(1) space limit, a banned library, a " +
    "different language or data store), change the solution - do not produce the textbook answer " +
    "and mention the constraint in a comment. Echo the requirements you applied in " +
    "\"requirements\" so the candidate can check them at a glance.";

  var CODE_SHAPE = "Respond ONLY as JSON: {\"language\":\"...\",\"code\":\"the complete code as one JSON " +
    "string\",\"walkthrough\":[\"3-6 short bullets the candidate can SAY while pointing at the code\"]," +
    "\"complexity\":{\"time\":\"O(n)\",\"space\":\"O(1)\"}}";

  // ---- Task 3: generate a code example in the requested language ----
  function generateCode(q, language, talkingPoints, ctx) {
    var sys = "You are a live interview copilot writing a code example the CANDIDATE will walk through " +
      "aloud. Write clean, idiomatic, interview-appropriate " + language + " - the optimal approach, " +
      "not an over-engineered one. Keep it self-contained (a single function or small set of functions), " +
      "no external dependencies beyond the standard library.\n" +
      REQ_RULES + "\n" + docRules(language) + "\n" + CODE_SHAPE;
    var usr = "QUESTION: " + q.normalized +
      (q.topics && q.topics.length ? "\nTOPICS: " + q.topics.join(", ") : "") +
      (talkingPoints && talkingPoints.length ? "\nAPPROACH TO IMPLEMENT (from the verbal answer):\n- " + talkingPoints.join("\n- ") : "") +
      requirementsBlock(ctx);
    return chatJSON(sys, usr, { maxTokens: 2500 }).then(function (o) {
      if (!o || !o.code) return null;
      o.language = language;
      return ensureDocComments(o, language, sys, usr);
    });
  }

  // ---- Task 4: translate the canonical solution into another language ----
  // Translation, not a re-solve: same algorithm, same variable intent, so switching is fast and the
  // walkthrough stays consistent across languages.
  function translateCode(q, canonical, targetLanguage, ctx) {
    var sys = "You translate a code example from " + canonical.language + " to " + targetLanguage +
      " for a live interview walkthrough. Keep the ALGORITHM, structure, and variable intent identical - " +
      "this is a translation, not a new solution - but write idiomatic " + targetLanguage + ".\n" +
      "The requirements below still apply to the translation. If the source predates a requirement " +
      "and therefore violates it, FIX it while translating rather than carrying the violation over.\n" +
      REQ_RULES + "\n" +
      docRules(targetLanguage) + " Restate the documentation in " + targetLanguage + "'s convention.\n" + CODE_SHAPE;
    var usr = "QUESTION: " + q.normalized + "\n\nSOURCE (" + canonical.language + "):\n" + canonical.code +
      (canonical.walkthrough && canonical.walkthrough.length ? "\n\nSOURCE WALKTHROUGH:\n- " + canonical.walkthrough.join("\n- ") : "") +
      requirementsBlock(ctx);
    return chatJSON(sys, usr, { maxTokens: 2500 }).then(function (o) {
      if (!o || !o.code) return null;
      o.language = targetLanguage;
      o.complexity = o.complexity || canonical.complexity;
      return ensureDocComments(o, targetLanguage, sys, usr);
    });
  }

  // ---- Task 5: rolling session summary ----
  // Runs on its own STRONGER, larger-context model: it reasons over the whole conversation, not a
  // 25 s window, and it runs in the background so latency matters less than judgment.
  //
  // The contract is a DELTA, never a rewritten summary. The model is given the summary so far plus
  // only the NEW transcript lines, and returns what to add / update / resolve. Everything it does
  // not mention is kept by the caller, so an under-answering or truncated response can never erase
  // accumulated context. This is the same defensive shape as the code-generation QA pass: the model
  // gets to improve the state, never to replace it wholesale.
  function summarizeOpts() {
    var s = (global.CONFIG && global.CONFIG.summarize) || {};
    return {
      providers: s.providers,
      models: { ollama: s.ollama && s.ollama.model, openai: s.openai && s.openai.model },
      numCtx: (s.ollama && s.ollama.num_ctx) || 16384,
      timeoutMs: s.timeoutMs || 45000,
      maxTokens: 2500
    };
  }
  function summarize(payload) {
    var sys = "You maintain the running SUMMARY of a live technical job interview, for a copilot " +
      "that drafts the candidate's answers. You are given the SUMMARY SO FAR and only the NEW " +
      "transcript lines since the last pass. Fold the new lines into the picture.\n\n" +
      "=== THE CONTRACT (this is the part that matters) ===\n" +
      "You return a DELTA, never a rewritten summary. Anything you do not mention is KEPT exactly " +
      "as it is. NEVER drop, compress, or summarize away an existing item to save space - the " +
      "caller depends on nothing being lost. Only list something under \"resolve\" when the new " +
      "lines genuinely settled or withdrew it.\n" +
      "- add.topics: technical subjects discussed. status: \"answered\" (candidate covered it), " +
      "\"shaky\" (answered poorly or partially), \"open\" (raised, not answered).\n" +
      "- add.constraints: requirements the interviewer pinned down that any future answer must " +
      "obey - \"must be O(1) extra space\", \"we use Postgres, not Mongo\", \"no external libraries\", " +
      "\"Python 3.8\". These are the highest-value items you extract; miss one and the copilot gives " +
      "an answer the interviewer already ruled out.\n" +
      "- add.candidate_claims: specific things the CANDIDATE stated about their own experience " +
      "(employers, projects, numbers, technologies, opinions). Future answers must stay consistent " +
      "with these and never contradict them.\n" +
      "- add.open_threads: questions asked but not fully answered, or things the interviewer said " +
      "they would come back to.\n" +
      "- add.interviewer_focus: what this interviewer keeps probing, and their style.\n" +
      "Every entry needs a short stable \"key\" (lowercase-hyphenated) and a \"text\". Reuse the " +
      "SAME key when you are updating something that already exists.\n" +
      "- update: [{\"key\":\"...\",\"status\":\"answered|shaky|open\"}] for status changes only.\n" +
      "- resolve: [{\"key\":\"...\",\"reason\":\"<=10 words\"}] ONLY for genuinely settled items.\n" +
      "- narrative: a thorough rolling prose summary of the interview so far (3-8 sentences). " +
      "Rewrite it fully each pass, carrying forward everything still relevant.\n" +
      "- stale_cards: existing answer cards whose drafted answer no longer fits what the " +
      "conversation has since established - the interviewer added a constraint, narrowed the " +
      "question, corrected an assumption, or the candidate already said something that changes the " +
      "framing. Give the card id and a <=15 word reason. This is what triggers a rebuild, so list " +
      "a card ONLY when the answer would genuinely change. Empty array is the normal case.\n" +
      "Respond ONLY as JSON: {\"narrative\":\"...\",\"role_context\":{\"company\":\"\",\"role\":\"\"," +
      "\"stack\":[],\"notes\":\"\"},\"add\":{\"topics\":[{\"key\":\"\",\"text\":\"\",\"status\":\"\"}]," +
      "\"constraints\":[{\"key\":\"\",\"text\":\"\"}],\"candidate_claims\":[{\"key\":\"\",\"text\":\"\"}]," +
      "\"open_threads\":[{\"key\":\"\",\"text\":\"\"}],\"interviewer_focus\":[{\"key\":\"\",\"text\":\"\"}]}," +
      "\"update\":[],\"resolve\":[],\"stale_cards\":[{\"id\":\"q3\",\"reason\":\"\"}]}";
    var cardList = (payload.cards || []).map(function (c) {
      return c.id + " [" + c.type + (c.hasCode ? ", has code" : "") + "] Q: " + c.question +
             (c.headline ? " | drafted answer: " + c.headline : "");
    }).join("\n") || "(none yet)";
    // Known before the call, so the summarizer never has to guess the company from the audio - and
    // never guesses a different one.
    var companyHead = profileBlock("summary");
    var usr = (companyHead ? companyHead + "\n\n" : "") +
      "SUMMARY SO FAR:\n" + payload.previous +
      "\n\nNEW TRANSCRIPT LINES (fold these in):\n" + payload.newLines +
      "\n\nCURRENT ANSWER CARDS (flag any that no longer fit):\n" + cardList +
      (payload.candidateContext ? "\n\nCANDIDATE DOCUMENTS (for role/stack context):\n" +
        String(payload.candidateContext).slice(0, 4000) : "");
    return chatJSON(sys, usr, summarizeOpts());
  }

  // ---- Task 6: explain a selected span of code (select-to-explain popup) ----
  function explainCode(selected, fullCode, q, language) {
    var sys = "You explain a SELECTED section of code to the candidate mid-interview, in the context of " +
      "the full solution. Plain English, concrete, brief - what the section does, why it is there, and " +
      "anything subtle about it. Respond ONLY as JSON: {\"explanation\":\"1-2 sentence summary\"," +
      "\"points\":[\"2-5 short bullets\"]}";
    var usr = "QUESTION: " + (q && q.normalized || "(unknown)") + "\nLANGUAGE: " + (language || "") +
      "\n\nFULL SOLUTION:\n" + fullCode + "\n\nSELECTED SECTION (explain THIS):\n" + selected;
    return chatJSON(sys, usr, { timeoutMs: (cfg().detectTimeoutMs || 8000) * 1.5, maxTokens: 700 })
      .then(function (o) { return (o && (o.explanation || (o.points && o.points.length))) ? o : null; });
  }

  LLM.detectQuestion = detectQuestion;
  LLM.composeAnswer = composeAnswer;
  LLM.generateCode = generateCode;
  LLM.translateCode = translateCode;
  LLM.explainCode = explainCode;
  LLM.summarize = summarize;
})(typeof window !== "undefined" ? window : globalThis);
