// Headless harness for app/profile.js and app/rag.js. Fakes `window`, SETTINGS and fetch, loads
// the real modules with `vm`, and exercises the paths that matter during a live interview: block
// rendering and its caps, per-section budgeting, settings overrides, the code-staleness
// fingerprint, and every fail-soft path.
//
// Run from the repo root:  node --test test/profile.test.js
//
// Written after a regression that length-only assertions could not catch: the answer block was
// inside its cap while silently dropping 11 of 12 curated company facts. Assert CONTENT, not size.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
function deepMerge(dst, src) {
  Object.keys(src || {}).forEach((k) => { if (isObj(src[k]) && isObj(dst[k])) deepMerge(dst[k], src[k]); else dst[k] = src[k]; });
  return dst;
}

function makeWindow(opts) {
  opts = opts || {};
  const stored = opts.stored || {};
  const win = {
    CONFIG: {
      profile: { activeId: opts.activeId === undefined ? "example" : opts.activeId, indexUrl: "profiles/index.json" },
      answers: { rag: { enabled: true, url: "http://x", topK: 6, timeoutMs: 2500 } }
    },
    SETTINGS: {
      ready: Promise.resolve(stored),
      stored: function () { return stored; },
      save: function (patch) { win.__saved.push(JSON.parse(JSON.stringify(patch))); deepMerge(stored, patch); deepMerge(win.CONFIG, patch); }
    },
    __saved: [],
    console: { warn: function () {}, log: function () {} },
    fetch: function (url) {
      const rel = String(url).split("?")[0];
      const p = path.join(ROOT, rel);
      if (opts.brokenJson && rel.indexOf("profile.json") !== -1) {
        return Promise.resolve({ ok: true, json: () => Promise.reject(new Error("bad json")) });
      }
      if (!fs.existsSync(p)) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      const body = fs.readFileSync(p, "utf8");
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(body)) });
    },
    setTimeout: setTimeout, clearTimeout: clearTimeout, AbortController: class { constructor() { this.signal = {}; } abort() {} }
  };
  return win;
}

// Absolute path as vm's `filename` -- with a relative path, c8/V8 coverage attributes every line
// executed here to nothing, silently reporting 0% for the loaded module.
function load(win, relFile) {
  const abs = path.join(ROOT, relFile);
  const code = fs.readFileSync(abs, "utf8");
  const ctx = vm.createContext(win);
  win.window = win;
  vm.runInContext(code, ctx, { filename: abs });
}

test("profile.js: happy path", async () => {
  const win = makeWindow({});
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const p = win.PROFILE.active();
  assert.ok(p, "profile loads");
  assert.equal(p.company.name, "Acme Robotics");
  assert.ok(win.PROFILE.list().some((x) => x.id === "example"), "list() has the example profile");

  const a = win.PROFILE.block("answer");
  assert.ok(a.length > 200, "answer block non-empty, len=" + a.length);
  assert.ok(a.length <= 16000, "answer block <= 16000 char hard cap, len=" + a.length);
  assert.match(a, /COMPANY: Acme Robotics \(acme-robotics\.example\)/);
  assert.match(a, /DO NOT SAY/);
  assert.match(a, /IF THEY PUSH BACK/);
  assert.match(a, /QUESTIONS TO ASK THEM/);

  const c = win.PROFILE.block("code");
  assert.ok(c.length <= 1000, "code block <= 1000, len=" + c.length);
  assert.doesNotMatch(c, /DO NOT SAY/);
  assert.doesNotMatch(c, /QUESTIONS TO ASK/);
  assert.match(c, /THEIR STACK/);

  const s = win.PROFILE.block("summary");
  assert.ok(s.length <= 400, "summary block <= 400, len=" + s.length);
  assert.equal(s.split("\n").length, 3);

  assert.equal(win.PROFILE.block("bogus"), a, "unknown mode falls back to answer");
  const sig1 = win.PROFILE.sig();
  assert.ok(sig1 && sig1 === win.PROFILE.sig(), "sig() is stable and non-empty");
});

test("profile.js: unconfirmed facts render as (unconfirmed)", async () => {
  const win = makeWindow({ stored: { profileOverrides: { example: { company: { facts: [
    { text: "confirmed thing", verified: true }, { text: "shaky thing", verified: false }] } } } } });
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const a = win.PROFILE.block("answer");
  assert.match(a, /- confirmed thing/);
  assert.match(a, /- \(unconfirmed\) shaky thing/);
});

test("profile.js: settings overrides win over the committed file", async () => {
  const win = makeWindow({ stored: { profileOverrides: { example: { company: { name: "OverriddenCo" } } } } });
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  assert.equal(win.PROFILE.active().company.name, "OverriddenCo");
  assert.equal(win.PROFILE.active().role.title, "Forward Deployed Engineer", "un-overridden field survives");
});

test("profile.js: sig() is narrow (list edits must NOT invalidate code)", async () => {
  const win = makeWindow({});
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const s0 = win.PROFILE.sig();
  win.PROFILE.set("questions_to_ask", ["a", "b"]);
  assert.equal(win.PROFILE.sig(), s0, "editing questions does NOT change sig");
  win.PROFILE.set("must_hit", ["x"]);
  assert.equal(win.PROFILE.sig(), s0, "editing must_hit does NOT change sig");
  win.PROFILE.set("company.tech_context", ["go", "postgres"]);
  assert.notEqual(win.PROFILE.sig(), s0, "editing the stack DOES change sig");
});

test("profile.js: set() persists as an override, reset() clears it", async () => {
  const win = makeWindow({});
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  win.PROFILE.set("company.one_liner", "hello");
  const saved = win.__saved.find((s) => s.profileOverrides);
  assert.ok(saved && saved.profileOverrides.example, "set() saved under profileOverrides.example");
  assert.equal(win.PROFILE.active().company.one_liner, "hello", "set() applied locally right away");
  assert.match(win.PROFILE.block("answer"), /COMPANY: Acme Robotics \(acme-robotics\.example\)\. hello/);
  await win.PROFILE.reset();
  const cleared = win.__saved[win.__saved.length - 1];
  assert.equal(cleared.profileOverrides.example, null, "reset() nulls the override");
  assert.ok(win.PROFILE.active().company.one_liner.indexOf("warehouse-automation") !== -1,
    "reset() restores the committed one_liner");
});

test("profile.js: FAIL-SOFT (the mid-call safety net)", async () => {
  {
    const win = makeWindow({ activeId: "does-not-exist" });
    load(win, "app/profile.js");
    await win.PROFILE.ready;
    assert.equal(win.PROFILE.active(), null, "missing profile -> active() null");
    assert.equal(win.PROFILE.block("answer"), "", "missing profile -> block() ''");
    assert.equal(win.PROFILE.sig(), "", "missing profile -> sig() ''");
  }
  {
    const win = makeWindow({ brokenJson: true });
    load(win, "app/profile.js");
    await win.PROFILE.ready;
    assert.equal(win.PROFILE.active(), null, "malformed JSON -> active() null");
    assert.equal(win.PROFILE.block("answer"), "", "malformed JSON -> block() ''");
  }
  {
    const win = makeWindow({ activeId: "" });
    load(win, "app/profile.js");
    await win.PROFILE.ready;
    assert.equal(win.PROFILE.active(), null);
    assert.equal(win.PROFILE.block("answer"), "", "activeId '' -> no profile, no throw");
  }
});

test("profile.js: dossier is folded in and capped", async () => {
  const win = makeWindow({});
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const before = win.PROFILE.block("answer").length;
  win.PROFILE.setDossier("=== acme-research.md (company_research) ===\n" + "X".repeat(9000));
  const after = win.PROFILE.block("answer");
  assert.notEqual(after.length, before, "dossier changes the block");
  assert.ok(after.length <= 16000, "dossier still respects the 16000 cap, len=" + after.length);
  assert.equal(win.PROFILE.block("answer"), after, "block is memoized between calls");
});

test("rag.js: splitContext keeps company research OUT of candidate context", async () => {
  const win = makeWindow({});
  win.PROFILE = { setDossier: function (t) { win.__dossier = t; } };
  load(win, "app/rag.js");
  const blob = [
    "=== Candidate_Resume_2026.pdf (resume) ===\nRESUME BODY",
    "=== acme-research.md (company_research) ===\nDOSSIER BODY",
    "=== logistics.md (interview_details) ===\nLOGISTICS BODY",
    "=== notes.md (other) ===\nOTHER BODY"
  ].join("\n\n");
  win.fetch = function () {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ context: blob }) });
  };
  const cand = await win.RAG.refreshContext();
  assert.match(cand, /RESUME BODY/, "resume stays in candidate context");
  assert.match(cand, /OTHER BODY/, "other stays in candidate context");
  assert.doesNotMatch(cand, /DOSSIER BODY/, "company research is NOT in candidate context");
  assert.doesNotMatch(cand, /LOGISTICS BODY/, "interview details are NOT in candidate context");
  const co = win.RAG.companyContext();
  assert.match(co, /DOSSIER BODY/, "company context has the dossier");
  assert.match(co, /LOGISTICS BODY/, "company context has the logistics");
  assert.doesNotMatch(co, /RESUME BODY/, "company context has NO resume");
  assert.match(win.__dossier || "", /DOSSIER BODY/, "PROFILE.setDossier was handed the company half");
});

test("rag.js: unrecognized shape passes through unchanged", async () => {
  const win = makeWindow({});
  win.PROFILE = { setDossier: function () {} };
  load(win, "app/rag.js");
  win.fetch = function () { return Promise.resolve({ ok: true, json: () => Promise.resolve({ context: "no delimiters here" }) }); };
  const cand = await win.RAG.refreshContext();
  assert.equal(cand, "no delimiters here", "unrecognized shape passes through unchanged");
});

test("rag.js: server down resolves '' (fail-soft)", async () => {
  const win = makeWindow({});
  win.PROFILE = { setDossier: function () {} };
  load(win, "app/rag.js");
  win.fetch = function () { return Promise.reject(new Error("server down")); };
  const cand = await win.RAG.refreshContext();
  assert.equal(cand, "", "server down -> resolves '' (fail-soft)");
});

test("profile.js: CONTENT survives a large uploaded dossier (the regression that shipped)", async () => {
  const win = makeWindow({});
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const prof = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles/example/profile.json"), "utf8"));
  // Synthesize a large dossier (the real regression involved an ~15k uploaded research doc
  // competing with the curated facts for the same character budget).
  const dossier = "ACME ROBOTICS RESEARCH DOSSIER\n" + Array.from({ length: 300 },
    (_, i) => "Paragraph " + i + ": " + "lorem ipsum filler text ".repeat(8)).join("\n");
  win.PROFILE.setDossier(dossier);
  const b = win.PROFILE.block("answer");
  const kept = prof.company.facts.filter((f) => b.indexOf(f.text.slice(0, 30)) !== -1).length;
  assert.equal(kept, prof.company.facts.length,
    "ALL company facts survive with a large dossier competing for budget: " +
    kept + "/" + prof.company.facts.length + " kept, block len " + b.length);
  assert.notEqual(b.indexOf("RESEARCH DOSSIER"), -1, "dossier still made it in");
  assert.match(b, /DO NOT SAY/);
  assert.match(b, /IF THEY PUSH BACK/);
  assert.match(b, /QUESTIONS TO ASK THEM/);
  assert.match(b, /=== END COMPANY & INTERVIEW ===$/, "block is terminated");
});

test("profile.js: block stays terminated even when the profile is over-stuffed", async () => {
  const win = makeWindow({ stored: { profileOverrides: { example: {
    must_hit: Array.from({ length: 60 }, (_, i) => "padding bullet " + i + " " + "y".repeat(300)) } } } });
  load(win, "app/profile.js");
  await win.PROFILE.ready;
  const b = win.PROFILE.block("answer");
  assert.ok(b.length <= 16000, "over-stuffed profile still <= cap, len=" + b.length);
  assert.match(b, /=== END COMPANY & INTERVIEW ===$/, "over-stuffed profile STILL terminated");
});

test("rag.js: parenthesised filenames must not leak the dossier", async () => {
  const win = makeWindow({});
  win.PROFILE = { setDossier: function (t) { win.__dossier = t; } };
  load(win, "app/rag.js");
  const blob = [
    "=== Acme (research).md (company_research) ===\nDOSSIER BODY WITH FUNDING",
    "=== Resume (2026).pdf (resume) ===\nRESUME BODY"
  ].join("\n\n");
  win.fetch = function () { return Promise.resolve({ ok: true, json: () => Promise.resolve({ context: blob }) }); };
  const cand = await win.RAG.refreshContext();
  assert.doesNotMatch(cand, /DOSSIER BODY/, "parenthesised research does NOT leak to candidate ctx");
  assert.match(cand, /RESUME BODY/, "parenthesised resume still lands in candidate ctx");
  assert.match(win.RAG.companyContext(), /DOSSIER BODY/, "parenthesised research reaches the company half");
});
