// Tech Interview Copilot wiring. Vanilla JS, no build step. Owns all rendering; the ASR and QA
// modules never touch the DOM (they call the callbacks registered here / the plugin API below).
(function () {
  var CONFIG = window.CONFIG || {};
  var state = {
    currentLeft: "answers",
    copilotView: "live",
    live: false,
    llmOnline: false,
    ragHealth: null,       // /health payload or null
    selectedCardId: null,  // card shown on the Code tab
    interim: "",
    cheatsCache: {},       // sheet name -> markdown
    currentCheat: "big-o",
    meterStops: [],        // active Config-tab level meter stop() fns
    docs: [],              // uploaded candidate docs
    docsLoaded: false,     // candidate context actually reached the model side
    voiceOnline: null,     // speaker sidecar reachable (null = not probed yet)
    voices: {},            // cluster id -> {n, name, persistent, ts}
    namingVoice: null      // cluster id whose rename form is open
  };

  // el/esc/dbg/notify/timeShort come from copilot-core's shell.js (loaded before this file) rather
  // than being redefined here -- they were byte-identical to hearing-copilot's copies, which is
  // exactly the duplication copilot-core exists to remove.
  var Shell = window.CopilotShell || {};
  var el = Shell.el || function (id) { return document.getElementById(id); };
  var esc = Shell.esc || function (s) { return String(s || ""); };
  var dbg = Shell.makeLogger ? Shell.makeLogger("copilot", function () { return !!CONFIG.debug; })
                              : function () {};
  var timeShort = Shell.timeShort || function (ts) { return new Date(ts).toLocaleTimeString(); };
  var notifier = Shell.makeNotifier ? Shell.makeNotifier({
    max: (CONFIG.ui && CONFIG.ui.notifierMax) || 12,
    onChange: function () { if (state.copilotView === "live") renderCopilot(); }
  }) : null;
  function notify(msg) { if (notifier) notifier.notify(msg); }

  // ---------- answer cards ----------
  function badgeFor(card) {
    var t = card.question.type || "conceptual";
    var cls = t === "behavioral" ? "behavioral" : (t === "coding" ? "coding" : "");
    if (card.offline) cls = "offline";
    return "<span class='badge " + cls + "'>" + esc(card.offline ? t + " · offline" : t) + "</span>";
  }
  function cardHtml(card, fresh) {
    var a = card.answer;
    var h = "<div class='card" + (fresh ? " fresh" : "") + (card.offline ? " offline" : "") + "' data-card='" + card.id + "'>";
    h += "<div class='head'>" + badgeFor(card) +
      "<span class='qtext'>" + esc(card.question.normalized) + "</span>" +
      (card.revision ? "<span class='badge rev' title='Rebuilt with everything the interview has " +
        "established since this question was asked" + (card.refreshReason ? ": " + esc(card.refreshReason) : "") +
        "'>updated v" + card.revision + "</span>" : "") +
      "<span class='qtime'>" + timeShort(card.ts) + "</span></div>";
    if (card.refreshing) h += "<div class='working'>Rebuilding with session context&hellip;</div>";
    else if (card.refreshReason && card.revision) h += "<div class='rev-why'>Rebuilt: " + esc(card.refreshReason) + "</div>";
    if (card.status === "detecting" || card.status === "retrieving") {
      h += "<div class='working'>Looking it up&hellip;</div>";
    } else if (card.status === "answering") {
      h += "<div class='working'>Composing the answer&hellip;</div>";
    } else if (card.status === "error") {
      h += "<div class='pitfalls'>Could not compose an answer (model unreachable). Topics: " +
        esc((card.question.topics || []).join(", ") || "n/a") + "</div>";
    }
    if (a) {
      if (a.headline) h += "<div class='headline'>" + esc(a.headline) + "</div>";
      if (a.talking_points && a.talking_points.length)
        h += "<ul class='points'>" + a.talking_points.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>";
      h += "<div class='meta-row'>";
      if (a.complexity && (a.complexity.time || a.complexity.space))
        h += "<span class='chip cx'>" + esc(a.complexity.time || "?") + " time · " + esc(a.complexity.space || "?") + " space</span>";
      if (card.question.needsCode || a.wants_code || card.code)
        h += "<button class='btn-mini show-code' data-card='" + card.id + "'>Show code</button>";
      h += "<button class='btn-mini refresh-card' data-card='" + card.id + "' title='Redraft this " +
        "answer using everything the interview has established since it was asked'>Refresh</button>";
      if (a.structure) h += "<span class='structure'>" + esc(a.structure) + "</span>";
      h += "</div>";
      // What to pull from the candidate's own uploaded material for THIS answer. Highlighted
      // because saying it out loud is what makes the answer specific to them and the role.
      if (a.from_your_docs && a.from_your_docs.length) {
        h += "<div class='from-docs'><div class='fd-h'>Mention from your documents</div><ul>" +
          a.from_your_docs.map(function (d) {
            if (!d) return "";
            return "<li>" + esc(d.point || "") +
              (d.source ? " <span class='fd-src'>(" + esc(d.source) + ")</span>" : "") +
              (d.why ? "<span class='fd-why'>" + esc(d.why) + "</span>" : "") + "</li>";
          }).join("") + "</ul></div>";
      }
      if (a.pitfalls && a.pitfalls.length) h += "<div class='pitfalls'>Avoid: " + esc(a.pitfalls.join(" · ")) + "</div>";
      if (a.followups_to_expect && a.followups_to_expect.length)
        h += "<div class='followups'>Likely follow-ups: " + esc(a.followups_to_expect.join(" · ")) + "</div>";
    } else if (card.status === "offline") {
      // Offline tier: topics + raw retrieved study material (retrieval is local, works without the LLM).
      h += "<div class='working'>LLM offline. Matched topics: <b>" + esc((card.question.topics || []).join(", ") || "none") + "</b></div>";
      if (card.sources && card.sources.length)
        h += "<ul class='points'>" + card.sources.slice(0, 3).map(function (s) {
          return "<li><b>" + esc(s.title || s.path) + "</b>: " + esc(String(s.text || "").slice(0, 260)) + "&hellip;</li>";
        }).join("") + "</ul>";
    }
    if (card.sources && card.sources.length && !card.offline) {
      h += "<div class='sources'>Sources: " + card.sources.slice(0, 4).map(function (s) {
        return esc(s.repo + "/" + s.path);
      }).join(" · ") + "</div>";
    }
    h += "</div>";
    return h;
  }
  function renderAnswers() {
    var body = el("left-body"); if (!body) return;
    body.className = "body";
    var cards = QA.cards().slice().reverse();
    if (!cards.length) {
      body.innerHTML = "<div class='note'>No questions detected yet. Press <b>Start</b>, and when an " +
        "interviewer asks a technical question an answer card appears here. Configure your microphone and " +
        "the BlackHole meeting-audio device on the <b>Config</b> tab first.</div>";
      return;
    }
    body.innerHTML = cards.map(function (c, i) { return cardHtml(c, i === 0 && Date.now() - c.ts < 60000); }).join("");
    body.querySelectorAll(".refresh-card").forEach(function (b) {
      b.onclick = function () {
        var c = QA.byId(b.getAttribute("data-card"));
        if (c) { notify("Rebuilding answer with session context…"); QA.refreshCard(c, "manual refresh"); }
      };
    });
    body.querySelectorAll(".show-code").forEach(function (b) {
      b.onclick = function () {
        state.selectedCardId = b.getAttribute("data-card");
        var card = QA.byId(state.selectedCardId);
        if (card && !card.code) QA.requestLanguage(card, CODEPANEL.currentLang(card));
        ensureLeftView("code");
      };
    });
  }

  // ---------- code tab ----------
  function codeCard() {
    if (state.selectedCardId) { var c = QA.byId(state.selectedCardId); if (c) return c; }
    // default: the newest card that has (or wants) code
    var cards = QA.cards();
    for (var i = cards.length - 1; i >= 0; i--) {
      var c2 = cards[i];
      if (c2.code || c2.question.needsCode || (c2.answer && c2.answer.wants_code)) return c2;
    }
    return null;
  }
  function renderCode() {
    var body = el("left-body"); if (!body) return;
    body.className = "body";
    CODEPANEL.render(body, codeCard());
  }

  // ---------- session brief (rolling summary) ----------
  function briefRows(bucket, title, cls) {
    var S = SUMMARY.get(), keys = Object.keys(S[bucket] || {});
    if (!keys.length) return "";
    keys.sort(function (a, b) { return (S[bucket][b].ts || 0) - (S[bucket][a].ts || 0); });
    return "<div class='brief-sec " + (cls || "") + "'><div class='brief-h'>" + title + "</div><ul>" +
      keys.map(function (k) {
        var it = S[bucket][k];
        var st = it.status ? " <span class='brief-status st-" + esc(it.status) + "'>" + esc(it.status) + "</span>" : "";
        return "<li>" + esc(it.text) + st + "</li>";
      }).join("") + "</ul></div>";
  }
  // Your own notes. These outrank anything the summarizer inferred from the audio, and they are
  // fed into every answer and code generation, so a line typed here ("they want it iterative, no
  // recursion") changes the code on the Code tab.
  function notesHtml() {
    return "<div class='notes-sec'>" +
      "<div class='brief-h'>Your notes <span class='notes-hint'>(used by every answer and code " +
        "generation, and they override what the app inferred)</span></div>" +
      "<textarea id='br-notes' class='notes-in' rows='5' placeholder='e.g. Iterative only, no recursion.\n" +
        "Target is Go, not Python.\nThey care about error handling.'>" + esc(SUMMARY.notes()) + "</textarea>" +
      "<div class='notes-row'><span class='note' id='br-notes-status' style='padding:0'></span>" +
        "<span class='tab-spacer'></span>" +
        "<button class='btn-mini' id='br-notes-apply'>Apply to code</button></div>" +
      "</div>";
  }
  var notesTimer = null;
  function wireNotes() {
    var ta = el("br-notes"); if (!ta) return;
    ta.oninput = function () {
      var st = el("br-notes-status"); if (st) st.textContent = "saving…";
      clearTimeout(notesTimer);
      notesTimer = setTimeout(function () {
        SUMMARY.setNotes(ta.value);
        var s = el("br-notes-status");
        if (s) s.textContent = "saved. Code regenerates on the next update.";
      }, 600);
    };
    var ap = el("br-notes-apply");
    if (ap) ap.onclick = function () {
      SUMMARY.setNotes(ta.value);
      var n = QA.refreshStaleCode();
      notify(n ? "Notes applied: updating code on " + n + " card" + (n === 1 ? "" : "s") + "."
               : "Notes saved. No generated code is out of date.");
      var s = el("br-notes-status"); if (s) s.textContent = "applied.";
    };
  }

  function renderBrief() {
    var body = el("left-body"); if (!body) return;
    body.className = "body";
    var S = SUMMARY.get();
    var pend = SUMMARY.pendingCount();
    var head = "<div class='tl-bar'>" +
      "<span class='note' style='padding:0'>" +
        (S.passes ? "Updated " + new Date(S.updatedAt).toLocaleTimeString() + " · " + S.passes + " pass" + (S.passes === 1 ? "" : "es")
                  : "No summary yet") +
        (pend ? " · " + pend + " new line" + (pend === 1 ? "" : "s") + " pending" : "") +
        (SUMMARY.isBusy() ? " · summarizing…" : "") +
      "</span><span class='tab-spacer'></span>" +
      "<button class='btn-mini' id='br-now'" + (SUMMARY.isBusy() ? " disabled" : "") + ">Summarize now</button>" +
      "</div>";
    if (!S.passes) {
      body.innerHTML = head + "<div class='note'>The session brief builds itself as the interview goes. " +
        "Every " + Math.round(((CONFIG.summarize || {}).everyMs || 25000) / 1000) + "s it folds new transcript " +
        "lines into a running picture of the role, the constraints the interviewer has set, what you have " +
        "already claimed, and what is still open. That picture is then fed into every new answer, and cards " +
        "whose answer no longer fits are rebuilt automatically." +
        (S.lastError ? "<br><br><b>Last attempt failed:</b> " + esc(S.lastError) : "") + "</div>" +
        notesHtml();
      var b0 = el("br-now"); if (b0) b0.onclick = runSummaryNow;
      wireNotes();
      return;
    }
    var rc = S.role_context, rcBits = [];
    if (rc.company) rcBits.push("<b>" + esc(rc.company) + "</b>");
    if (rc.role) rcBits.push(esc(rc.role));
    if (rc.stack && rc.stack.length) rcBits.push("stack: " + esc(rc.stack.join(", ")));
    if (rc.notes) rcBits.push(esc(rc.notes));
    body.innerHTML = head +
      (S.narrative ? "<div class='brief-narrative'>" + esc(S.narrative) + "</div>" : "") +
      (rcBits.length ? "<div class='brief-role'>" + rcBits.join(" · ") + "</div>" : "") +
      briefRows("constraints", "Constraints the interviewer set", "warn") +
      briefRows("claims", "What you have already said") +
      briefRows("threads", "Still open") +
      briefRows("topics", "Topics covered") +
      briefRows("focus", "Interviewer focus") +
      notesHtml() +
      (S.lastError ? "<div class='banner'>Last summary attempt failed: " + esc(S.lastError) + "</div>" : "");
    var b = el("br-now"); if (b) b.onclick = runSummaryNow;
    wireNotes();
  }
  function runSummaryNow() {
    if (SUMMARY.isBusy()) return;
    notify("Summarizing the session…");
    renderBrief();
    SUMMARY.runNow().then(function (ok) {
      notify(ok ? "Session brief updated." : "Nothing new to summarize.");
      if (state.currentLeft === "brief") renderBrief();
    });
  }

  // ---------- cheat sheets ----------
  var CHEATS = [
    { id: "big-o", label: "Big-O", path: "cheatsheets/big-o.md" },
    { id: "patterns", label: "Algo patterns", path: "cheatsheets/patterns.md" },
    { id: "system-design", label: "System design", path: "cheatsheets/system-design.md" },
    { id: "behavioral", label: "Behavioral / STAR", path: "cheatsheets/behavioral.md" }
  ];
  function renderCheats() {
    var body = el("left-body"); if (!body) return;
    body.className = "body";
    var bar = "<div class='code-pills'>" + CHEATS.map(function (c) {
      return "<button class='pill" + (c.id === state.currentCheat ? " on" : "") + "' data-sheet='" + c.id + "'>" + c.label + "</button>";
    }).join("") + "</div>";
    body.innerHTML = bar + "<div class='md' id='cheat-body'>Loading&hellip;</div>";
    body.querySelectorAll("[data-sheet]").forEach(function (b) {
      b.onclick = function () { state.currentCheat = b.getAttribute("data-sheet"); renderCheats(); };
    });
    var sheet = CHEATS.filter(function (c) { return c.id === state.currentCheat; })[0] || CHEATS[0];
    if (state.cheatsCache[sheet.id]) { el("cheat-body").innerHTML = MD.render(state.cheatsCache[sheet.id]); return; }
    fetch(sheet.path).then(function (r) { return r.ok ? r.text() : "Could not load " + sheet.path; })
      .then(function (t) {
        state.cheatsCache[sheet.id] = t;
        var cb = el("cheat-body"); if (cb) cb.innerHTML = MD.render(t);
      }).catch(function () {});
  }

  // ---------- prep tab (doc uploads + KB status) ----------
  function renderPrep() {
    var body = el("left-body"); if (!body) return;
    body.className = "body";
    var kb = state.ragHealth;
    var kbHtml;
    if (kb === null) kbHtml = "<div class='banner'>rag-server not reachable on " +
      esc(((CONFIG.answers || {}).rag || {}).url || "") + ". Uploads and retrieval are off. " +
      "Build the knowledge base and relaunch (see README: <code>kb/ingest.py</code>).</div>";
    else kbHtml = "<div class='kb-stats'>Knowledge base: <b>" + (kb.chunks || 0) + "</b> chunks" +
      (kb.repos ? " across " + Object.keys(kb.repos).length + " repos (" +
        Object.keys(kb.repos).map(function (r) { return esc(r) + ": " + kb.repos[r]; }).join(", ") + ")" : "") +
      (kb.built ? " · built " + esc(kb.built) : "") + (kb.model ? " · " + esc(kb.model) : "") + "</div>";
    body.innerHTML =
      "<div class='prep'>" +
        profileEditorHtml() +
        "<div class='note'>Upload your <b>resume</b>, the <b>job description</b>, your <b>company research</b>, " +
        "and any other relevant documents (.pdf, .txt, .md). Everything except large “other” and " +
        "“company research” files is given to the model with every answer; oversized ones are indexed " +
        "for retrieval instead.</div>" +
        "<div class='drop' id='drop'>Drop files here or click to choose</div>" +
        "<input type='file' id='file-input' multiple accept='.pdf,.txt,.md' class='hidden'>" +
        "<div id='doc-list'></div>" + kbHtml +
      "</div>";
    wireProfileEditor();
    var drop = el("drop"), fi = el("file-input");
    drop.onclick = function () { fi.click(); };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = function () { drop.classList.remove("over"); };
    drop.ondrop = function (e) {
      e.preventDefault(); drop.classList.remove("over");
      uploadFiles(e.dataTransfer.files);
    };
    fi.onchange = function () { uploadFiles(fi.files); fi.value = ""; };
    renderDocList();
  }
  // ---------- interview profile editor (Prep tab) ----------
  // Edits here are per-machine overrides in settings.json; the committed profiles/<id>/profile.json
  // is never touched, so tuning during a call cannot dirty the working tree.
  var PF_FIELDS = [
    { p: "company.name", l: "Company", t: "text" },
    { p: "company.domain", l: "Domain", t: "text" },
    { p: "role.title", l: "Role", t: "text" },
    { p: "interview.interviewer_role", l: "Interviewer", t: "text" },
    { p: "interview.interviewer_region", l: "Region", t: "text" },
    { p: "interview.date", l: "Date", t: "text" },
    { p: "interview.format", l: "Format", t: "text" },
    { p: "interview.duration_min", l: "Minutes", t: "num" },
    { p: "interview.stage", l: "Stage", t: "text" },
    { p: "company.one_liner", l: "One-line description of the company", t: "area" },
    { p: "company.thesis", l: "My view of their hard problem (stated as an opinion)", t: "area" },
    { p: "company.facts", l: "Company facts — one per line. Start a line with ? if unconfirmed; add \" | url\" for the source", t: "facts" },
    { p: "role.what_they_want", l: "What this role wants — one per line", t: "list" },
    { p: "company.tech_context", l: "Their stack — one per line", t: "list" },
    { p: "must_hit", l: "Must hit — one per line", t: "list" },
    { p: "do_not_say", l: "Do NOT say — one per line", t: "list" },
    { p: "objections", l: "If they push back — one per line, as  objection :: answer :: proof", t: "objections" },
    { p: "questions_to_ask", l: "Questions to ask them — one per line", t: "list" }
  ];
  function pfGet(obj, path) {
    return String(path).split(".").reduce(function (o, k) { return (o == null) ? undefined : o[k]; }, obj);
  }
  function pfToText(t, v) {
    if (v == null) return "";
    if (t === "list") return (v || []).join("\n");
    if (t === "facts") {
      return (v || []).map(function (f) {
        if (!f || typeof f !== "object") return String(f);
        return (f.verified === false ? "? " : "") + (f.text || "") + (f.source ? " | " + f.source : "");
      }).join("\n");
    }
    if (t === "objections") {
      return (v || []).map(function (o) {
        if (!o || typeof o !== "object") return String(o);
        return [o.objection || "", o.answer || "", o.artifact || ""].join(" :: ");
      }).join("\n");
    }
    return String(v);
  }
  function pfFromText(t, s) {
    var lines = String(s || "").split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
    if (t === "list") return lines;
    if (t === "num") { var n = parseInt(s, 10); return isNaN(n) ? null : n; }
    if (t === "facts") {
      return lines.map(function (line) {
        var unconfirmed = /^\?\s*/.test(line);
        var rest = line.replace(/^\?\s*/, "");
        var bits = rest.split("|");
        return { text: bits[0].trim(), source: (bits[1] || "").trim(), verified: !unconfirmed };
      });
    }
    if (t === "objections") {
      return lines.map(function (line) {
        var b = line.split("::");
        return { objection: (b[0] || "").trim(), answer: (b[1] || "").trim(), artifact: (b[2] || "").trim() };
      });
    }
    return String(s == null ? "" : s);
  }
  function profileEditorHtml() {
    if (!window.PROFILE) return "";
    var p = PROFILE.active();
    var list = PROFILE.list();
    var opts = ["<option value=''" + (PROFILE.activeId() ? "" : " selected") + ">(none)</option>"].concat(
      list.map(function (x) {
        return "<option value='" + esc(x.id) + "'" + (x.id === PROFILE.activeId() ? " selected" : "") + ">" +
          esc(x.label || x.id) + "</option>";
      })).join("");
    var head = "<div class='note'>The <b>interview profile</b> tells the copilot which company and role " +
      "this interview is for, before the first question. It is sent with every answer. Edits here are " +
      "saved to this machine only.</div>" +
      "<div class='pf-row'><label>Profile</label><select id='pf-active'>" + opts + "</select>" +
      "<button class='btn-mini' id='pf-reset'>Reset to committed file</button></div>";
    if (!p) {
      return "<div class='profile-editor'>" + head +
        "<div class='banner'>No profile loaded. Answers will not be framed for any company.</div></div>";
    }
    var fields = PF_FIELDS.map(function (f) {
      var val = esc(pfToText(f.t, pfGet(p, f.p)));
      if (f.t === "text" || f.t === "num") {
        return "<div class='pf-row'><label for='pf-" + f.p + "'>" + esc(f.l) + "</label>" +
          "<input type='text' id='pf-" + f.p + "' data-pf='" + f.p + "' data-pft='" + f.t + "' value='" + val + "'></div>";
      }
      return "<div class='pf-block'><label for='pf-" + f.p + "'>" + esc(f.l) + "</label>" +
        "<textarea id='pf-" + f.p + "' data-pf='" + f.p + "' data-pft='" + f.t + "' rows='" +
        (f.t === "area" ? 3 : 5) + "'>" + val + "</textarea></div>";
    }).join("");
    return "<div class='profile-editor'>" + head + fields + "</div>";
  }
  function wireProfileEditor() {
    if (!window.PROFILE) return;
    var sel = el("pf-active");
    if (sel) sel.onchange = function () { PROFILE.setActive(sel.value).then(function () { renderPrep(); renderCopilot(); }); };
    var rst = el("pf-reset");
    if (rst) rst.onclick = function () {
      PROFILE.reset().then(function () { renderPrep(); renderCopilot(); notify("Interview profile reset to the committed file."); });
    };
    // Same 600 ms debounce the Brief-tab notes box uses: saving on every keystroke would spam the
    // log-server and, for stack edits, could churn the code-requirements fingerprint mid-call.
    document.querySelectorAll("[data-pf]").forEach(function (inp) {
      var t = null;
      inp.oninput = function () {
        clearTimeout(t);
        t = setTimeout(function () {
          PROFILE.set(inp.getAttribute("data-pf"), pfFromText(inp.getAttribute("data-pft"), inp.value));
          if (state.copilotView === "live") renderLive();
        }, 600);
      };
    });
  }

  // Every kind the rag-server accepts, in the order it stuffs them into the prompt.
  var DOC_KINDS = ["resume", "job_description", "interview_details", "company_research", "other"];
  // Research is tested BEFORE the job description, and "role" is not a JD keyword: it appears in
  // almost every filename for a role-specific search, so "acme company research for the role.pdf"
  // was being routed to job_description and then travelling to the model as one of the candidate's
  // own documents. Misrouting research is far more damaging than misrouting a JD.
  function guessKind(name) {
    if (/resume|cv/i.test(name)) return "resume";
    if (/research|dossier|company|about|intel|brief/i.test(name)) return "company_research";
    if (/job|jd|description|posting/i.test(name)) return "job_description";
    if (/interview|logistics|schedule|invite|prep|script|mock|question/i.test(name)) return "interview_details";
    return "other";
  }
  function uploadFiles(files) {
    Array.prototype.slice.call(files || []).forEach(function (f) {
      var kind = guessKind(f.name);
      notify("Uploading " + f.name + "…");
      RAG.uploadDoc(f, kind).then(function (r) {
        notify(r && r.ok ? ("Uploaded " + f.name + " (" + kind + ", " + (r.chars || 0) + " chars extracted)")
                         : ("Upload failed: " + f.name + (r && r.error ? " - " + r.error : "")));
        refreshDocs();
      }).catch(function () { notify("Upload failed: " + f.name + " (rag-server down?)"); });
    });
  }
  function refreshDocs() {
    RAG.listDocs().then(function (docs) {
      state.docs = docs;
      if (state.currentLeft === "prep") renderDocList();
    });
  }
  function renderDocList() {
    var host = el("doc-list"); if (!host) return;
    if (!state.docs.length) { host.innerHTML = "<div class='note'>No documents uploaded yet.</div>"; return; }
    host.innerHTML = "<table class='docs'><thead><tr><th>Document</th><th>Kind</th><th>Text</th><th></th></tr></thead><tbody>" +
      state.docs.map(function (d) {
        var opts = DOC_KINDS.map(function (k) {
          return "<option value='" + k + "'" + (d.kind === k ? " selected" : "") + ">" + k.replace("_", " ") + "</option>";
        }).join("");
        return "<tr><td>" + esc(d.name) + "</td>" +
          "<td><select data-doc='" + esc(d.name) + "'>" + opts + "</select></td>" +
          "<td>" + (d.chars || 0) + " chars</td>" +
          "<td><button class='btn-mini' data-del='" + esc(d.name) + "'>Delete</button></td></tr>";
      }).join("") + "</tbody></table>";
    host.querySelectorAll("select[data-doc]").forEach(function (s) {
      s.onchange = function () { RAG.setDocKind(s.getAttribute("data-doc"), s.value).then(refreshDocs); };
    });
    host.querySelectorAll("[data-del]").forEach(function (b) {
      b.onclick = function () { RAG.deleteDoc(b.getAttribute("data-del")).then(refreshDocs); };
    });
  }

  // ---------- voice profiles ----------
  function SCFG() { return CONFIG.speakerId || {}; }
  function sessionId() { return SCFG().scopeId || "default"; }
  // Display name for a transcript line: the named voice if we have one, else the cluster id
  // ("Voice 2"), else the generic role.
  function speakerName(s) {
    if (s.role === "me") return "Me";
    if (s.name) return s.name;
    var c = s.voice && s.voice.cluster;
    if (c) {
      var v = state.voices[c];
      if (v && v.name) return v.name;
      return "Voice " + String(c).replace(/^V/, "");
    }
    return "Interviewer";
  }
  // Record the sidecar's verdict on the segment and keep the Voices strip in sync.
  function attachVoice(seg, voice) {
    if (!voice || voice.ok === false || !voice.cluster || !seg) return;
    var prev = state.voices[voice.cluster] || {};
    state.voices[voice.cluster] = {
      n: voice.clusterN || (prev.n || 0) + 1,
      name: voice.name || prev.name || null,
      persistent: !!voice.name || !!prev.persistent,
      ts: Date.now()
    };
    var patch = { voice: { cluster: voice.cluster, decision: voice.decision, sim: voice.sim, ts: voice.ts } };
    var nm = voice.name || (state.voices[voice.cluster] || {}).name;
    if (nm) patch.name = nm;      // a known voice labels its line immediately
    TLOG.update(seg.id, patch);
    if (state.copilotView === "live") renderVoicesStrip();
  }
  // Name (or rename) a voice: POST /label, then retroactively relabel every line of that cluster.
  function nameVoice(cluster, nm) {
    var sc = SCFG();
    if (!sc.url) return;
    fetch(sc.url + "/label", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionId(), cluster: cluster, name: nm || null })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) { notify("Could not name voice " + cluster); return; }
      var v = state.voices[cluster] || {};
      v.name = nm || null; v.persistent = !!nm;
      state.voices[cluster] = v;
      state.namingVoice = null;
      var n = 0;
      TLOG.byDate(TLOG.today()).forEach(function (s) {
        if (s.voice && s.voice.cluster === cluster && s.name !== nm) {
          TLOG.update(s.id, { name: nm || "" });
          n++;
        }
      });
      notify("Voice " + cluster + " is now \"" + (nm || "unnamed") + "\"" +
             (n ? " (" + n + " earlier line" + (n === 1 ? "" : "s") + " relabeled)" : ""));
      renderVoicesStrip();
      renderTranscript();
    }).catch(function () { notify("Naming failed (voice sidecar unreachable)"); });
  }
  // Reassign one line to a different voice; the correction also teaches that voice profile.
  function reassignLine(segId, cluster) {
    var seg = TLOG.byDate(TLOG.today()).filter(function (s) { return s.id === segId; })[0];
    if (!seg) return;
    var v = state.voices[cluster] || {};
    TLOG.update(segId, { voice: { cluster: cluster, decision: "manual", sim: null, ts: seg.voice && seg.voice.ts },
                         name: v.name || "" });
    var sc = SCFG();
    if (sc.url && seg.voice && seg.voice.ts) {
      fetch(sc.url + "/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: sessionId(), ts: seg.voice.ts, cluster: cluster })
      }).catch(function () {});
    }
    renderTranscript();
  }
  function probeVoice() {
    var sc = SCFG();
    if (!sc.enabled || !sc.url) { state.voiceOnline = false; return; }
    fetch(sc.url + "/health?session=" + encodeURIComponent(sessionId()))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        state.voiceOnline = !!(j && j.ok);
        return fetch(sc.url + "/voices?session=" + encodeURIComponent(sessionId()));
      })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        ((j && j.clusters) || []).forEach(function (c) {
          if (!c.persistent && !state.voices[c.cluster]) return;   // ignore other sessions' scratch clusters
          var prev = state.voices[c.cluster] || {};
          state.voices[c.cluster] = { n: c.n || prev.n || 0, name: c.name || prev.name || null,
            persistent: !!c.persistent, ts: prev.ts || Date.now() };
        });
        if (state.copilotView === "live") renderLive();
      })
      .catch(function () { state.voiceOnline = false; });
  }
  // The Voices strip on the Live tab: one pill per distinct voice heard. Click to name it.
  function renderVoicesStrip() {
    var host = el("voicesStrip"); if (!host) return;
    var sc = SCFG();
    var ids = Object.keys(state.voices);
    if (!sc.enabled) { host.innerHTML = ""; return; }
    if (!ids.length) {
      host.innerHTML = "<span class='voices-cap'>Voices heard: " +
        (state.voiceOnline === false ? "<span class='hint'>voice sidecar off, lines stay \"Interviewer\"</span>"
                                     : "<span class='hint'>none yet</span>") + "</span>";
      return;
    }
    ids.sort(function (a, b) { return (state.voices[b].n || 0) - (state.voices[a].n || 0); });
    host.innerHTML = "<span class='voices-cap'>Voices heard <span class='hint'>(click one to name it)</span>:</span>" +
      ids.map(function (k) {
        var x = state.voices[k];
        var label = x.name ? esc(x.name) : "unnamed";
        return "<button class='voice-pill" + (x.persistent ? " voice-pill-saved" : "") + "' data-vpill='" + k +
          "' title='" + (x.n || 0) + " chunk(s) heard" + (x.persistent ? "; saved for this session id" : "") +
          ". Click to name or rename this voice.'>" + k + " &middot; " + label + "</button>";
      }).join("") +
      (state.namingVoice ? voiceNamerHtml(state.namingVoice) : "");
    host.querySelectorAll("[data-vpill]").forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute("data-vpill");
        state.namingVoice = state.namingVoice === k ? null : k;
        renderVoicesStrip();
      };
    });
    wireVoiceNamer();
  }
  function voiceNamerHtml(cluster) {
    var x = state.voices[cluster] || {};
    return "<div class='voice-tagger' id='voiceNamer'>" +
      "<span class='vt-cap'>" + cluster + " is:</span>" +
      "<input type='text' id='vtName' class='vt-name' placeholder='e.g. Sarah (hiring manager)' value='" +
        esc(x.name || "") + "'>" +
      "<button class='btn-mini' id='vtSave'>Save</button>" +
      "<button class='btn-mini' id='vtCancel'>cancel</button>" +
      "</div>";
  }
  function wireVoiceNamer() {
    var input = el("vtName"); if (!input) return;
    var cluster = state.namingVoice;
    input.focus();
    input.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); nameVoice(cluster, input.value.trim()); }
      else if (e.key === "Escape") { state.namingVoice = null; renderVoicesStrip(); }
    };
    el("vtSave").onclick = function () { nameVoice(cluster, input.value.trim()); };
    el("vtCancel").onclick = function () { state.namingVoice = null; renderVoicesStrip(); };
  }

  // ---------- transcript ----------
  function clearSession() {
    var n = TLOG.byDate(TLOG.today()).length;
    if (n && !window.confirm("Clear " + n + " transcript line(s) for today, and all answer cards? " +
                             "Named voices are kept.")) return;
    TLOG.clearDate(TLOG.today());
    QA.reset();
    SUMMARY.reset();
    state.selectedCardId = null;
    // Drop this run's anonymous voice clusters; named profiles survive (server-side and here).
    var sc = SCFG();
    if (sc.enabled && sc.url) {
      fetch(sc.url + "/reset?session=" + encodeURIComponent(sessionId()), { method: "POST" })
        .catch(function () {});
    }
    Object.keys(state.voices).forEach(function (k) {
      if (!state.voices[k].persistent) delete state.voices[k];
      else state.voices[k].n = 0;
    });
    notify("Session cleared" + (n ? " (" + n + " lines removed)" : ""));
    renderTranscript(); refreshViews();
  }
  function exportTranscript() {
    var date = TLOG.today();
    var text = TLOG.exportText(date);
    if (!text) { notify("Nothing to export yet."); return; }
    var notes = SUMMARY.notes().trim();
    var S = SUMMARY.get();
    var head = "Tech Interview Copilot transcript - " + date + "\n" +
               "Exported " + new Date().toLocaleString() + "\n" +
               "------------------------------------------------------------" +
               (S.narrative ? "\n\nSESSION SUMMARY\n" + S.narrative : "") +
               (notes ? "\n\nYOUR NOTES\n" + notes : "");
    var blob = new Blob([head + "\n\n" + text + "\n"], { type: "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "interview-transcript-" + date + ".txt";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    notify("Transcript exported.");
  }
  function renderTranscript() {
    var body = el("transcript-body"); if (!body) return;
    body.className = "body";
    var segs = TLOG.byDate(TLOG.today());
    var bar = "<div class='tl-bar'>" +
      "<span class='note' style='padding:0'>" + segs.length + " line" + (segs.length === 1 ? "" : "s") + " today</span>" +
      "<span class='tab-spacer'></span>" +
      "<button class='btn-mini' id='tl-export'>Export</button>" +
      "<button class='btn-mini' id='tl-clear'>Clear session</button>" +
      "</div>";
    if (!segs.length) {
      body.innerHTML = bar + "<div class='note'>Transcript is empty. Press Start; interviewer audio " +
        "(via BlackHole) and your mic appear here as they are transcribed.</div>";
      wireTranscriptBar();
      return;
    }
    var atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    var others = Object.keys(state.voices);
    body.innerHTML = bar + "<div class='tl-list'>" + segs.map(function (s) {
      var cluster = s.voice && s.voice.cluster;
      // Reassign control: only when there is another known voice to move the line to.
      var alt = others.filter(function (k) { return k !== cluster; });
      var pick = (s.role === "me" || !alt.length) ? "" :
        "<select class='tl-reassign' data-seg='" + s.id + "' title='Reassign this line to another voice'>" +
          "<option value=''>" + (cluster || "?") + "</option>" +
          alt.map(function (k) {
            return "<option value='" + k + "'>&rarr; " + esc(state.voices[k].name || k) + "</option>";
          }).join("") + "</select>";
      return "<div class='tl-row'><span class='tl-time'>" + new Date(s.ts).toLocaleTimeString() + "</span>" +
        "<span class='tl-name " + (s.role === "me" ? "me" : "interviewer") + "'>" + esc(speakerName(s)) + "</span>" +
        "<span class='tl-text'>" + esc(s.text) + "</span>" + pick + "</div>";
    }).join("") + "</div>";
    wireTranscriptBar();
    body.querySelectorAll(".tl-reassign").forEach(function (sel) {
      sel.onchange = function () { if (sel.value) reassignLine(sel.getAttribute("data-seg"), sel.value); };
    });
    if (atBottom) body.scrollTop = body.scrollHeight;
  }
  function wireTranscriptBar() {
    var e = el("tl-export"); if (e) e.onclick = exportTranscript;
    var c = el("tl-clear"); if (c) c.onclick = clearSession;
  }

  // ---------- live copilot tab ----------
  function chip(label, ok, warnText) {
    var cls = ok === null ? "" : (ok ? "ok" : "bad");
    return "<span class='status-chip " + cls + "' title='" + esc(warnText || "") + "'>" + esc(label) + "</span>";
  }
  function freshestAnswered() {
    var cards = QA.cards();
    for (var i = cards.length - 1; i >= 0; i--) if (cards[i].answer || cards[i].status === "offline") return cards[i];
    return null;
  }
  function renderLive() {
    var body = el("copilot"); if (!body) return;
    body.className = "body copilot";
    var tr = ASR.transcriber();
    var rag = state.ragHealth;
    var spot = freshestAnswered();
    var spotHtml;
    if (spot && spot.answer) {
      spotHtml = "<div class='spotlight'><div class='sp-q'>" + esc(spot.question.normalized) + "</div><ul>" +
        (spot.answer.talking_points || []).map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul></div>";
    } else if (spot) {
      spotHtml = "<div class='spotlight'><div class='sp-q'>" + esc(spot.question.normalized) + "</div>" +
        "<div class='none'>Offline mode: see the card on the Answers tab.</div></div>";
    } else {
      spotHtml = "<div class='spotlight'><div class='none'>The freshest answer's talking points show here.</div></div>";
    }
    // Which candidate documents are actually feeding the model right now.
    var kinds = {};
    state.docs.forEach(function (d) { kinds[d.kind] = (kinds[d.kind] || 0) + 1; });
    var docBits = [];
    if (kinds.resume) docBits.push("resume");
    if (kinds.job_description) docBits.push("JD");
    if (kinds.company_research) docBits.push("research");
    if (kinds.interview_details) docBits.push("interview");
    if (kinds.other) docBits.push(kinds.other + " other");
    var docsOk = state.docsLoaded && docBits.length > 0;
    // Which interview this session is framed for. A wrong or unloaded profile means every answer is
    // being written for the wrong company, so it has to be visible at a glance, not buried in a tab.
    var prof = window.PROFILE ? PROFILE.active() : null;
    var profName = prof && prof.company && prof.company.name ? prof.company.name : null;
    body.innerHTML =
      "<div class='live-top'>" +
        "<button id='liveToggle' class='live-toggle" + (state.live ? " on" : "") + "'>" + (state.live ? "Listening" : "Start listening") + "</button>" +
        "<button id='meToggle' class='live-toggle small'>My mic: " + (CONFIG.asr.captureSelf ? "on" : "off") + "</button>" +
        "<span class='status' id='costatus'></span>" +
      "</div>" +
      "<div>" +
        chip("Profile: " + (profName || "none"), !!profName,
             profName ? "Every answer is framed for this company and role. Edit it on the Prep tab."
                      : "No interview profile loaded. Pick one on the Prep tab so answers are framed for the company.") +
        chip("LLM: " + (state.llmOnline ? "online" : "offline"), state.llmOnline, "Question detection and answers use the LLM; offline falls back to heuristics.") +
        chip("ASR: " + tr.label + (tr.degraded ? " (degraded)" : ""), !tr.degraded, "Transcription tier actually serving chunks.") +
        chip("RAG: " + (rag ? (rag.chunks || 0) + " chunks" : "off"), !!rag, "Knowledge-base retrieval server.") +
        chip("Docs: " + (docsOk ? docBits.join(" + ") : "none"), docsOk,
             docsOk ? "Resume, JD and other docs are sent as YOUR documents with every answer. Company research and interview details are sent separately, as background about the employer."
                    : "Upload your resume and the job description on the Prep tab so answers align with the role.") +
        (SCFG().enabled ? chip("Voices: " + (state.voiceOnline ? Object.keys(state.voices).length + " heard" : "off"),
             !!state.voiceOnline, "Voice profiles separate multiple interviewers in the transcript.") : "") +
      "</div>" +
      "<div class='voices-strip' id='voicesStrip'></div>" +
      "<div class='manual'>" +
        "<input type='text' id='manualQ' class='manual-in' placeholder='Type a question the app missed, then press Enter'>" +
        "<button class='btn-mini' id='manualGo'>Ask</button>" +
      "</div>" +
      "<div class='interim' id='interim'>" + esc(state.interim) + "</div>" +
      spotHtml +
      "<div class='notifier'>" + (function () {
        var list = notifier ? notifier.list() : [];
        return list.length ? list.map(function (n) {
          return "<div class='notif'><span class='nt'>" + n.t + "</span>" + esc(n.msg) + "</div>";
        }).join("") : "<div class='notif'>Activity shows here.</div>";
      })() + "</div>";
    el("liveToggle").onclick = toggleLive;
    el("meToggle").onclick = function () {
      var on = !CONFIG.asr.captureSelf;
      SETTINGS.save({ asr: { captureSelf: on } });
      ASR.enableSelf(on);
      renderLive();
    };
    var mi = el("manualQ");
    function submitManual() {
      var t = (mi.value || "").trim();
      if (!t) return;
      mi.value = "";
      manualEntry(t);
    }
    mi.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submitManual(); } };
    el("manualGo").onclick = submitManual;
    renderVoicesStrip();
  }
  // A typed question or statement, handled exactly like heard interviewer speech: it lands in the
  // transcript (marked as typed) and goes through the same detection and answer pipeline. This is
  // the fallback when the audio was missed, garbled, or the question arrived over chat.
  function manualEntry(text) {
    var seg = TLOG.add("interviewer", text, { name: "Typed", manual: true });
    renderTranscript();
    QA.onRemoteSegment(text, Date.now());
    notify("Manual entry submitted.");
    return seg;
  }

  // ---------- config tab ----------
  var BLACKHOLE_MD = [
    "### Route the meeting audio into the app (macOS)",
    "",
    "The app hears the interviewers through **BlackHole**, a free virtual audio device. A",
    "**Multi-Output Device** duplicates the meeting audio to BOTH your headphones and BlackHole,",
    "so you still hear everything normally.",
    "",
    "1. Install the driver: `brew install blackhole-2ch` (then restart the browser).",
    "2. Open **Audio MIDI Setup** (Applications > Utilities).",
    "3. Click **+** (bottom left) > **Create Multi-Output Device**.",
    "4. Check **your headphones/speakers** AND **BlackHole 2ch**. Set your headphones as the",
    "   **primary** device and enable **Drift Correction** on BlackHole.",
    "5. In **Google Meet / Teams / Zoom**, set the **Speaker** to the Multi-Output Device.",
    "   (Or set the whole system output to it from System Settings > Sound.)",
    "6. Back here, pick **BlackHole 2ch** as the Interviewer audio below. Play any video or ask",
    "   someone to speak in the meeting: the BlackHole level meter should move.",
    "",
    "Windows is a future case (VB-Cable is the equivalent); this build targets macOS."
  ].join("\n");

  function meterHtml(id) {
    var bars = ""; for (var i = 0; i < 10; i++) bars += "<i></i>";
    return "<span class='meter' id='" + id + "'>" + bars + "</span>";
  }
  function driveMeter(id, rms) {
    var m = el(id); if (!m) return;
    var level = Math.min(10, Math.round(Math.sqrt(Math.min(1, rms * 12)) * 10));
    var bars = m.children;
    for (var i = 0; i < bars.length; i++) {
      bars[i].className = i < level ? (i >= 8 ? "hot" : "on") : "";
    }
  }
  function stopConfigMeters() {
    state.meterStops.forEach(function (s) { try { s(); } catch (e) {} });
    state.meterStops = [];
  }
  function startConfigMeters() {
    stopConfigMeters();
    [{ label: CONFIG.asr.inputDeviceLabel, meter: "meter-remote" },
     { label: CONFIG.asr.selfDeviceLabel, meter: "meter-self" }].forEach(function (d) {
      if (!d.label) return;
      ASR.meter(d.label, function (r) { driveMeter(d.meter, r); }).then(function (stop) {
        state.meterStops.push(stop);
      });
    });
  }
  function keyPresent(k) { return !!(k && String(k).indexOf("%") !== 0); }
  function renderConfig() {
    var body = el("copilot"); if (!body) return;
    body.className = "body config";
    body.innerHTML = "<div class='note'>Loading audio devices (grant microphone permission if asked)&hellip;</div>";
    ASR.listDevices().then(function (labels) {
      if (state.copilotView !== "config") return;
      var hasBH = labels.some(function (l) { return /blackhole/i.test(l); });
      function options(sel) {
        return "<option value=''>(none)</option>" + labels.map(function (l) {
          var s = sel && l.toLowerCase().indexOf(String(sel).toLowerCase()) !== -1 ? " selected" : "";
          return "<option value='" + esc(l) + "'" + s + ">" + esc(l) + "</option>";
        }).join("");
      }
      var langs = (CONFIG.answers.languages || []).map(function (l) {
        return "<option value='" + l + "'" + (l === CONFIG.answers.defaultLanguage ? " selected" : "") + ">" + l + "</option>";
      }).join("");
      body.innerHTML =
        "<div class='cfg-h'>Audio devices</div>" +
        (hasBH ? "" : "<div class='banner'>No BlackHole device found. Follow the setup guide below, then Refresh.</div>") +
        "<div class='cfg-row'><label>Interviewer audio</label><select id='cfg-remote'>" + options(CONFIG.asr.inputDeviceLabel) + "</select> " + meterHtml("meter-remote") + "</div>" +
        "<div class='cfg-row'><label>My microphone</label><select id='cfg-self'>" + options(CONFIG.asr.selfDeviceLabel) + "</select> " + meterHtml("meter-self") + "</div>" +
        "<div class='cfg-row'><button class='btn-mini' id='cfg-refresh'>Refresh devices</button>" +
        "<span class='note'>Meters move when the selected device hears sound - use them to verify routing.</span></div>" +
        "<details class='setup'><summary>BlackHole setup guide (macOS)</summary><div class='md'>" + MD.render(BLACKHOLE_MD) + "</div></details>" +
        "<div class='cfg-h'>Status</div>" +
        "<div>" +
          chip("Ollama bridge: " + (state.llmOnline ? "reachable" : "down"), state.llmOnline) +
          chip("Together key " + (keyPresent(CONFIG.asr.together.apiKey) ? "present" : "missing"), keyPresent(CONFIG.asr.together.apiKey)) +
          chip("OpenAI key " + (keyPresent(CONFIG.llm.openai.apiKey) ? "present" : "missing"), keyPresent(CONFIG.llm.openai.apiKey)) +
          chip("Groq key " + (keyPresent(CONFIG.llm.groq.apiKey) ? "present" : "missing"), keyPresent(CONFIG.llm.groq.apiKey)) +
          chip("RAG " + (state.ragHealth ? "online" : "down"), !!state.ragHealth) +
        "</div>" +
        "<div class='note'>API keys live in the git-ignored <code>.env</code> file, never in the browser. Edit <code>.env</code> and relaunch to change them.</div>" +
        "<div class='cfg-h'>Models</div>" +
        "<div class='cfg-row'><label>Answer model</label><input type='text' id='cfg-model' value='" + esc(CONFIG.llm.ollama.model) + "'></div>" +
        "<div class='cfg-row'><label>Detection model</label><input type='text' id='cfg-dmodel' value='" + esc(CONFIG.llm.detectModel || CONFIG.llm.ollama.model) + "'></div>" +
        "<div class='cfg-row'><label>Timeout (ms)</label><input type='number' id='cfg-timeout' value='" + (CONFIG.llm.timeoutMs || 20000) + "' step='1000' min='5000'></div>" +
        "<div class='cfg-h'>Answers</div>" +
        "<div class='cfg-row'><label>Default code language</label><select id='cfg-lang'>" + langs + "</select></div>" +
        "<div class='cfg-row'><label>Talking points (max)</label><input type='number' id='cfg-verb' value='" + (CONFIG.answers.verbosity || 5) + "' min='3' max='8'></div>" +
        "<div class='cfg-row'><label>Use knowledge base</label><input type='checkbox' id='cfg-rag'" + (CONFIG.answers.rag.enabled ? " checked" : "") + "> <label style='min-width:auto'>top-k</label><input type='number' id='cfg-topk' value='" + (CONFIG.answers.rag.topK || 6) + "' min='1' max='12' style='width:70px'></div>" +
        "<details class='adv'><summary>Advanced: transcription</summary>" +
          "<div class='cfg-row'><label>Engine</label><select id='cfg-engine'>" +
            ["whisper", "webspeech"].map(function (e) { return "<option value='" + e + "'" + (CONFIG.asr.engine === e ? " selected" : "") + ">" + e + "</option>"; }).join("") + "</select></div>" +
          "<div class='cfg-row'><label>Hosted transcriber</label><select id='cfg-transcriber'>" +
            ["auto", "whisper"].map(function (t) { return "<option value='" + t + "'" + (CONFIG.asr.transcriber === t ? " selected" : "") + ">" + (t === "auto" ? "auto (Together when keyed)" : "force local whisper") + "</option>"; }).join("") + "</select></div>" +
          "<div class='cfg-row'><label>Together model</label><input type='text' id='cfg-tgmodel' value='" + esc(CONFIG.asr.together.model) + "'></div>" +
        "</details>";
      // wiring: every change persists through SETTINGS.save
      el("cfg-remote").onchange = function () { SETTINGS.save({ asr: { inputDeviceLabel: this.value } }); startConfigMeters(); };
      el("cfg-self").onchange = function () { SETTINGS.save({ asr: { selfDeviceLabel: this.value } }); startConfigMeters(); };
      el("cfg-refresh").onclick = function () { stopConfigMeters(); ASR.listDevices(true).then(function () { renderConfig(); }); };
      el("cfg-model").onchange = function () { SETTINGS.save({ llm: { ollama: { model: this.value } } }); };
      el("cfg-dmodel").onchange = function () { SETTINGS.save({ llm: { detectModel: this.value } }); };
      el("cfg-timeout").onchange = function () { SETTINGS.save({ llm: { timeoutMs: parseInt(this.value, 10) || 20000 } }); };
      el("cfg-lang").onchange = function () { SETTINGS.save({ answers: { defaultLanguage: this.value } }); };
      el("cfg-verb").onchange = function () { SETTINGS.save({ answers: { verbosity: parseInt(this.value, 10) || 5 } }); };
      el("cfg-rag").onchange = function () { SETTINGS.save({ answers: { rag: { enabled: this.checked } } }); };
      el("cfg-topk").onchange = function () { SETTINGS.save({ answers: { rag: { topK: parseInt(this.value, 10) || 6 } } }); };
      el("cfg-engine").onchange = function () { SETTINGS.save({ asr: { engine: this.value } }); };
      el("cfg-transcriber").onchange = function () { SETTINGS.save({ asr: { transcriber: this.value } }); };
      el("cfg-tgmodel").onchange = function () { SETTINGS.save({ asr: { together: { model: this.value } } }); };
      startConfigMeters();
    }).catch(function (e) {
      body.innerHTML = "<div class='banner'>Could not access audio devices: " + esc(e.message || String(e)) +
        ". Grant microphone permission in the browser and reload.</div>";
    });
  }

  function renderCopilot() {
    document.querySelectorAll("#copilot-tabbar button[data-cop]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-cop") === state.copilotView);
    });
    if (state.copilotView !== "config") stopConfigMeters();
    if (state.copilotView === "config") renderConfig();
    else renderLive();
  }

  // ---------- live capture ----------
  function onFinalSegment(text, role, startTs, voice) {
    var seg = TLOG.add(role === "self" ? "me" : "interviewer", text);
    if (role !== "self") attachVoice(seg, voice);   // labels the line when the voice is known
    renderTranscript();
    if (role === "remote") QA.onRemoteSegment(text, startTs || Date.now());
    return seg;
  }
  function toggleLive() { setLive(!state.live); }
  function setLive(on) {
    if (on === state.live) return;
    state.live = on;
    if (on) {
      probeVoice();
      ASR.start({
        onFinal: onFinalSegment,
        onInterim: function (t) { state.interim = t; var i = el("interim"); if (i) i.textContent = t; },
        onError: function (m) { notify(m); dbg("asr error:", m); },
        onStatus: function (s) { if (s) notify("ASR " + s); var c = el("costatus"); if (c) c.textContent = s || ""; if (state.copilotView === "live") renderLive(); }
      });
      ASR.enableSelf(!!CONFIG.asr.captureSelf);
    } else {
      ASR.stop();
      state.interim = "";
    }
    var b = el("startStop");
    if (b) { b.textContent = on ? "Stop" : "Start"; b.classList.toggle("on", on); }
    if (state.copilotView === "live") renderLive();
  }

  // ---------- view switching ----------
  var LEFT_RENDERERS = { answers: renderAnswers, code: renderCode, brief: renderBrief, cheats: renderCheats, prep: renderPrep };
  function ensureLeftView(view) {
    state.currentLeft = view;
    document.querySelectorAll("#left-tabs button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === view);
    });
    (LEFT_RENDERERS[view] || renderAnswers)();
  }
  function refreshViews() {
    if (state.currentLeft === "answers") renderAnswers();
    else if (state.currentLeft === "code") renderCode();
    if (state.copilotView === "live") renderLive();
  }

  // ---------- plugin API (console + future integrations; ASR/QA never touch the DOM) ----------
  window.InterviewCopilot = {
    setLive: function (on) { setLive(!!on); },
    ingest: onFinalSegment,                       // (text, role, startTs, voiceVerdict)
    ask: manualEntry,                             // type a question the audio missed
    openTab: ensureLeftView,
    cards: function () { return QA.cards(); },
    voices: function () { return JSON.parse(JSON.stringify(state.voices)); },
    nameVoice: nameVoice,                         // (cluster, name) -> relabels past lines too
    clearSession: clearSession,
    summarize: function () { return SUMMARY.runNow(); },
    brief: function () { return SUMMARY.get(); },
    refreshCard: function (id, reason) { var c = QA.byId(id); return c ? QA.refreshCard(c, reason || "manual") : null; },
    profile: function () { return window.PROFILE ? PROFILE.active() : null; },
    setProfile: function (id) { return window.PROFILE ? PROFILE.setActive(id).then(function (p) { renderCopilot(); return p; }) : null; },
    profileBlock: function (mode) { return window.PROFILE ? PROFILE.block(mode || "answer") : ""; },
    exportTranscript: exportTranscript,
    getState: function () {
      return { live: state.live, llmOnline: state.llmOnline, voiceOnline: state.voiceOnline,
               docsLoaded: state.docsLoaded, cards: QA.cards().length };
    }
  };

  // ---------- boot ----------
  function pingLLM() {
    if (!window.LLM) { state.llmOnline = false; return; }
    LLM.available().then(function (ok) {
      var was = state.llmOnline;
      state.llmOnline = ok;
      if (was !== ok && state.copilotView === "live") renderLive();
    });
  }
  function pingRAG() {
    RAG.health().then(function (h) {
      var was = !!state.ragHealth;
      state.ragHealth = h;
      // The rag-server often finishes booting after the page loads. Whenever it is up, make sure
      // the candidate-document context is actually in hand, so answers stop being generic without
      // anyone noticing.
      if (h) {
        RAG.refreshContext().then(function (ctx) {
          var was2 = state.docsLoaded;
          state.docsLoaded = !!ctx;
          if (was2 !== state.docsLoaded) {
            if (state.docsLoaded) notify("Your documents are loaded and will shape every answer.");
            refreshDocs();
          }
          if (state.copilotView === "live") renderLive();
        });
      }
      if (was !== !!h && state.copilotView === "live") renderLive();
    });
  }
  function loadTranscriptsFromDisk() {
    var c = CONFIG.logServer || {};
    if (!c.enabled || !c.url || !window.TLOG) return;
    var base = c.url.replace(/\/log$/, "");
    fetch(base + "/log?date=" + TLOG.today())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.segments && j.segments.length) { TLOG.hydrate(j.segments); renderTranscript(); } })
      .catch(function () {});
  }
  function init() {
    document.querySelectorAll("#left-tabs button").forEach(function (b) {
      b.onclick = function () { ensureLeftView(b.getAttribute("data-view")); };
    });
    document.querySelectorAll("#copilot-tabbar button[data-cop]").forEach(function (b) {
      b.onclick = function () {
        state.copilotView = b.getAttribute("data-cop");
        var p = el("copilot-panel");
        if (p && p.classList.contains("collapsed")) { var cb = el("copilot-collapse"); if (cb) cb.click(); }
        renderCopilot();
      };
    });
    el("startStop").onclick = toggleLive;
    QA.init({
      onCard: function (card) {
        notify("Question detected: " + card.question.normalized.slice(0, 80));
        refreshViews();
      },
      onUpdate: function (card) {
        if (card.status === "done" && card.code === null && (card.question.needsCode || (card.answer && card.answer.wants_code)))
          state.selectedCardId = state.selectedCardId || card.id;
        refreshViews();
      }
    });
    SUMMARY.init({
      onUpdate: function () {
        if (state.currentLeft === "brief") renderBrief();
        // New requirements can land without any card being flagged stale ("we're a Go shop, by the
        // way"). Bring generated code up to date on its own.
        var n = QA.refreshStaleCode();
        if (n) notify("Requirements changed: updating code on " + n + " card" + (n === 1 ? "" : "s") + ".");
        if (state.currentLeft === "code") renderCode();
      },
      onStaleCards: function (stale) {
        var n = QA.refreshStale(stale);
        if (n) notify("Session context changed: rebuilding " + n + " answer" + (n === 1 ? "" : "s") + ".");
      },
      onNotes: function () {
        if (state.currentLeft === "code") renderCode();
      }
    });
    if (window.TLOG) { TLOG.load(); loadTranscriptsFromDisk(); }
    ensureLeftView("answers");
    renderCopilot();
    renderTranscript();
    pingLLM(); pingRAG(); refreshDocs(); probeVoice();
    setInterval(pingLLM, 20000);
    setInterval(pingRAG, 30000);
    // The summarizer only spends a pass when the transcript actually grew (see SUMMARY.maybeRun).
    setInterval(function () {
      if (state.llmOnline) SUMMARY.maybeRun();
    }, Math.max(10000, (CONFIG.summarize || {}).everyMs || 25000));
  }
  // Settings must be merged over CONFIG before anything renders or captures, and the interview
  // profile must be in hand before the first card can be composed - otherwise an early question
  // gets answered with no company framing and has to be rebuilt.
  function boot() {
    Promise.all([
      window.SETTINGS ? SETTINGS.ready : Promise.resolve(),
      window.PROFILE ? PROFILE.ready : Promise.resolve()
    ]).then(init, init);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
