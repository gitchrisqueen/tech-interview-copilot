#!/usr/bin/env python3
"""Retrieval + candidate-document sidecar for Tech Interview Copilot. Localhost only.

Serves the knowledge base built by kb/ingest.py (kb/index/kb.sqlite) with brute-force cosine
similarity over an in-memory numpy matrix (a few tens of thousands of 768-dim vectors is a
<20 ms matmul - no vector database needed), and manages uploaded candidate documents
(resume / job description / other) under docs/uploads/.

Endpoints:
  GET  /health                 index stats (chunk counts per repo, model, build time)
  POST /query                  {"q": "...", "topics": [...], "k": 6} -> {"chunks":[...]}
  POST /docs?name=&kind=       raw file body -> extract text, register in manifest
  GET  /docs                   list uploaded docs
  PATCH  /docs?name=&kind=     change a doc's kind
  DELETE /docs?name=           remove a doc
  GET  /docs/context           concatenated resume+JD (+small others) text for prompt stuffing

Degrades gracefully: without numpy or without a built index, /query falls back to keyword
scoring over whatever chunks exist (or returns []), and doc handling still works (.pdf text
extraction additionally needs pypdf from kb/requirements.txt).

Usage: python3 rag-server.py <copilot-dir> <port>
"""
import json
import os
import re
import sys
import sqlite3
import datetime
import urllib.error
import urllib.request
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import numpy as np
except ImportError:
    np = None

BASE = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8892
KB_DB = os.path.join(BASE, "kb", "index", "kb.sqlite")
MANIFEST = os.path.join(BASE, "kb", "repos.json")
UPLOADS = os.path.join(BASE, "docs", "uploads")
DOC_MANIFEST = os.path.join(UPLOADS, "manifest.json")
DOC_DB = os.path.join(UPLOADS, "docindex.sqlite")   # embedded chunks of oversized "other" docs
CONTEXT_CAP = 32000                                  # chars of candidate context (~8k tokens)

# Document kinds, and the order they are stuffed into the prompt. The resume goes first because it
# is the one document that makes an answer THEIRS; if anything gets cut by CONTEXT_CAP it must not
# be that. "interview_details" (logistics, format, who is interviewing) is small and sorts ahead of
# "company_research" (a long dossier about the employer) so the cheap, high-signal facts always land.
KIND_ORDER = {"resume": 0, "job_description": 1, "interview_details": 2, "company_research": 3, "other": 4}
DOC_KINDS = tuple(KIND_ORDER.keys())
# Kinds whose oversized documents are dropped from prompt stuffing and chunk-indexed for retrieval
# instead. A big company dossier loses nothing this way: /query brings back the on-topic part per
# question. Keep a dossier under CONTEXT_CAP // 2 if you want it stuffed into EVERY answer.
OVERSIZE_ROUTED = ("other", "company_research")
os.makedirs(UPLOADS, exist_ok=True)


def load_kb_config():
    try:
        with open(MANIFEST, encoding="utf-8") as f:
            m = json.load(f)
        emb = m.get("embedding", {})
        return {"model": emb.get("model", "nomic-embed-text"),
                "ollama_url": os.environ.get("TIC_OLLAMA_URL", emb.get("ollama_url", "http://localhost:11501")),
                "chunk": m.get("chunk", {"max_chars": 1800, "overlap": 200})}
    except Exception:
        return {"model": "nomic-embed-text", "ollama_url": "http://localhost:11501",
                "chunk": {"max_chars": 1800, "overlap": 200}}


KBCFG = load_kb_config()


USE_LEGACY_EMBED = False   # flips on when this Ollama build 404s /api/embed (pre-v0.3.0)


def _endpoint_missing(body):
    """A missing MODEL 404s with a JSON {"error": ...} body; a missing ENDPOINT (old Ollama)
    404s with Go's plain-text "404 page not found". Both contain "not found", so JSON-ness is
    the reliable discriminator."""
    try:
        return "error" not in json.loads(body)
    except Exception:
        return True


def _embed_post(path, payload):
    req = urllib.request.Request(
        KBCFG["ollama_url"].rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def _embed_legacy(texts):
    vecs = []
    for t in texts:
        out = _embed_post("/api/embeddings", {"model": KBCFG["model"], "prompt": t})
        v = out.get("embedding")
        if not v:
            return None
        vecs.append(v)
    return vecs


def embed(texts):
    """Embed texts via the local Ollama server. Returns list of vectors, or None on any failure.
    Old Ollama builds (pre-v0.3.0) have no /api/embed; a 404 on the endpoint itself switches
    this process over to the legacy per-prompt /api/embeddings."""
    global USE_LEGACY_EMBED
    if USE_LEGACY_EMBED:
        try:
            return _embed_legacy(texts)
        except Exception:
            return None
    try:
        out = _embed_post("/api/embed", {"model": KBCFG["model"], "input": texts})
        vecs = out.get("embeddings")
        return vecs if vecs and len(vecs) == len(texts) else None
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 404 and _endpoint_missing(body):
            print("[rag] /api/embed not available (old Ollama?); using legacy /api/embeddings", flush=True)
            USE_LEGACY_EMBED = True
            try:
                return _embed_legacy(texts)
            except Exception:
                return None
        return None
    except Exception:
        return None


class Index:
    """One sqlite chunk store loaded into a normalized numpy matrix for cosine search."""

    def __init__(self, path):
        self.path = path
        self.rows = []      # [{id, repo, path, title, text}]
        self.mat = None     # normalized float32 matrix aligned with rows
        self.meta = {}
        self.load()

    def load(self):
        self.rows, self.mat, self.meta = [], None, {}
        if not os.path.exists(self.path):
            return
        try:
            db = sqlite3.connect(self.path)
            try:
                for k, v in db.execute("SELECT key, value FROM meta"):
                    self.meta[k] = v
            except Exception:
                pass
            vecs = []
            for rid, repo, rpath, title, text, emb_blob in db.execute(
                    "SELECT id, repo, path, title, text, emb FROM chunks"):
                self.rows.append({"id": rid, "repo": repo, "path": rpath, "title": title, "text": text})
                vecs.append(emb_blob)
            db.close()
            if np is not None and vecs and vecs[0]:
                dim = int(self.meta.get("dim", 0)) or (len(vecs[0]) // 4)
                mat = np.frombuffer(b"".join(vecs), dtype=np.float32).reshape(len(vecs), dim)
                norms = np.linalg.norm(mat, axis=1, keepdims=True)
                norms[norms == 0] = 1.0
                self.mat = mat / norms
        except Exception as e:
            print("[rag] failed to load %s: %s" % (self.path, e), flush=True)

    def search(self, qvec, qwords, k):
        """Cosine similarity + a small keyword-overlap boost. Falls back to keyword-only scoring
        when embeddings are unavailable on either side."""
        if not self.rows:
            return []
        scores = None
        if qvec is not None and self.mat is not None and np is not None:
            q = np.asarray(qvec, dtype=np.float32)
            n = np.linalg.norm(q)
            if n > 0:
                scores = self.mat @ (q / n)
        results = []
        for i, row in enumerate(self.rows):
            s = float(scores[i]) if scores is not None else 0.0
            if qwords:
                hay = (row["title"] + " " + row["text"]).lower()
                hits = sum(1 for w in qwords if w in hay)
                s += 0.02 * hits if scores is not None else hits
            results.append((s, row))
        results.sort(key=lambda t: -t[0])
        return results[: max(k * 4, k)]   # oversampled; caller applies the per-repo cap


KB = Index(KB_DB)
DOCS_IDX = Index(DOC_DB)


def qword_list(q, topics):
    text = (q or "") + " " + " ".join(topics or [])
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) >= 3][:24]


def do_query(q, topics, k):
    qwords = qword_list(q, topics)
    qtext = (q or "") + ((" | topics: " + ", ".join(topics)) if topics else "")
    qvec = None
    if np is not None and (KB.mat is not None or DOCS_IDX.mat is not None):
        vecs = embed([qtext])
        qvec = vecs[0] if vecs else None
    per_repo = {}
    out = []
    pool = KB.search(qvec, qwords, k) + DOCS_IDX.search(qvec, qwords, max(2, k // 2))
    pool.sort(key=lambda t: -t[0])
    for score, row in pool:
        if len(out) >= k:
            break
        repo = row["repo"]
        if per_repo.get(repo, 0) >= 3:   # per-repo cap so one corpus can't crowd out the rest
            continue
        per_repo[repo] = per_repo.get(repo, 0) + 1
        out.append({"repo": repo, "path": row["path"], "title": row["title"],
                    "text": row["text"], "score": round(float(score), 4)})
    return out


# ---------- candidate documents ----------
def load_doc_manifest():
    try:
        with open(DOC_MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_doc_manifest(m):
    tmp = DOC_MANIFEST + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DOC_MANIFEST)


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(name or ""))[:120]


def extract_text(path, name):
    ext = os.path.splitext(name)[1].lower()
    if ext in (".txt", ".md"):
        with open(path, "rb") as f:
            return f.read().decode("utf-8", "replace")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            raise RuntimeError("pypdf not installed; run kb venv setup (see README) or upload .txt/.md")
        reader = PdfReader(path)
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    raise RuntimeError("unsupported file type %s (use .pdf, .txt, or .md)" % ext)


def chunk_text(text, max_chars, overlap):
    chunks, i = [], 0
    while i < len(text):
        chunks.append(text[i:i + max_chars])
        i += max(1, max_chars - overlap)
    return [c for c in chunks if c.strip()]


def index_oversized_doc(name, text):
    """Chunk + embed an oversized 'other' doc into docindex.sqlite so /query can search it."""
    vecs_ok = np is not None
    db = sqlite3.connect(DOC_DB)
    db.execute("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, title TEXT, text TEXT, emb BLOB)")
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("DELETE FROM chunks WHERE path = ?", (name,))
    ch = KBCFG["chunk"]
    chunks = chunk_text(text, ch.get("max_chars", 1800), ch.get("overlap", 200))
    vecs = embed(chunks) if vecs_ok else None
    for i, c in enumerate(chunks):
        blob = b""
        if vecs:
            import struct
            blob = struct.pack("<%df" % len(vecs[i]), *vecs[i])
        db.execute("INSERT INTO chunks (repo, path, title, text, emb) VALUES (?,?,?,?,?)",
                   ("candidate-docs", name, name + " (part %d)" % (i + 1), c, blob))
    if vecs:
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('dim', ?)", (str(len(vecs[0])),))
    db.commit()
    db.close()
    DOCS_IDX.load()


def remove_doc_chunks(name):
    if not os.path.exists(DOC_DB):
        return
    db = sqlite3.connect(DOC_DB)
    try:
        db.execute("DELETE FROM chunks WHERE path = ?", (name,))
        db.commit()
    finally:
        db.close()
    DOCS_IDX.load()


def docs_context():
    """Concatenated candidate text for prompt stuffing: resume + JD first, then small others."""
    m = load_doc_manifest()
    parts, total = [], 0
    for name, info in sorted(m.items(), key=lambda kv: KIND_ORDER.get(kv[1].get("kind", "other"), 99)):
        txt_path = os.path.join(UPLOADS, info.get("text_file", ""))
        if not os.path.exists(txt_path):
            continue
        if info.get("kind") in OVERSIZE_ROUTED and info.get("chars", 0) > CONTEXT_CAP // 2:
            continue   # oversized docs of these kinds are retrieval-only
        with open(txt_path, encoding="utf-8") as f:
            text = f.read()
        header = "=== %s (%s) ===\n" % (name, info.get("kind", "other"))
        take = text[: max(0, CONTEXT_CAP - total - len(header))]
        if not take:
            break
        parts.append(header + take)
        # Count the header too, or the returned string quietly runs over CONTEXT_CAP by the sum of
        # every section header.
        total += len(header) + len(take)
    return "\n\n".join(parts)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, DELETE, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self._cors()
        self.send_header("Content-Type", "application/json"); self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            repos = {}
            for r in KB.rows:
                repos[r["repo"]] = repos.get(r["repo"], 0) + 1
            return self._json({"ok": True, "chunks": len(KB.rows), "repos": repos,
                               "model": KB.meta.get("model", KBCFG["model"]),
                               "built": KB.meta.get("built", ""),
                               "embeddings": KB.mat is not None,
                               "doc_chunks": len(DOCS_IDX.rows)})
        if u.path == "/docs/context":
            return self._json({"context": docs_context()})
        if u.path == "/docs":
            m = load_doc_manifest()
            docs = [{"name": k, "kind": v.get("kind", "other"), "chars": v.get("chars", 0),
                     "uploaded": v.get("uploaded", "")} for k, v in sorted(m.items())]
            return self._json({"docs": docs})
        return self._json({"ok": True})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/query":
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
                req = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
                chunks = do_query(req.get("q", ""), req.get("topics") or [], int(req.get("k", 6)))
                return self._json({"chunks": chunks})
            except Exception as e:
                return self._json({"chunks": [], "error": str(e)})
        if u.path == "/docs":
            qs = parse_qs(u.query)
            name = safe_name((qs.get("name") or [""])[0])
            kind = (qs.get("kind") or ["other"])[0]
            if kind not in DOC_KINDS:
                kind = "other"
            if not name:
                return self._json({"ok": False, "error": "missing name"}, 400)
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
                body = self.rfile.read(n) if n else b""
                raw_path = os.path.join(UPLOADS, name)
                with open(raw_path, "wb") as f:
                    f.write(body)
                text = extract_text(raw_path, name)
                text_file = name + ".extracted.txt"
                with open(os.path.join(UPLOADS, text_file), "w", encoding="utf-8") as f:
                    f.write(text)
                m = load_doc_manifest()
                m[name] = {"kind": kind, "chars": len(text), "file": name, "text_file": text_file,
                           "uploaded": datetime.datetime.now().isoformat(timespec="seconds")}
                save_doc_manifest(m)
                if kind in OVERSIZE_ROUTED and len(text) > CONTEXT_CAP // 2:
                    index_oversized_doc(name, text)
                return self._json({"ok": True, "name": name, "kind": kind, "chars": len(text)})
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 400)
        return self._json({"ok": False, "error": "unknown endpoint"}, 404)

    def do_PATCH(self):
        u = urlparse(self.path)
        if u.path == "/docs":
            qs = parse_qs(u.query)
            name = safe_name((qs.get("name") or [""])[0])
            kind = (qs.get("kind") or ["other"])[0]
            # Same whitelist as POST. Without it an arbitrary kind string lands in the manifest,
            # sorts last by KIND_ORDER's default, and silently skips the oversize guard below.
            if kind not in DOC_KINDS:
                kind = "other"
            m = load_doc_manifest()
            if name not in m:
                return self._json({"ok": False, "error": "not found"}, 404)
            m[name]["kind"] = kind
            save_doc_manifest(m)
            # kind changes flip a doc between stuffing and retrieval
            text_path = os.path.join(UPLOADS, m[name].get("text_file", ""))
            if kind in OVERSIZE_ROUTED and m[name].get("chars", 0) > CONTEXT_CAP // 2 and os.path.exists(text_path):
                with open(text_path, encoding="utf-8") as f:
                    index_oversized_doc(name, f.read())
            else:
                remove_doc_chunks(name)
            return self._json({"ok": True})
        return self._json({"ok": False}, 404)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path == "/docs":
            name = safe_name((parse_qs(u.query).get("name") or [""])[0])
            m = load_doc_manifest()
            info = m.pop(name, None)
            if info:
                save_doc_manifest(m)
                for f in (info.get("file"), info.get("text_file")):
                    if f:
                        try:
                            os.remove(os.path.join(UPLOADS, f))
                        except OSError:
                            pass
                remove_doc_chunks(name)
            return self._json({"ok": True, "deleted": bool(info)})
        return self._json({"ok": False}, 404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    status = "%d chunks" % len(KB.rows) if KB.rows else "NO INDEX (run kb/ingest.py)"
    if np is None:
        status += "; numpy missing -> keyword-only retrieval"
    print("[rag] serving on 127.0.0.1:%d (%s)" % (PORT, status), flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
