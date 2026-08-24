// Code panel: renders a card's code in the chosen language with syntax highlighting, language
// pills with per-language caching (switching to a cached language is instant; a miss translates
// the canonical solution), a Regenerate button, and the select-to-explain popup.
// app.js calls CODEPANEL.render(container, card) whenever the Code tab shows; QA owns the
// generation/translation calls and re-renders arrive through the normal card-update path.
(function (global) {
  function ACFG() { return (global.CONFIG && global.CONFIG.answers) || {}; }
  function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  var LANG_LABEL = { python: "Python", javascript: "JavaScript", typescript: "TypeScript",
    java: "Java", go: "Go", cpp: "C++", sql: "SQL" };

  // The language the user last picked (per session; sticky across cards). Falls back to config.
  var activeLang = null;
  try { activeLang = localStorage.getItem("tic_codelang") || null; } catch (e) {}
  function currentLang(card) {
    var langs = ACFG().languages || ["python"];
    if (activeLang && langs.indexOf(activeLang) !== -1) return activeLang;
    if (card && card.code && card.code.canonicalLang) return card.code.canonicalLang;
    return ACFG().defaultLanguage || langs[0];
  }
  function setLang(lang) { activeLang = lang; try { localStorage.setItem("tic_codelang", lang); } catch (e) {} }

  // ---- select-to-explain ----
  var popEls = { btn: null, pop: null };
  var popCtx = null;   // { card, lang, selected, fullCode }
  function killPopups(keepPop) {
    if (popEls.btn) { popEls.btn.remove(); popEls.btn = null; }
    if (!keepPop && popEls.pop) { popEls.pop.remove(); popEls.pop = null; popCtx = null; }
  }
  function placeAt(elm, rect) {
    elm.style.left = Math.max(6, rect.left + window.scrollX) + "px";
    elm.style.top = (rect.bottom + window.scrollY + 6) + "px";
  }
  function onSelection(card, lang, block) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { killPopups(); return; }
    var range = sel.getRangeAt(0);
    if (!block.contains(range.commonAncestorContainer)) { killPopups(); return; }
    var text = sel.toString();
    if (text.trim().length < 4) { killPopups(); return; }
    killPopups();
    var entry = card.code && card.code.byLang[lang];
    if (!entry) return;
    var btn = document.createElement("button");
    btn.className = "explain-btn";
    btn.textContent = "Explain this code";
    placeAt(btn, range.getBoundingClientRect());
    btn.onmousedown = function (e) { e.preventDefault(); e.stopPropagation(); };   // keep the selection
    btn.onclick = function (e) {
      e.stopPropagation();
      showExplain(card, lang, text, entry.code, range.getBoundingClientRect());
    };
    document.body.appendChild(btn);
    popEls.btn = btn;
  }
  function showExplain(card, lang, selected, fullCode, rect) {
    killPopups();
    var pop = document.createElement("div");
    pop.className = "explain-pop";
    pop.innerHTML = "<div class='xp-h'><span class='xp-title'>Explain</span>" +
      "<button class='xp-close' title='Close'>&times;</button></div>" +
      "<div class='xp-body working'>Asking the model&hellip;</div>";
    placeAt(pop, rect);
    document.body.appendChild(pop);
    popEls.pop = pop;
    popCtx = { card: card };
    pop.querySelector(".xp-close").onclick = function () { killPopups(); };
    pop.onmousedown = function (e) { e.stopPropagation(); };
    var body = pop.querySelector(".xp-body");
    // Cache per card: identical selections don't re-ask the model.
    card.explains = card.explains || {};
    var key = lang + "|" + selected;
    function renderResult(r) {
      if (!popEls.pop) return;   // dismissed while waiting
      if (!r) { body.className = "xp-body err"; body.textContent = "The model did not answer. Try again."; return; }
      body.className = "xp-body";
      body.innerHTML = (r.explanation ? "<div>" + esc(r.explanation) + "</div>" : "") +
        (r.points && r.points.length ? "<ul>" + r.points.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" : "");
    }
    if (card.explains[key]) { renderResult(card.explains[key]); return; }
    LLM.explainCode(selected, fullCode, card.question, lang).then(function (r) {
      if (r) card.explains[key] = r;
      renderResult(r);
    });
  }
  // Global dismissal: click-away, Escape.
  document.addEventListener("mousedown", function () { killPopups(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") killPopups(); });

  // ---- rendering ----
  function render(container, card) {
    killPopups();
    if (!card) {
      container.innerHTML = "<div class='code-note'>No coding question yet. When a question that calls for " +
        "code is detected, its solution appears here. You can also open it from an Answer card.</div>";
      return;
    }
    var langs = ACFG().languages || ["python"];
    var lang = currentLang(card);
    var code = card.code || { byLang: {}, busy: {} };
    var entry = code.byLang[lang];
    var busy = code.busy && code.busy[lang];

    var pills = langs.map(function (l) {
      var cls = "pill" + (l === lang ? " on" : "") + (code.busy && code.busy[l] ? " busy" : "");
      return "<button class='" + cls + "' data-lang='" + l + "'>" + (LANG_LABEL[l] || l) + "</button>";
    }).join("");

    // What the code must satisfy right now, and whether what is on screen predates it.
    var reqs = global.SUMMARY ? SUMMARY.requirementsList() : [];
    var stale = global.QA && QA.codeStale ? QA.codeStale(card, lang) : false;
    var reqHtml = reqs.length
      ? "<details class='reqs'" + (stale ? " open" : "") + "><summary>Requirements in effect (" + reqs.length + ")</summary><ul>" +
          reqs.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></details>"
      : "";
    var staleHtml = (stale && !busy)
      ? "<div class='code-stale'><b>Requirements changed since this code was written.</b> " +
        "It may not satisfy what the interview has established since. " +
        "<button class='btn-mini' id='code-update'>Update code</button></div>"
      : "";

    var body;
    if (entry) {
      body = "<div class='code-block'><button class='btn-mini code-copy' id='code-copy'>Copy</button>" +
        "<pre><code>" + HL.highlight(entry.code, lang) + "</code></pre></div>" +
        (entry.walkthrough && entry.walkthrough.length ?
          "<div class='code-walk'><div class='wk-h'>Say while pointing at the code</div><ul>" +
          entry.walkthrough.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul></div>" : "") +
        (entry.complexity ? "<div class='code-cx'>Complexity: <b>" + esc(entry.complexity.time || "?") +
          "</b> time, <b>" + esc(entry.complexity.space || "?") + "</b> space</div>" : "") +
        (entry.requirements && entry.requirements.length
          ? "<div class='code-applied'><b>Applied:</b> " + entry.requirements.map(esc).join(" · ") + "</div>" : "") +
        "<div class='note'>Select any part of the code with the mouse for an “Explain this code” popup.</div>";
    } else if (busy) {
      body = "<div class='code-note'>Generating " + (LANG_LABEL[lang] || lang) + "&hellip;</div>";
    } else {
      body = "<div class='code-note'>Not generated yet for " + (LANG_LABEL[lang] || lang) +
        ". Click the pill again or Regenerate.</div>";
    }

    container.innerHTML =
      "<div class='codepanel'>" +
        "<div class='code-qhead'>" + esc(card.question.normalized) + "</div>" +
        "<div class='code-pills'>" + pills +
          "<span class='tab-spacer'></span>" +
          "<button class='btn-mini' id='code-regen'>Regenerate</button>" +
        "</div>" +
        reqHtml + staleHtml +
        "<div id='code-body'>" + body + "</div>" +
      "</div>";

    container.querySelectorAll(".code-pills .pill").forEach(function (b) {
      b.onclick = function () {
        var l = b.getAttribute("data-lang");
        setLang(l);
        QA.requestLanguage(card, l);   // no-op on cache hit; the update callback re-renders either way
        render(container, card);
      };
    });
    var rg = container.querySelector("#code-regen");
    if (rg) rg.onclick = function () { QA.regenerate(card, lang); };
    var up = container.querySelector("#code-update");
    if (up) up.onclick = function () { QA.updateCode(card, lang); };
    var cp = container.querySelector("#code-copy");
    if (cp && entry) cp.onclick = function () {
      if (navigator.clipboard) navigator.clipboard.writeText(entry.code).then(function () {
        cp.textContent = "Copied"; setTimeout(function () { cp.textContent = "Copy"; }, 1000);
      });
    };
    var block = container.querySelector(".code-block");
    if (block && entry) {
      block.addEventListener("mouseup", function (e) {
        e.stopPropagation();
        setTimeout(function () { onSelection(card, lang, block); }, 0);
      });
      block.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    }
  }

  global.CODEPANEL = { render: render, currentLang: currentLang };
})(window);
