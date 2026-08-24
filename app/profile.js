// Interview profile: who the candidate is talking to, known BEFORE the call starts.
//
// The rolling summarizer infers a role_context from the audio, but that takes a pass or two - too
// late for the first question, which at most companies is "what do you know about us?". This module
// loads a committed profile file (company facts, role, interviewer, must-hit points, prepared
// answers to expected objections) and renders it into a labeled block that llm.js prepends to every
// prompt. From answer #1 the copilot knows the company.
//
// Layering: profiles/<id>/profile.json is the committed ground truth, hand-edited and reviewed.
// Edits made in the Prep tab are stored per-machine under settings.json -> profileOverrides[id] and
// deep-merged over it, so tuning during a call never dirties the working tree. "Reset to file"
// writes null to the override.
//
// Everything fails soft. A missing file, malformed JSON, or an unknown active id leaves active()
// null and block() "", and the app behaves exactly as it did before this module existed.
(function (global) {
  function cfg() { return (global.CONFIG || {}).profile || {}; }
  function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
  // Same semantics as settings.js: objects merge, arrays and scalars replace. Replacing arrays is
  // the behavior we want - editing a list in the Prep tab means "this is the list now".
  function merge(dst, src) {
    Object.keys(src || {}).forEach(function (k) {
      if (isObj(src[k]) && isObj(dst[k])) merge(dst[k], src[k]);
      else dst[k] = src[k];
    });
    return dst;
  }
  function warn(m, e) { try { if (global.console) console.warn("[copilot] profile: " + m, e || ""); } catch (x) {} }

  // Hard caps on what reaches the model. The dossier can be tens of thousands of characters and
  // one_liner is a free-text field the user can paste anything into; without these, a live prompt
  // could balloon and cost seconds on the compose path.
  // 12000 chars is roughly 3000 tokens on the compose prompt. That is a deliberate spend: this block
  // is the highest-value context the copilot has for this interview. The code and summary blocks stay
  // tiny because neither task benefits from the detail.
  // 16000 chars is roughly 4000 tokens. Sized so that the whole curated profile fits WITHOUT being
  // trimmed, with room left for a slice of the uploaded dossier.
  var CAPS = { answer: 16000, code: 1000, summary: 400 };
  // The uploaded dossier is the ONLY flexible section. Everything authored in the profile - facts,
  // must-hit, do-not-say, prepared answers, questions - is kept whole.
  //
  // The facts list used to be flexible too, on the reasoning that it was "also reachable through
  // retrieval". That was simply false: company.facts exists only in profile.json and is never
  // uploaded, chunked or indexed, so trimming it deleted the information outright. With a 15k
  // dossier competing for the same budget, 11 of 12 curated facts were being silently dropped -
  // from the block whose entire job is answering "what do you know about us". Only trim what has
  // somewhere else to live.
  var FLEX_MIN = 400;   // a flexible section gets at least this much, or nothing at all

  var listCache = [];
  var activeProfile = null;
  var dossier = "";            // company_research + interview_details text, set from app.js
  var blockCache = {};
  var cacheKey = null;
  var changeCbs = [];

  var TRIM = "\n[...trimmed]";
  // Cap INCLUDING the marker: slicing to n and then appending overshoots, which is exactly how a
  // "hard cap" quietly stops being one.
  function cap(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - TRIM.length)) + TRIM;
  }
  function txt(v) { return v == null ? "" : String(v).trim(); }
  function arr(v) { return Array.isArray(v) ? v.filter(function (x) { return txt(x) || isObj(x); }) : []; }
  function bust() { blockCache = {}; cacheKey = null; }
  function notify() { changeCbs.forEach(function (f) { try { f(activeProfile); } catch (e) {} }); }

  function activeId() { return txt(cfg().activeId); }

  function overridesFor(id) {
    var s = global.SETTINGS ? SETTINGS.stored() : null;
    var all = (isObj(s) && s.profileOverrides) || null;
    return isObj(all) ? all[id] : null;
  }

  function fileFor(id) {
    for (var i = 0; i < listCache.length; i++) {
      if (listCache[i] && listCache[i].id === id && listCache[i].file) return listCache[i].file;
    }
    return "profiles/" + id + "/profile.json";
  }

  // app.js gates init() on PROFILE.ready, so an unbounded fetch here would mean a blank UI rather
  // than a degraded one. Every other network call in this app has a timeout; these must too.
  function loadJSON(url) {
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    var t = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} }, 4000);
    var opts = { cache: "no-store" };
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts)
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .catch(function (e) { clearTimeout(t); warn("could not load " + url, e); return null; });
  }

  function loadActive() {
    var id = activeId();
    activeProfile = null;
    bust();
    if (!id) return Promise.resolve(null);
    return loadJSON(fileFor(id)).then(function (base) {
      if (!isObj(base)) { warn("profile '" + id + "' missing or not an object; running without one"); notify(); return null; }
      var merged;
      try { merged = JSON.parse(JSON.stringify(base)); }
      catch (e) { warn("profile '" + id + "' is not serializable", e); notify(); return null; }
      var ov = overridesFor(id);
      if (isObj(ov)) merge(merged, ov);
      activeProfile = merged;
      bust();
      notify();
      return activeProfile;
    });
  }

  var ready = (global.SETTINGS ? SETTINGS.ready : Promise.resolve({}))
    .catch(function () { return {}; })
    .then(function () { return loadJSON(cfg().indexUrl || "profiles/index.json"); })
    .then(function (idx) { listCache = (isObj(idx) && Array.isArray(idx.profiles)) ? idx.profiles : []; })
    .then(loadActive)
    .catch(function (e) { warn("init failed", e); return null; });

  // ---- block rendering ----

  function factLine(f) {
    if (!isObj(f)) return "- " + txt(f);
    var mark = f.verified === false ? "(unconfirmed) " : "";
    return "- " + mark + txt(f.text);
  }

  function section(title, items, fn) {
    var lines = arr(items).map(fn || function (x) { return "- " + txt(x); }).filter(function (l) { return l.length > 2; });
    return lines.length ? "\n\n" + title + "\n" + lines.join("\n") : "";
  }

  function headline(p) {
    var c = p.company || {}, r = p.role || {}, iv = p.interview || {};
    var out = [];
    var who = txt(c.name) + (txt(c.domain) ? " (" + txt(c.domain) + ")" : "");
    if (who) out.push("COMPANY: " + who + (txt(c.one_liner) ? ". " + txt(c.one_liner) : ""));
    if (txt(r.title)) out.push("ROLE: " + txt(r.title));
    var interviewer = [txt(iv.interviewer_name), txt(iv.interviewer_role), txt(iv.interviewer_region)]
      .filter(Boolean).join(", ");
    if (interviewer) out.push("INTERVIEWER: " + interviewer);
    var fmt = [txt(iv.format), iv.duration_min ? iv.duration_min + " min" : "", txt(iv.stage), txt(iv.date)]
      .filter(Boolean).join(", ");
    if (fmt) out.push("FORMAT: " + fmt);
    return out.join("\n");
  }

  function answerBlock(p) {
    var c = p.company || {}, r = p.role || {};
    var parts = [];
    function keep(s) { if (s) parts.push({ s: s, flex: false }); }
    function trimmable(s) { if (s) parts.push({ s: s, flex: true }); }

    var head = "=== COMPANY & INTERVIEW (researched fact about who the candidate is talking to) ===\n" + headline(p);
    if (txt(p.interview && p.interview.notes)) head += "\nINTERVIEW NOTES: " + txt(p.interview.notes);
    keep(head);

    keep(section("WHAT THIS ROLE WANTS (frame answers against these):", r.what_they_want));
    keep(section("COMPANY FACTS (use ONLY these; never invent another fact about this company. Items\n" +
      "marked (unconfirmed) are unverified: allude to them, never assert them):", c.facts, factLine));

    if (txt(c.thesis)) {
      keep("\n\nTHE CANDIDATE'S OWN VIEW OF THEIR HARD PROBLEM (his opinion, already formed; reuse\n" +
        "this framing and language rather than inventing a different take):\n" + txt(c.thesis));
    }

    keep(section("MUST HIT (the candidate wants to land these; work one in whenever the question gives\n" +
      "a natural opening, never force one):", p.must_hit));
    keep(section("DO NOT SAY (hard prohibitions; never put any of these in a talking point):", p.do_not_say));
    keep(section("IF THEY PUSH BACK (prepared answers; use one when the question echoes the objection.\n" +
      "Keep these SHORT - about 20 seconds - and lead with the artifact, not the explanation):",
      p.objections, function (o) {
        if (!isObj(o)) return "- " + txt(o);
        var a = "- \"" + txt(o.objection) + "\" -> " + txt(o.answer);
        if (txt(o.artifact)) a += "  [proof: " + txt(o.artifact) + "]";
        return a;
      }));
    keep(section("QUESTIONS TO ASK THEM (only when the interviewer invites questions):", p.questions_to_ask));

    if (txt(dossier)) {
      trimmable("\n\nRESEARCH DOSSIER (uploaded; may be truncated here, the rest is searchable and may\n" +
        "appear in REFERENCE NOTES):\n" + txt(dossier));
    }

    var tail = "\n=== END COMPANY & INTERVIEW ===";
    var fixedLen = tail.length;
    parts.forEach(function (x) { if (!x.flex) fixedLen += x.s.length; });

    // Share whatever the fixed sections left over between the flexible ones, in proportion to what
    // each actually needs. A share below FLEX_MIN is dropped rather than rendered as a stub.
    var budget = Math.max(0, CAPS.answer - fixedLen);
    if (fixedLen > CAPS.answer) {
      warn("authored profile is " + fixedLen + " chars, over the " + CAPS.answer + " answer cap; " +
        "the uploaded dossier will be dropped. Trim the profile or raise CAPS.answer.");
    }
    // Admit whole any flexible part that already fits, smallest first, then split what is left in
    // proportion to what the rest still want. Without the greedy pass a SHORT section could compute
    // a share below FLEX_MIN and be dropped while budget went unused.
    var flex = parts.filter(function (x) { return x.flex; }).sort(function (a, b) { return a.s.length - b.s.length; });
    var grant = {}, remaining = budget, pending = [];
    flex.forEach(function (x) {
      if (x.s.length <= remaining / Math.max(1, flex.length - Object.keys(grant).length)) {
        grant[parts.indexOf(x)] = x.s.length; remaining -= x.s.length;
      } else pending.push(x);
    });
    var want = 0;
    pending.forEach(function (x) { want += x.s.length; });
    pending.forEach(function (x) {
      var share = want ? Math.floor(remaining * (x.s.length / want)) : 0;
      grant[parts.indexOf(x)] = share;
    });
    var out = "";
    parts.forEach(function (x, i) {
      if (!x.flex) { out += x.s; return; }
      var share = grant[i] || 0;
      if (x.s.length <= share) { out += x.s; return; }
      if (share < FLEX_MIN) return;                    // no room for a useful excerpt: omit it
      out += cap(x.s, share);
    });
    // Cap the BODY, then always append the terminator. Capping `out + tail` would eat the
    // "=== END COMPANY & INTERVIEW ===" marker first, and an unterminated block runs straight into
    // the CANDIDATE CONTEXT heading that follows it in the prompt - which is exactly how company
    // facts end up being reported as things from the candidate's resume.
    return cap(out, Math.max(0, CAPS.answer - tail.length)) + tail;
  }

  function codeBlock(p) {
    var c = p.company || {}, r = p.role || {};
    var s = "=== COMPANY & INTERVIEW ===\n";
    var who = txt(c.name) + (txt(c.domain) ? " (" + txt(c.domain) + ")" : "");
    if (who) s += "COMPANY: " + who + (txt(c.one_liner) ? ". " + txt(c.one_liner) : "") + "\n";
    if (txt(r.title)) s += "ROLE: " + txt(r.title) + "\n";
    var stack = arr(c.tech_context).map(txt).filter(Boolean);
    if (stack.length) {
      s += "THEIR STACK (prefer these idioms and libraries when the question does not specify; this " +
        "is background alignment only and NEVER overrides an explicit interviewer requirement): " +
        stack.join(", ") + "\n";
    }
    return s + "=== END COMPANY & INTERVIEW ===";
  }

  function summaryBlock(p) {
    var c = p.company || {}, r = p.role || {}, iv = p.interview || {};
    var bits = [];
    var who = txt(c.name) + (txt(c.domain) ? " (" + txt(c.domain) + ")" : "");
    if (who) bits.push("COMPANY: " + who);
    if (txt(r.title)) bits.push("ROLE: " + txt(r.title));
    var interviewer = [txt(iv.interviewer_role), txt(iv.interviewer_region)].filter(Boolean).join(", ");
    if (interviewer) bits.push("INTERVIEWER: " + interviewer);
    var fmt = [txt(iv.format), iv.duration_min ? iv.duration_min + " min" : ""].filter(Boolean).join(", ");
    if (fmt) bits.push("FORMAT: " + fmt);
    if (!bits.length) return "";
    return "=== COMPANY & INTERVIEW (known before the call; treat as established fact) ===\n" +
      bits.join(" | ") + "\n=== END COMPANY & INTERVIEW ===";
  }

  var RENDER = { answer: answerBlock, code: codeBlock, summary: summaryBlock };

  // Rendered on demand and memoized. llm.js calls this on every compose/codegen, so it must be
  // free after the first call in a given state.
  function block(mode) {
    mode = RENDER[mode] ? mode : "answer";
    if (!activeProfile) return "";
    var key = activeId() + "|" + dossier.length;
    if (key !== cacheKey) { blockCache = {}; cacheKey = key; }
    if (blockCache[mode] != null) return blockCache[mode];
    var out = "";
    try { out = cap(RENDER[mode](activeProfile), CAPS[mode]); }
    catch (e) { warn("block render failed", e); out = ""; }
    blockCache[mode] = out;
    return out;
  }

  // Fingerprint of ONLY the parts that change what generated code should look like. Deliberately
  // narrow: if this covered the whole profile, typing one character into "questions to ask them"
  // would mark every card's code stale and fan out regenerations mid-call.
  function sig() {
    if (!activeProfile) return "";
    var c = activeProfile.company || {}, r = activeProfile.role || {};
    var s = [activeProfile.id || "", txt(c.name), txt(r.title),
      arr(c.tech_context).map(txt).sort().join(",")].join("|");
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return String(h);
  }

  // ---- mutation ----

  function setActive(id) {
    if (global.SETTINGS) SETTINGS.save({ profile: { activeId: txt(id) } });
    else if (global.CONFIG) { global.CONFIG.profile = global.CONFIG.profile || {}; global.CONFIG.profile.activeId = txt(id); }
    return loadActive();
  }

  // Set one field by dotted path ("company.one_liner", "must_hit"). Persists as an override so the
  // committed file stays clean.
  function set(path, value) {
    var id = activeId();
    if (!id || !path) return;
    var keys = String(path).split(".");
    var patch = {}, node = patch;
    for (var i = 0; i < keys.length - 1; i++) { node[keys[i]] = {}; node = node[keys[i]]; }
    node[keys[keys.length - 1]] = value;
    if (activeProfile) merge(activeProfile, patch);   // apply locally so the UI is instant
    var wrap = { profileOverrides: {} };
    wrap.profileOverrides[id] = patch;
    if (global.SETTINGS) SETTINGS.save(wrap);
    bust();
    notify();
  }

  function reset() {
    var id = activeId();
    if (!id) return Promise.resolve(null);
    var wrap = { profileOverrides: {} };
    wrap.profileOverrides[id] = null;   // scalar replace clears the whole override
    if (global.SETTINGS) SETTINGS.save(wrap);
    return loadActive();
  }

  // Company-doc text pulled from the rag-server, folded into the answer block.
  function setDossier(text) {
    var t = txt(text);
    if (t === dossier) return;
    dossier = t;
    bust();
  }

  function onChange(fn) { if (typeof fn === "function") changeCbs.push(fn); }

  global.PROFILE = {
    ready: ready,
    list: function () { return listCache.slice(); },
    active: function () { return activeProfile; },
    activeId: activeId,
    setActive: setActive,
    set: set,
    reset: reset,
    block: block,
    sig: sig,
    setDossier: setDossier,
    onChange: onChange
  };
})(window);
