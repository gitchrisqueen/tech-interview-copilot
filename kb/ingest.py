#!/usr/bin/env python3
"""Knowledge-base ingestion for Tech Interview Copilot.

Reads kb/repos.json, shallow-clones each source repo into kb/clones/, walks the include globs,
chunks markdown/code/notebooks, embeds every chunk with the local Ollama embedding model, and
writes kb/index/kb.sqlite (the store rag-server.py serves).

Idempotent and incremental: each chunk is keyed by a content hash, so re-running only embeds
what changed. Expect ~5-15 minutes for a full first build on an M-series Mac (~25-35k chunks).

Usage:
  python3 ingest.py                 full build (clone/pull + parse + embed + write)
  python3 ingest.py --no-embed      dry run: clone + parse + count chunks, skip embedding
  python3 ingest.py --repo NAME     only ingest one repo from the manifest

Requires: git, and (for embedding) a running Ollama server with the model pulled:
  OLLAMA_HOST=127.0.0.1:11501 ollama serve   +   ollama pull nomic-embed-text
numpy/pypdf from kb/requirements.txt are needed by rag-server.py, not by this script.
"""
import argparse
import fnmatch
import hashlib
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "repos.json")
CLONES = os.path.join(HERE, "clones")
INDEX_DIR = os.path.join(HERE, "index")
DB_PATH = os.path.join(INDEX_DIR, "kb.sqlite")


def load_manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def clone_or_pull(repo):
    dest = os.path.join(CLONES, repo["name"])
    if os.path.isdir(os.path.join(dest, ".git")):
        print("[kb] updating %s" % repo["name"])
        subprocess.run(["git", "-C", dest, "pull", "--ff-only", "--depth", "1"],
                       check=False, capture_output=True)
    else:
        print("[kb] cloning %s (shallow)" % repo["name"])
        os.makedirs(CLONES, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", repo["url"], dest], check=True)
    return dest


def glob_match(rel_posix, pattern):
    """fnmatch with globstar semantics: '**/' also matches zero directories, so '**/*.md'
    matches root-level files too (plain fnmatch would require at least one slash)."""
    if fnmatch.fnmatch(rel_posix, pattern):
        return True
    return pattern.startswith("**/") and fnmatch.fnmatch(rel_posix, pattern[3:])


def matched_files(root, patterns, max_files=None):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), root)
            rel_posix = rel.replace(os.sep, "/")
            if any(glob_match(rel_posix, p) for p in patterns):
                out.append(rel_posix)
    out.sort()
    if max_files:
        out = out[:max_files]
    return out


# ---------- parsing / chunking ----------
def split_markdown(text, max_chars, overlap):
    """Split on headings first (keeps sections coherent), then cap each section by size."""
    sections, cur, title = [], [], ""
    for line in text.splitlines():
        m = re.match(r"^(#{1,4})\s+(.*)", line)
        if m:
            if cur:
                sections.append((title, "\n".join(cur)))
            title, cur = m.group(2).strip(), [line]
        else:
            cur.append(line)
    if cur:
        sections.append((title, "\n".join(cur)))
    chunks = []
    for title, body in sections:
        body = body.strip()
        if not body:
            continue
        i = 0
        while i < len(body):
            part = body[i:i + max_chars]
            chunks.append((title, part))
            i += max(1, max_chars - overlap)
    return chunks


def notebook_cells(text):
    """Extract markdown + code cells from a .ipynb via stdlib json."""
    try:
        nb = json.loads(text)
    except Exception:
        return []
    out = []
    for cell in nb.get("cells", []):
        src = "".join(cell.get("source", []))
        if src.strip():
            out.append((cell.get("cell_type", "cell"), src))
    return out


def leetcode_readme_rows(clone_dir):
    """The LeetCode-Solutions README tables map problem -> complexity -> tags. Build a
    {basename: row-text} lookup so each solution chunk can carry its complexity header."""
    rows = {}
    readme = os.path.join(clone_dir, "README.md")
    if not os.path.exists(readme):
        return rows
    with open(readme, encoding="utf-8", errors="replace") as f:
        for line in f:
            if "|" not in line or "./Python/" not in line:
                continue
            m = re.search(r"\./Python/([\w.-]+\.py)", line)
            if m:
                clean = re.sub(r"\s*\|\s*", " | ", line.strip().strip("|"))
                rows[m.group(1)] = clean
    return rows


def file_chunks(repo_name, clone_dir, rel, max_chars, overlap, lc_rows):
    """Yield (title, text) chunks for one file."""
    path = os.path.join(clone_dir, rel)
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    if not text.strip():
        return []
    ext = os.path.splitext(rel)[1].lower()
    base = os.path.basename(rel)
    if ext in (".md", ".mdx"):
        return split_markdown(text, max_chars, overlap)
    if ext == ".ipynb":
        out = []
        for kind, src in notebook_cells(text):
            i = 0
            while i < len(src):
                out.append(("%s (%s cell)" % (base, kind), src[i:i + max_chars]))
                i += max(1, max_chars - overlap)
        return out
    if ext == ".py":
        # Solutions are small; keep them whole (capped) with the problem name, and for
        # LeetCode prepend the README's complexity/tag row as a header.
        title = re.sub(r"[-_]", " ", os.path.splitext(base)[0])
        header = ""
        if repo_name == "LeetCode-Solutions" and base in lc_rows:
            header = "# " + lc_rows[base] + "\n"
        body = header + text
        out, i = [], 0
        while i < len(body):
            out.append((title, body[i:i + max_chars * 2]))   # code chunks get double budget
            i += max(1, max_chars * 2 - overlap)
        return out
    return []


# ---------- embedding ----------
# Ollama answers 404 from /api/embed for two very different reasons: the model is not available
# to the server ("model not found, try pulling it first"), or the build predates v0.3.0 and only
# has the legacy per-prompt /api/embeddings endpoint. The preflight below tells them apart; this
# flag flips the batch call over to the legacy endpoint when needed.
USE_LEGACY_EMBED = False


def _post_json(url, payload, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _http_error_body(e):
    try:
        return e.read().decode("utf-8", "replace")[:300]
    except Exception:
        return ""


def _endpoint_missing(body):
    """Distinguish the two 404s Ollama can return: a missing MODEL is a JSON {"error": ...}
    body; a missing ENDPOINT (pre-v0.3.0 build without /api/embed) is Go's plain-text
    "404 page not found". Substring checks can't tell them apart (both say "not found")."""
    try:
        return "error" not in json.loads(body)
    except Exception:
        return True


def embed_legacy(cfg, texts):
    """Old-Ollama path: /api/embeddings takes one prompt per call."""
    base = cfg["ollama_url"].rstrip("/")
    vecs = []
    for t in texts:
        out = _post_json(base + "/api/embeddings", {"model": cfg["model"], "prompt": t})
        v = out.get("embedding")
        if not v:
            raise RuntimeError("legacy /api/embeddings returned no vector")
        vecs.append(v)
    return vecs


def embed_batch(cfg, texts):
    global USE_LEGACY_EMBED
    if USE_LEGACY_EMBED:
        return embed_legacy(cfg, texts)
    try:
        out = _post_json(cfg["ollama_url"].rstrip("/") + "/api/embed",
                         {"model": cfg["model"], "input": texts})
    except urllib.error.HTTPError as e:
        body = _http_error_body(e)
        if e.code == 404 and _endpoint_missing(body):
            # Endpoint itself is missing (old Ollama) -> switch to the legacy API for the rest of the run.
            print("[kb] /api/embed not available (old Ollama?); falling back to legacy /api/embeddings. "
                  "Upgrading Ollama is recommended (brew upgrade ollama).")
            USE_LEGACY_EMBED = True
            return embed_legacy(cfg, texts)
        raise RuntimeError(
            "embedding request failed: HTTP %s from %s/api/embed%s\n"
            "If the model is missing, pull it with: OLLAMA_HOST=%s ollama pull %s"
            % (e.code, cfg["ollama_url"], (" - " + body) if body else "",
               cfg["ollama_url"].replace("http://", ""), cfg["model"]))
    vecs = out.get("embeddings")
    if not vecs or len(vecs) != len(texts):
        raise RuntimeError("embedding response mismatch (%s vs %s)" % (len(vecs or []), len(texts)))
    return vecs


def preflight(cfg):
    """Fail fast, with the exact fix, before any cloning or embedding starts.
    Checks: server reachable (falling back to the default 11434 port if the configured one is
    down), model present (auto-pulling it if not), and which embed endpoint this build has."""
    global USE_LEGACY_EMBED
    base = cfg["ollama_url"].rstrip("/")

    def alive(url):
        try:
            with urllib.request.urlopen(url + "/api/version", timeout=5) as r:
                return r.status == 200
        except Exception:
            return False

    if not alive(base):
        alt = "http://localhost:11434"
        if base != alt and alive(alt):
            print("[kb] Ollama not reachable at %s; using the default instance at %s for this run" % (base, alt))
            cfg["ollama_url"] = base = alt
        else:
            sys.exit("[kb] Ollama is not reachable at %s (or %s).\n"
                     "Start it first: ./launch.command   (or: OLLAMA_HOST=127.0.0.1:11501 ollama serve)" % (base, alt))

    # Model present? Names in /api/tags carry a tag suffix (nomic-embed-text:latest).
    model = cfg["model"]
    try:
        with urllib.request.urlopen(base + "/api/tags", timeout=10) as r:
            tags = json.loads(r.read().decode("utf-8")).get("models", [])
        names = {m.get("name", "") for m in tags} | {m.get("name", "").split(":")[0] for m in tags}
    except Exception:
        names = set()
    if model not in names and model.split(":")[0] not in names:
        print("[kb] embedding model %r is not on this Ollama server; pulling it now (~274 MB, one time)..." % model)
        try:
            req = urllib.request.Request(base + "/api/pull",
                                         data=json.dumps({"name": model, "stream": True}).encode("utf-8"),
                                         headers={"Content-Type": "application/json"}, method="POST")
            last = ""
            with urllib.request.urlopen(req, timeout=1800) as r:
                for line in r:
                    try:
                        status = json.loads(line.decode("utf-8")).get("status", "")
                    except Exception:
                        continue
                    if status and status != last:
                        print("[kb]   " + status)
                        last = status
            if last != "success":
                raise RuntimeError("pull ended with status %r" % last)
        except Exception as e:
            sys.exit("[kb] auto-pull failed (%s).\nPull it manually, then re-run:\n"
                     "  OLLAMA_HOST=%s ollama pull %s" % (e, base.replace("http://", ""), model))

    # Which embed endpoint does this build have?
    try:
        _post_json(base + "/api/embed", {"model": model, "input": ["ping"]}, timeout=60)
    except urllib.error.HTTPError as e:
        body = _http_error_body(e)
        if e.code == 404 and _endpoint_missing(body):
            print("[kb] this Ollama build has no /api/embed (pre-v0.3.0); using the legacy "
                  "/api/embeddings endpoint. Upgrading is recommended: brew upgrade ollama")
            USE_LEGACY_EMBED = True
            try:
                embed_legacy(cfg, ["ping"])
            except Exception as e2:
                sys.exit("[kb] legacy embedding probe failed too (%s). Upgrade Ollama and re-run." % e2)
        else:
            sys.exit("[kb] embedding probe failed: HTTP %s%s" % (e.code, (" - " + body) if body else ""))
    except Exception as e:
        sys.exit("[kb] embedding probe failed: %s" % e)
    print("[kb] preflight ok: %s, model %s%s" % (base, model, " (legacy endpoint)" if USE_LEGACY_EMBED else ""))


def pack(vec):
    return struct.pack("<%df" % len(vec), *vec)


# ---------- main ----------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-embed", action="store_true", help="parse + count only; skip embedding and DB writes of vectors")
    ap.add_argument("--repo", help="only ingest this repo name from the manifest")
    args = ap.parse_args()

    manifest = load_manifest()
    emb_cfg = manifest.get("embedding", {})
    emb_cfg.setdefault("model", "nomic-embed-text")
    # TIC_OLLAMA_URL overrides the manifest (same precedence rag-server.py uses).
    emb_cfg["ollama_url"] = os.environ.get("TIC_OLLAMA_URL",
                                           emb_cfg.get("ollama_url", "http://localhost:11501"))
    batch = int(emb_cfg.get("batch", 64))
    ch = manifest.get("chunk", {})
    max_chars, overlap = int(ch.get("max_chars", 1800)), int(ch.get("overlap", 200))

    if not args.no_embed:
        preflight(emb_cfg)   # verify server + model + endpoint before any cloning starts

    os.makedirs(INDEX_DIR, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, hash TEXT UNIQUE, repo TEXT, "
               "path TEXT, title TEXT, text TEXT, emb BLOB)")
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    existing = {h for (h,) in db.execute("SELECT hash FROM chunks")}
    print("[kb] index: %s (%d chunks already present)" % (DB_PATH, len(existing)))

    t0 = time.time()
    total_new, total_seen = 0, 0
    pending = []   # [(hash, repo, path, title, text)]

    def flush(force=False):
        nonlocal pending, total_new
        while pending and (force or len(pending) >= batch):
            take, pending = pending[:batch], pending[batch:]
            if args.no_embed:
                total_new += len(take)
                continue
            vecs = embed_batch(emb_cfg, [t[4] for t in take])
            for (h, repo, path, title, text), vec in zip(take, vecs):
                db.execute("INSERT OR IGNORE INTO chunks (hash, repo, path, title, text, emb) VALUES (?,?,?,?,?,?)",
                           (h, repo, path, title, text, pack(vec)))
            db.commit()
            total_new += len(take)
            if total_new % (batch * 4) < batch:
                rate = total_new / max(1e-9, time.time() - t0)
                print("[kb]   %d new chunks embedded (%.0f/s)" % (total_new, rate))

    live_hashes = set()
    for repo in manifest["repos"]:
        if args.repo and repo["name"] != args.repo:
            continue
        clone_dir = clone_or_pull(repo)
        files = matched_files(clone_dir, repo.get("include", ["**/*.md"]), repo.get("max_files"))
        print("[kb] %s: %d files matched" % (repo["name"], len(files)))
        lc_rows = leetcode_readme_rows(clone_dir) if repo["name"] == "LeetCode-Solutions" else {}
        for rel in files:
            for title, text in file_chunks(repo["name"], clone_dir, rel, max_chars, overlap, lc_rows):
                text = text.strip()
                if len(text) < 40:
                    continue
                h = hashlib.sha256((repo["name"] + "|" + rel + "|" + text).encode("utf-8")).hexdigest()
                live_hashes.add(h)
                total_seen += 1
                if h in existing:
                    continue
                pending.append((h, repo["name"], rel, title or rel, text))
                flush()
    flush(force=True)

    # Prune chunks whose source content disappeared (only on full, non-filtered runs).
    if not args.repo and not args.no_embed and live_hashes:
        stale = existing - live_hashes
        if stale:
            print("[kb] pruning %d stale chunks" % len(stale))
            db.executemany("DELETE FROM chunks WHERE hash = ?", [(h,) for h in stale])
            db.commit()

    if not args.no_embed:
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('model', ?)", (emb_cfg["model"],))
        db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('built', ?)",
                   (time.strftime("%Y-%m-%d %H:%M"),))
        row = db.execute("SELECT emb FROM chunks WHERE emb IS NOT NULL AND length(emb) > 0 LIMIT 1").fetchone()
        if row:
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('dim', ?)", (str(len(row[0]) // 4),))
        db.commit()

    n = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    db.close()
    mode = "counted (dry run)" if args.no_embed else "embedded"
    print("[kb] done in %.1fs: %d chunks scanned, %d new %s, index now holds %d chunks"
          % (time.time() - t0, total_seen, total_new, mode, n))
    if args.no_embed:
        print("[kb] dry run only - the index gained no vectors. Re-run without --no-embed to build.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[kb] interrupted; the index is consistent (batches commit atomically). Re-run to resume.")
        sys.exit(1)
