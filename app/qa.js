// Question-detection pipeline. Buffers the interviewer's recent speech into a rolling window,
// runs LLM detection (with an offline heuristic fallback), dedups against recent cards, then
// drives the answer pipeline: retrieve -> compose -> (optionally) generate code. It never touches
// the DOM: app.js registers callbacks and owns all rendering.
//
// Card lifecycle (status): detecting -> retrieving -> answering -> done | offline | error.
(function (global) {
  function CFG() { return (global.CONFIG && global.CONFIG.qa) || {}; }
  function ACFG() { return (global.CONFIG && global.CONFIG.answers) || {}; }
  function dbg() { if (global.CONFIG && global.CONFIG.debug && global.console) console.log.apply(console, ["[qa]"].concat([].slice.call(arguments))); }

  var cbs = {};            // { onCard(card), onUpdate(card) }
  var windowBuf = [];      // [{text, ts}] recent remote speech
  var consumedTs = 0;      // newest segment ts already turned into a card (drop older speech)
  var cards = [];          // all answer cards, newest last
  var busy = false;        // a detection pass is in flight (serialize; new speech re-queues)
  var dirty = false;       // speech arrived while busy
  var nextId = 1;

  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
  function tokens(s) { return norm(s).split(" ").filter(function (w) { return w.length >= 3; }); }
  // Jaccard-ish overlap between two questions, for duplicate suppression.
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var seen = {}; ta.forEach(function (w) { seen[w] = 1; });
    var hit = 0; tb.forEach(function (w) { if (seen[w]) hit++; });
    return hit / Math.max(ta.length, tb.length);
  }

  // The rolling window covers only speech NEWER than the last spawned card, so an answered
  // question can't re-trigger off its own words when later small talk lands in the buffer.
  function windowSlice() {
    var cutoff = Math.max(Date.now() - (CFG().windowMs || 25000), consumedTs + 1);
    windowBuf = windowBuf.filter(function (s) { return s.ts >= cutoff; });
    var maxTs = windowBuf.reduce(function (m, s) { return Math.max(m, s.ts); }, 0);
    return { text: windowBuf.map(function (s) { return s.text; }).join(" "), maxTs: maxTs };
  }

  function isDuplicate(normalized) {
    var cd = CFG().cooldownMs || 20000, simFloor = CFG().similarity || 0.6, now = Date.now();
    return cards.some(function (c) {
      if (now - c.ts > cd * 3) return false;   // old cards never block a re-ask
      var sim = similarity(normalized, c.question.normalized);
      return (now - c.ts <= cd) ? sim >= simFloor * 0.7 : sim >= simFloor;
    });
  }

  function lastCard() { return cards.length ? cards[cards.length - 1] : null; }

  // ---- offline heuristic detector (no LLM reachable) ----
  var INTERROGATIVE = /^(what|why|how|when|where|which|who|can you|could you|would you|do you|did you|have you|are you|is there|tell me|walk me|talk me|explain|describe|implement|write|code|design|build|solve|reverse|find|given|suppose|imagine|let's say|whats|what's|how's)\b/i;
  var TECH_TERMS = ("algorithm array string linked list tree graph heap stack queue hash map set sort search binary recursion iterate pointer window substring palindrome anagram duplicate complexity big-o runtime memory optimize brute force dynamic programming memoization greedy backtracking bfs dfs traversal node edge matrix interval merge partition bucket trie prefix suffix bitwise modulo overflow " +
    "api rest graphql grpc http endpoint microservice monolith database sql nosql postgres mysql mongodb redis cache index shard replica transaction consistency availability partition latency throughput scale load balancer queue kafka pubsub websocket authentication authorization oauth jwt encryption hashing " +
    "python javascript typescript java golang rust kubernetes docker container serverless lambda terraform cicd pipeline deploy test unit integration mock concurrency thread async await promise race deadlock mutex semaphore garbage collection closure prototype inheritance polymorphism interface generic " +
    "machine learning model training inference embedding vector transformer llm rag prompt fine-tuning neural network gradient overfitting regression classification " +
    "design architecture system service component scalability scaling tradeoff tradeoffs bottleneck performance reliability observability monitoring logging failover redundancy availability idempotent retry backoff schema migration versioning refactor debug profiling benchmark").split(" ");
  var TECH_SET = {}; TECH_TERMS.forEach(function (w) { TECH_SET[w] = 1; });
  // Behavioral openers carry no technical keywords at all ("tell me about a time you made a hard
  // tradeoff"), so without their own pattern the keyword gate below would drop the single most
  // common non-coding question in the interview.
  // The company/motivation openers on the second line matter as much as the STAR patterns: at most
  // companies the FIRST question of a screen is some form of "what do you know about us", which
  // carries no technical keyword and no STAR shape, so without them the gate below drops the one
  // question the candidate most needs a card for.
  var BEHAVIORAL = new RegExp([
    "tell me about a time", "about a time (when|you)", "a time when you",
    "describe a (time|situation|project)", "walk me through (a|your|the)", "give me an example",
    "have you ever", "how did you (handle|approach)", "what would you do if",
    "biggest (challenge|failure|mistake|weakness|strength)", "proudest", "experience with",
    "conflict", "disagree", "weakness", "strength", "tell me about yourself", "tell me about your",
    "why (do you want|are you interested|this role|our company)",
    // Company / motivation openers. These carry no technical keyword and no STAR shape, so without
    // them the keyword gate below drops the question that opens most screens.
    "what (do|did) you know about (us|our|the (company|team|product|role))",
    "what have you heard about us", "tell (me|us) what you know",
    "how familiar are you with (us|our)", "why (us|do you want to work here|are you looking)",
    "what (interests|excites|attracts|appeals to) you about", "what do you (think|make) of (us|our)",
    "how did you (hear|find out) about us", "do you have any questions",
    "any questions for (us|me)", "what would you like to know"
  ].join("|"), "i");
  function heuristicDetect(text) {
    var t = text.trim();
    if (t.length < (CFG().minChars || 12)) return null;
    var lastSentence = t.split(/(?<=[.?!])\s+/).pop() || t;
    var asksQuestion = /\?\s*$/.test(t) || INTERROGATIVE.test(lastSentence.trim()) || INTERROGATIVE.test(t);
    var behavioral = BEHAVIORAL.test(t);
    var hits = [];
    norm(t).split(" ").forEach(function (w) { if (TECH_SET[w] && hits.indexOf(w) === -1) hits.push(w); });
    if (!asksQuestion && !behavioral && hits.length < 2) return null;
    // An ask with no technical keywords and no behavioral shape is small talk ("how are you?").
    if (asksQuestion && !hits.length && !behavioral) return null;
    return {
      question: true,
      type: behavioral ? "behavioral" : (hits.length ? "conceptual" : "behavioral"),
      normalized: lastSentence.trim() || t.slice(-160),
      topics: hits.slice(0, 4),
      needsCode: /implement|write|code|function|algorithm|solve/i.test(t),
      language_hint: null,
      confidence: 0.5,
      offline: true
    };
  }

  // ---- answer pipeline for one detected question ----
  function runAnswer(card) {
    var q = card.question;
    card.status = "retrieving";
    cbs.onUpdate && cbs.onUpdate(card);
    var ragP = global.RAG ? RAG.query(q.normalized, q.topics) : Promise.resolve([]);
    var ctxP = global.RAG ? RAG.context() : Promise.resolve("");
    Promise.all([ragP, ctxP]).then(function (rc) {
      lastDocContext = rc[1] || lastDocContext;
      card.sources = rc[0] || [];
      card.status = card.offline ? "offline" : "answering";
      cbs.onUpdate && cbs.onUpdate(card);
      if (card.offline) return;   // offline card: topic + raw retrieved chunks are the answer
      var prev = q.type === "followup" ? (function () {
        var pc = cards.filter(function (c) { return c !== card && c.answer; }).pop();
        return pc ? pc.answer : null;
      })() : null;
      return LLM.composeAnswer(q, answerContext({
        ragChunks: card.sources,
        candidateContext: rc[1] || lastDocContext,
        prevAnswer: prev
      })).then(function (a) {
        if (!a) {
          // LLM died mid-pipeline: degrade this card to the offline style rather than erroring.
          card.offline = true; card.status = "offline";
          cbs.onUpdate && cbs.onUpdate(card);
          return;
        }
        card.answer = a;
        card.status = "done";
        cbs.onUpdate && cbs.onUpdate(card);
        if (q.needsCode || a.wants_code) generateCanonical(card);
      });
    }).catch(function (e) {
      dbg("answer pipeline error", e);
      card.status = card.answer ? "done" : "error";
      cbs.onUpdate && cbs.onUpdate(card);
    });
  }

  function summaryText() { return global.SUMMARY ? SUMMARY.text() : ""; }
  // Everything code generation must honor: the inferred session summary, the candidate's own
  // notes (authoritative), and their documents. Built fresh at each call so code always reflects
  // the requirements as they stand right now, not as they stood when the question was asked.
  function codeContext() {
    return {
      sessionSummary: summaryText(),
      notes: global.SUMMARY ? SUMMARY.notes() : "",
      candidateContext: lastDocContext
    };
  }
  // Everything an ANSWER must be composed against. Built here rather than inline at each call site:
  // the last time these fields were assembled by hand at two sites, a rebuild quietly dropped one.
  // Note candidateContext falls back to the CACHED doc text - RAG.context() resolves "" on a 2.5 s
  // timeout, and an empty context makes llm.js force from_your_docs to [], silently turning a
  // personalized answer into a generic one with no visible error.
  function answerContext(extra) {
    var c = {
      ragChunks: [],
      candidateContext: lastDocContext,
      sessionSummary: summaryText(),
      verbosity: ACFG().verbosity || 5,
      prevAnswer: null
    };
    Object.keys(extra || {}).forEach(function (k) { if (extra[k] != null) c[k] = extra[k]; });
    return c;
  }
  function reqSig() { return global.SUMMARY ? SUMMARY.requirementsSig() : ""; }
  var lastDocContext = "";   // cached so code paths do not have to await the doc fetch
  // Stamp what a generated entry was built against, so the Code tab can spot stale code.
  function stamp(entry) { if (entry) { entry.ctxSig = reqSig(); entry.builtAt = Date.now(); } return entry; }

  // Pre-generate the code in the default (canonical) language as soon as the answer lands, so the
  // Code tab is warm by the time the candidate opens it. Language switches translate from this.
  function generateCanonical(card) {
    var lang = card.question.language_hint || ACFG().defaultLanguage || "python";
    if ((ACFG().languages || []).indexOf(lang) === -1) lang = ACFG().defaultLanguage || "python";
    card.code = card.code || { canonicalLang: lang, byLang: {}, busy: {} };
    card.code.busy[lang] = true;
    cbs.onUpdate && cbs.onUpdate(card);
    LLM.generateCode(card.question, lang, card.answer && card.answer.talking_points, codeContext())
      .then(function (r) {
        card.code.busy[lang] = false;
        if (r) { card.code.byLang[lang] = stamp(r); card.code.canonicalLang = lang; }
        cbs.onUpdate && cbs.onUpdate(card);
      });
  }

  // Rebuild an existing card against everything the session has learned since it was drafted.
  // Triggered by the summarizer flagging the card as stale (a constraint appeared, the question was
  // narrowed, an assumption was corrected) or by the user pressing Refresh on the card.
  //
  // The previous answer is kept until the new one actually arrives, so a failed rebuild never
  // leaves the candidate staring at an empty card mid-interview.
  function refreshCard(card, reason) {
    if (!card || card.refreshing) return Promise.resolve(false);
    card.refreshing = true;
    card.refreshReason = reason || "";
    cbs.onUpdate && cbs.onUpdate(card);
    var q = card.question;
    var ragP = global.RAG ? RAG.query(q.normalized, q.topics) : Promise.resolve([]);
    var ctxP = global.RAG ? RAG.context() : Promise.resolve("");
    return Promise.all([ragP, ctxP]).then(function (rc) {
      lastDocContext = rc[1] || lastDocContext;   // a rebuild refreshes the cache too
      return LLM.composeAnswer(q, answerContext({
        ragChunks: rc[0] || card.sources,
        candidateContext: rc[1] || lastDocContext,
        prevAnswer: card.answer
      })).then(function (a) {
        card.refreshing = false;
        if (!a) { cbs.onUpdate && cbs.onUpdate(card); return false; }
        card.sources = rc[0] || card.sources;
        card.answer = a;
        card.status = "done";
        card.offline = false;
        card.revision = (card.revision || 0) + 1;
        card.revisedAt = Date.now();
        dbg("card", card.id, "rebuilt (rev", card.revision + "):", reason || "manual");
        cbs.onUpdate && cbs.onUpdate(card);
        // Code was drafted against the old framing, so it is stale too. Regenerate the canonical
        // language and drop the other cached translations rather than leaving them inconsistent.
        if (card.code && card.code.canonicalLang) {
          var lang = card.code.canonicalLang;
          card.code.byLang = {};
          card.code.busy[lang] = true;
          cbs.onUpdate && cbs.onUpdate(card);
          LLM.generateCode(q, lang, a.talking_points, codeContext()).then(function (r) {
            card.code.busy[lang] = false;
            if (r) card.code.byLang[lang] = stamp(r);
            cbs.onUpdate && cbs.onUpdate(card);
          });
        }
        return true;
      });
    }).catch(function (e) {
      card.refreshing = false;
      dbg("refresh failed for", card.id, e);
      cbs.onUpdate && cbs.onUpdate(card);
      return false;
    });
  }
  // Is the code currently on screen older than the requirements that now apply?
  function codeStale(card, lang) {
    if (!card || !card.code) return false;
    var e = card.code.byLang[lang || card.code.canonicalLang];
    return !!(e && e.ctxSig && e.ctxSig !== reqSig());
  }
  // Regenerate a card's code against the CURRENT requirements. Other cached languages are dropped
  // rather than left inconsistent: a stale Go translation next to fresh Python is worse than a
  // pill that has to regenerate on click.
  function updateCode(card, lang) {
    if (!card || !card.code) return Promise.resolve(false);
    lang = lang || card.code.canonicalLang;
    if (!lang || card.code.busy[lang]) return Promise.resolve(false);
    card.code.busy[lang] = true;
    var keep = card.code.byLang[lang];
    card.code.byLang = {};
    if (keep) card.code.byLang[lang] = keep;    // keep the visible one until the new one lands
    cbs.onUpdate && cbs.onUpdate(card);
    return LLM.generateCode(card.question, lang, card.answer && card.answer.talking_points, codeContext())
      .then(function (r) {
        card.code.busy[lang] = false;
        if (r) { card.code.byLang = {}; card.code.byLang[lang] = stamp(r); card.code.canonicalLang = lang; }
        dbg("code updated for", card.id, "against current requirements");
        cbs.onUpdate && cbs.onUpdate(card);
        return !!r;
      }).catch(function () { card.code.busy[lang] = false; cbs.onUpdate && cbs.onUpdate(card); return false; });
  }
  // Called after every summary pass and whenever the user edits their notes: any card whose code
  // predates the current requirements is brought up to date. This is what makes "now do it in O(1)
  // space" actually change the code on screen, even when no new question was asked.
  function refreshStaleCode() {
    if (!ACFG().autoUpdateCode) return 0;
    var sig = reqSig(), n = 0;
    var max = ((global.CONFIG && global.CONFIG.summarize) || {}).maxRebuildsPerPass || 2;
    for (var i = cards.length - 1; i >= 0 && n < max; i--) {
      var c = cards[i];
      if (!c.code || !c.code.canonicalLang) continue;
      var e = c.code.byLang[c.code.canonicalLang];
      if (e && e.ctxSig && e.ctxSig !== sig) { updateCode(c, c.code.canonicalLang); n++; }
    }
    return n;
  }

  // Rebuild the cards the summarizer flagged, newest first, capped so one pass cannot fan out into
  // a dozen concurrent generations mid-interview.
  function refreshStale(stale) {
    var max = ((global.CONFIG && global.CONFIG.summarize) || {}).maxRebuildsPerPass || 2;
    var byId = {};
    cards.forEach(function (c) { byId[c.id] = c; });
    var todo = stale.filter(function (s) { return byId[s.id] && !byId[s.id].refreshing; })
                    .slice(-max);
    todo.forEach(function (s) { refreshCard(byId[s.id], s.reason); });
    return todo.length;
  }

  // Language switch: cache hit is instant; miss translates from the canonical entry.
  function requestLanguage(card, lang) {
    if (!card.code) card.code = { canonicalLang: null, byLang: {}, busy: {} };
    if (card.code.byLang[lang] || card.code.busy[lang]) return;
    var canonical = card.code.canonicalLang && card.code.byLang[card.code.canonicalLang];
    card.code.busy[lang] = true;
    cbs.onUpdate && cbs.onUpdate(card);
    // A translation of code drafted BEFORE the current requirements would carry the old solution
    // into the new language, so translate only from an up-to-date canonical; otherwise generate.
    var fresh = canonical && canonical.ctxSig === reqSig();
    var p = fresh ? LLM.translateCode(card.question, canonical, lang, codeContext())
                  : LLM.generateCode(card.question, lang, card.answer && card.answer.talking_points, codeContext());
    p.then(function (r) {
      card.code.busy[lang] = false;
      if (r) {
        card.code.byLang[lang] = stamp(r);
        if (!card.code.canonicalLang || !fresh) card.code.canonicalLang = lang;
      }
      cbs.onUpdate && cbs.onUpdate(card);
    });
  }
  // Force a fresh generation in a language (the Regenerate button), bypassing the cache.
  function regenerate(card, lang) {
    if (!card.code) card.code = { canonicalLang: null, byLang: {}, busy: {} };
    if (card.code.busy[lang]) return;
    card.code.busy[lang] = true;
    cbs.onUpdate && cbs.onUpdate(card);
    // codeContext() and stamp() are not optional here: without the context this path silently drops
    // every requirement (notes, constraints, docs), and without the stamp the entry carries no
    // ctxSig, so codeStale() can never flag regenerated code as out of date.
    LLM.generateCode(card.question, lang, card.answer && card.answer.talking_points, codeContext()).then(function (r) {
      card.code.busy[lang] = false;
      if (r) { card.code.byLang[lang] = stamp(r); card.code.canonicalLang = lang; }
      cbs.onUpdate && cbs.onUpdate(card);
    });
  }

  function spawnCard(q) {
    var card = {
      id: "q" + (nextId++), ts: Date.now(), question: q, status: "detecting",
      offline: !!q.offline, answer: null, code: null, sources: []
    };
    cards.push(card);
    cbs.onCard && cbs.onCard(card);
    runAnswer(card);
    return card;
  }

  // ---- entry point: a finalized interviewer segment ----
  function onRemoteSegment(text, ts) {
    windowBuf.push({ text: text, ts: ts || Date.now() });
    scheduleDetect();
  }
  function scheduleDetect() {
    if (busy) { dirty = true; return; }
    busy = true;
    var w = windowSlice();
    var prev = lastCard() ? lastCard().question.normalized : null;
    LLM.detectQuestion(w.text, prev).then(function (v) {
      if (v === null) {
        // LLM unreachable/failed entirely -> offline heuristic tier.
        var h = heuristicDetect(w.text);
        if (h && !isDuplicate(h.normalized)) {
          dbg("offline heuristic fired:", h.normalized);
          consumedTs = Math.max(consumedTs, w.maxTs);
          spawnCard(h);
        }
        return;
      }
      var minConf = CFG().minConfidence || 0.6;
      if (!v.question || (v.confidence || 0) < minConf) return;
      if (isDuplicate(v.normalized)) { dbg("duplicate suppressed:", v.normalized); return; }
      dbg("question detected:", v.type, "-", v.normalized);
      consumedTs = Math.max(consumedTs, w.maxTs);
      spawnCard(v);
    }).catch(function (e) { dbg("detect error", e); })
      .then(function () {
        busy = false;
        if (dirty) { dirty = false; scheduleDetect(); }
      });
  }

  function reset() { windowBuf = []; cards = []; dirty = false; consumedTs = 0; }

  global.QA = {
    init: function (callbacks) { cbs = callbacks || {}; },
    onRemoteSegment: onRemoteSegment,
    requestLanguage: requestLanguage,
    regenerate: regenerate,
    refreshCard: refreshCard,
    refreshStale: refreshStale,
    refreshStaleCode: refreshStaleCode,
    updateCode: updateCode,
    codeStale: codeStale,
    reqSig: reqSig,
    cards: function () { return cards.slice(); },
    byId: function (id) { return cards.filter(function (c) { return c.id === id; })[0] || null; },
    reset: reset
  };
})(window);
