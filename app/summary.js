// Rolling session summary. Per-question answers are built from a ~25 s window, which is myopic:
// by minute twenty the interview has established a stack, constraints, what you already claimed
// about yourself, and which threads are still open, and none of that reaches a new answer.
//
// This module keeps a CUMULATIVE picture of the whole conversation and feeds it back into answer
// composition. Two properties matter more than anything else here:
//
//   1. It must not lose context. The pass is INCREMENTAL: the model sees the previous summary
//      plus only the transcript lines added since the last pass, and it answers with a DELTA
//      (add / update / resolve), never a rewritten summary. Anything it does not mention is
//      KEPT verbatim, so a lazy or truncated response can never silently erase what the session
//      has learned. Only an explicit "resolve" entry removes something. The raw transcript is
//      never replaced by the summary; it stays on disk in full.
//   2. It must not stall the live path. It runs on a timer, only when the transcript actually
//      changed, on its own (stronger, larger-context) model, and never blocks question detection.
(function (global) {
  function CFG() { return (global.CONFIG && global.CONFIG.summarize) || {}; }
  function dbg() { if (global.CONFIG && global.CONFIG.debug && global.console) console.log.apply(console, ["[summary]"].concat([].slice.call(arguments))); }

  var cbs = {};        // { onUpdate(state), onStaleCards([{id, reason}]) }
  var busy = false;
  var lastSig = "";

  // The accumulated picture. Keyed maps so a delta can merge by key without duplicating.
  var S = blank();
  function blank() {
    return {
      narrative: "",
      role_context: { company: "", role: "", stack: [], notes: "" },
      topics: {},       // key -> {label, status: answered|shaky|open, ts}
      constraints: {},  // key -> {text, ts}   things the interviewer pinned down
      claims: {},       // key -> {text, ts}   what I already said about myself
      threads: {},      // key -> {text, ts}   asked but not fully answered
      focus: {},        // key -> {text, ts}   what this interviewer keeps probing
      lastTs: 0,        // watermark: newest transcript line already folded in
      passes: 0,
      updatedAt: 0,
      lastError: ""
    };
  }

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  }

  // ---- merge a model delta into the accumulated state (append-mostly) ----
  function mergeDelta(d) {
    if (!d || typeof d !== "object") return false;
    var now = Date.now(), changed = false;
    if (d.narrative && String(d.narrative).trim()) { S.narrative = String(d.narrative).trim(); changed = true; }
    if (d.role_context && typeof d.role_context === "object") {
      ["company", "role", "notes"].forEach(function (k) {
        var v = d.role_context[k];
        if (v && String(v).trim() && String(v).trim() !== S.role_context[k]) { S.role_context[k] = String(v).trim(); changed = true; }
      });
      if (Array.isArray(d.role_context.stack)) {
        d.role_context.stack.forEach(function (t) {
          t = String(t || "").trim();
          if (t && S.role_context.stack.indexOf(t) === -1) { S.role_context.stack.push(t); changed = true; }
        });
      }
    }
    var BUCKETS = { topics: "topics", constraints: "constraints", candidate_claims: "claims",
                    open_threads: "threads", interviewer_focus: "focus" };
    var add = d.add || {};
    Object.keys(BUCKETS).forEach(function (inKey) {
      var bucket = BUCKETS[inKey], items = add[inKey];
      if (!Array.isArray(items)) return;
      items.forEach(function (it) {
        if (!it) return;
        var text = String(it.text || it.label || "").trim();
        if (!text) return;
        var key = slug(it.key || text);
        if (!key) return;
        var prev = S[bucket][key];
        // Never overwrite an existing entry's text with something shorter: the accumulated
        // wording is the context we are protecting.
        if (prev && String(prev.text || "").length > text.length && !it.status) return;
        S[bucket][key] = { text: text, label: it.label || text,
                           status: it.status || (prev && prev.status) || (bucket === "topics" ? "open" : ""),
                           ts: (prev && prev.ts) || now };
        changed = true;
      });
    });
    // Status updates (e.g. a topic moves open -> answered).
    if (Array.isArray(d.update)) {
      d.update.forEach(function (u) {
        if (!u || !u.key) return;
        var key = slug(u.key);
        ["topics", "threads", "constraints", "claims", "focus"].forEach(function (b) {
          if (S[b][key] && u.status) { S[b][key].status = u.status; changed = true; }
        });
      });
    }
    // The ONLY removal path, and it must be explicit and reasoned.
    if (Array.isArray(d.resolve)) {
      d.resolve.forEach(function (r) {
        var key = slug(r && (r.key || r));
        if (!key) return;
        ["threads", "topics", "constraints"].forEach(function (b) {
          if (S[b][key]) {
            if (b === "topics") S[b][key].status = "answered";   // topics are never deleted, only closed
            else { delete S[b][key]; }
            changed = true;
          }
        });
      });
    }
    return changed;
  }

  // ---- prompt-ready rendering, used as SESSION CONTEXT when composing an answer ----
  function list(bucket, max) {
    var keys = Object.keys(S[bucket]);
    keys.sort(function (a, b) { return (S[bucket][b].ts || 0) - (S[bucket][a].ts || 0); });
    return keys.slice(0, max || 12).map(function (k) {
      var it = S[bucket][k];
      return "- " + it.text + (it.status ? " [" + it.status + "]" : "");
    });
  }
  function text() {
    if (!S.passes) return "";
    var out = [];
    if (S.narrative) out.push("SO FAR: " + S.narrative);
    var rc = S.role_context;
    var rcBits = [];
    if (rc.company) rcBits.push("company: " + rc.company);
    if (rc.role) rcBits.push("role: " + rc.role);
    if (rc.stack.length) rcBits.push("stack: " + rc.stack.join(", "));
    if (rc.notes) rcBits.push(rc.notes);
    if (rcBits.length) out.push("ROLE CONTEXT: " + rcBits.join(" | "));
    var c = list("constraints", 10);
    if (c.length) out.push("CONSTRAINTS THE INTERVIEWER SET (obey these):\n" + c.join("\n"));
    var cl = list("claims", 12);
    if (cl.length) out.push("WHAT THE CANDIDATE HAS ALREADY SAID (stay consistent, do not contradict):\n" + cl.join("\n"));
    var t = list("topics", 12);
    if (t.length) out.push("TOPICS COVERED:\n" + t.join("\n"));
    var th = list("threads", 8);
    if (th.length) out.push("STILL OPEN:\n" + th.join("\n"));
    var f = list("focus", 6);
    if (f.length) out.push("INTERVIEWER FOCUS:\n" + f.join("\n"));
    return out.join("\n\n");
  }

  // ---- trigger ----
  // Signature = watermark + line count, so a pass only runs when the transcript actually grew.
  function pending() {
    if (!global.TLOG) return [];
    return TLOG.byDate(TLOG.today()).filter(function (s) {
      return new Date(s.ts).getTime() > S.lastTs;
    });
  }
  function maybeRun(force) {
    var c = CFG();
    if (!c.enabled || busy) return Promise.resolve(false);
    if (!global.LLM || !LLM.summarize) return Promise.resolve(false);
    var news = pending();
    if (!force && news.length < (c.minNewLines || 3)) return Promise.resolve(false);
    if (!news.length) return Promise.resolve(false);
    var sig = S.lastTs + ":" + news.length;
    if (!force && sig === lastSig) return Promise.resolve(false);
    lastSig = sig;
    return run(news);
  }

  function run(news) {
    busy = true;
    var watermark = news.reduce(function (m, s) { return Math.max(m, new Date(s.ts).getTime()); }, S.lastTs);
    var cards = (global.QA ? QA.cards() : []).map(function (c) {
      return { id: c.id, question: c.question.normalized, type: c.question.type,
               headline: (c.answer && c.answer.headline) || "", hasCode: !!(c.code && c.code.canonicalLang) };
    });
    var docs = global.RAG ? RAG.context() : Promise.resolve("");
    return Promise.resolve(docs).then(function (docText) {
      return LLM.summarize({
        previous: snapshotForPrompt(),
        newLines: news.map(function (s) {
          return "[" + new Date(s.ts).toLocaleTimeString() + "] " +
                 (s.role === "me" ? "CANDIDATE" : (s.name || "INTERVIEWER")) + ": " + s.text;
        }).join("\n"),
        cards: cards,
        candidateContext: docText || ""
      });
    }).then(function (d) {
      busy = false;
      if (!d) { S.lastError = "summarizer did not answer"; return false; }
      S.lastError = "";
      var changed = mergeDelta(d);
      // Advance the watermark ONLY on a successful pass, so a failed one re-reads the same lines
      // next time instead of dropping them on the floor.
      S.lastTs = watermark;
      S.passes++;
      S.updatedAt = Date.now();
      dbg("pass", S.passes, "folded", news.length, "lines; changed =", changed);
      cbs.onUpdate && cbs.onUpdate(S);
      var stale = (d.stale_cards || []).filter(function (x) { return x && x.id; });
      if (stale.length && cbs.onStaleCards) {
        dbg("cards to rebuild:", stale.map(function (x) { return x.id; }).join(","));
        cbs.onStaleCards(stale);
      }
      return true;
    }).catch(function (e) {
      busy = false;
      S.lastError = String(e && e.message || e);
      dbg("pass failed:", S.lastError);
      return false;
    });
  }

  // What the model sees as "the summary so far". Compact but complete: every accumulated item is
  // listed with its key, because the model must be able to reference keys in update/resolve.
  function snapshotForPrompt() {
    if (!S.passes) return "(nothing yet - this is the first pass)";
    var out = [];
    if (S.narrative) out.push("narrative: " + S.narrative);
    out.push("role_context: " + JSON.stringify(S.role_context));
    ["topics", "constraints", "claims", "threads", "focus"].forEach(function (b) {
      var keys = Object.keys(S[b]);
      if (!keys.length) return;
      out.push(b + ":\n" + keys.map(function (k) {
        return "  " + k + ": " + S[b][k].text + (S[b][k].status ? " [" + S[b][k].status + "]" : "");
      }).join("\n"));
    });
    return out.join("\n");
  }

  function reset() { S = blank(); lastSig = ""; cbs.onUpdate && cbs.onUpdate(S); }

  // ---- the candidate's own notes ----
  // Typed by hand on the Brief tab. These outrank anything inferred from the audio: ASR mishears,
  // the summarizer generalizes, but a note is the user stating a requirement directly. Persisted
  // locally so a reload mid-interview never loses them.
  var NOTES_KEY = "tic_notes";
  var notesText = "";
  try { notesText = localStorage.getItem(NOTES_KEY) || ""; } catch (e) {}
  function notes() { return notesText; }
  function setNotes(t) {
    notesText = String(t == null ? "" : t);
    try { localStorage.setItem(NOTES_KEY, notesText); } catch (e) {}
    cbs.onNotes && cbs.onNotes(notesText);
  }

  // ---- requirements fingerprint ----
  // Everything that should force generated code to be rebuilt: the constraints the interviewer set,
  // the stack in play, and the user's notes. Code entries carry the fingerprint they were built
  // against, so the Code tab can tell when what is on screen predates the current requirements.
  function requirementsSig() {
    var parts = Object.keys(S.constraints).sort().map(function (k) { return k + "=" + S.constraints[k].text; });
    parts.push("stack=" + (S.role_context.stack || []).slice().sort().join(","));
    parts.push("notes=" + notesText.trim());
    var s = parts.join("|"), h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return String(h);
  }
  // Human-readable list of what code must satisfy right now (shown on the Code tab).
  function requirementsList() {
    var out = Object.keys(S.constraints).map(function (k) { return S.constraints[k].text; });
    if (notesText.trim()) {
      notesText.split("\n").forEach(function (line) {
        line = line.replace(/^[-*\s]+/, "").trim();
        if (line) out.push(line + " (your note)");
      });
    }
    return out;
  }

  global.SUMMARY = {
    init: function (callbacks) { cbs = callbacks || {}; },
    maybeRun: maybeRun,
    runNow: function () { var n = pending(); return n.length ? run(n) : maybeRun(true); },
    get: function () { return S; },
    text: text,
    notes: notes,
    setNotes: setNotes,
    requirementsSig: requirementsSig,
    requirementsList: requirementsList,
    isBusy: function () { return busy; },
    pendingCount: function () { return pending().length; },
    reset: reset
  };
})(window);
