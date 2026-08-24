// Browser client for the local rag-server (retrieval + candidate-doc uploads). Every call fails
// soft: retrieval returns [] and the app composes answers without reference notes; doc context
// returns "" and answers are simply un-personalized. The server is optional by design.
(function (global) {
  function cfg() { return ((global.CONFIG || {}).answers || {}).rag || {}; }
  function base() { return (cfg().url || "http://localhost:8892").replace(/\/$/, ""); }
  function timeoutMs() { return cfg().timeoutMs || 2500; }

  function withTimeout(ms) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, ms);
    return { signal: ctrl.signal, done: function () { clearTimeout(t); } };
  }

  // Candidate-doc text, fetched at boot and after uploads. Stays null after a FAILED fetch (as
  // opposed to "" for a successful fetch with nothing uploaded), so a rag-server that starts
  // after the page does is picked up on the next answer instead of the app believing forever
  // that there are no documents.
  var cachedContext = null;
  var cachedCompany = "";   // company_research + interview_details, kept OUT of candidate context

  // The server returns every uploaded document in one blob, section-delimited as
  // "=== <name> (<kind>) ===". Research about the EMPLOYER must not travel to the model inside a
  // block labeled "the candidate's own uploaded documents" - that is how a model ends up telling
  // the candidate to cite the company's funding round as something from their resume. Split the
  // blob by kind here so each half reaches the prompt under an honest label.
  var COMPANY_KINDS = { company_research: 1, interview_details: 1 };
  // The kind is anchored to the known set rather than captured as ".+?", and the name is greedy up
  // to the LAST parenthesis. With two lazy groups, a filename containing parentheses -
  // "Acme (research).md (company_research)" - backtracks so the kind capture swallows
  // "research).md (company_research", falls out of COMPANY_KINDS, and the employer dossier is routed
  // into the candidate's own documents. That is the one mislabel this whole split exists to prevent.
  var KIND_RE = /^=== (.+) \((resume|job_description|interview_details|company_research|other)\) ===$/gm;
  function splitContext(raw) {
    if (!raw) return { candidate: "", company: "" };
    var re = new RegExp(KIND_RE.source, "gm"), m, marks = [];
    while ((m = re.exec(raw)) !== null) marks.push({ start: m.index, kind: m[2] });
    if (!marks.length) return { candidate: raw, company: "" };   // unrecognized shape: treat as before
    var cand = [], comp = [];
    marks.forEach(function (mk, i) {
      var end = (i + 1 < marks.length) ? marks[i + 1].start : raw.length;
      var section = raw.slice(mk.start, end).replace(/\s+$/, "");
      (COMPANY_KINDS[mk.kind] ? comp : cand).push(section);
    });
    return { candidate: cand.join("\n\n"), company: comp.join("\n\n") };
  }

  // Retrieve top-k knowledge-base chunks for a question. Resolves [] on any failure.
  function query(q, topics, k) {
    if (!cfg().enabled) return Promise.resolve([]);
    var to = withTimeout(timeoutMs());
    return fetch(base() + "/query", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: to.signal,
      body: JSON.stringify({ q: q, topics: topics || [], k: k || cfg().topK || 6 })
    }).then(function (r) { to.done(); return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.chunks) || []; })
      .catch(function () { to.done(); return []; });
  }

  // Concatenated resume/JD text for prompt stuffing. Cached; refresh() after uploads.
  function context() {
    if (cachedContext !== null) return Promise.resolve(cachedContext);
    return refreshContext();
  }
  function refreshContext() {
    var to = withTimeout(timeoutMs());
    return fetch(base() + "/docs/context", { signal: to.signal })
      .then(function (r) { to.done(); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var s = splitContext((j && j.context) || "");
        cachedContext = s.candidate;
        cachedCompany = s.company;
        // Hand the company half to the profile module, which folds it into the COMPANY & INTERVIEW
        // block that llm.js prepends to every prompt.
        try { if (global.PROFILE) PROFILE.setDossier(cachedCompany); } catch (e) {}
        return cachedContext;
      })
      .catch(function () { to.done(); return ""; });   // leave the cache null so the next call retries
  }
  function hasContext() { return !!cachedContext; }
  function companyContext() { return cachedCompany; }
  // Null the candidate cache so the next call refetches. cachedCompany is deliberately LEFT alone:
  // it is a derived mirror, and holding the last known company text until a fresh fetch lands beats
  // blanking the COMPANY block for the second or two in between.
  function invalidateContext() { cachedContext = null; }

  // Upload a candidate document. The file body goes raw; name/kind ride in the query string
  // (keeps the server free of multipart parsing).
  // kind = resume | job_description | interview_details | company_research | other.
  function uploadDoc(file, kind) {
    return fetch(base() + "/docs?name=" + encodeURIComponent(file.name) + "&kind=" + encodeURIComponent(kind || "other"),
      { method: "POST", body: file })
      .then(function (r) { return r.json(); })
      .then(function (j) { invalidateContext(); return j; });
  }
  function listDocs() {
    return fetch(base() + "/docs").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.docs) || []; }).catch(function () { return []; });
  }
  function deleteDoc(name) {
    return fetch(base() + "/docs?name=" + encodeURIComponent(name), { method: "DELETE" })
      .then(function (r) { return r.json(); })
      .then(function (j) { invalidateContext(); return j; });
  }
  function setDocKind(name, kind) {
    return fetch(base() + "/docs?name=" + encodeURIComponent(name) + "&kind=" + encodeURIComponent(kind),
      { method: "PATCH" })
      .then(function (r) { return r.json(); })
      .then(function (j) { invalidateContext(); return j; });
  }

  // Knowledge-base status for the Prep tab / status chips. Resolves null when the server is down.
  function health() {
    var to = withTimeout(2000);
    return fetch(base() + "/health", { signal: to.signal })
      .then(function (r) { to.done(); return r.ok ? r.json() : null; })
      .catch(function () { to.done(); return null; });
  }

  global.RAG = { query: query, context: context, refreshContext: refreshContext,
    hasContext: hasContext, companyContext: companyContext, invalidateContext: invalidateContext,
    uploadDoc: uploadDoc, listDocs: listDocs, deleteDoc: deleteDoc, setDocKind: setDocKind, health: health };
})(window);
