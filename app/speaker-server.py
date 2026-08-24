#!/usr/bin/env python3
"""Voice-profile sidecar for Tech Interview Copilot. Localhost only.

The browser POSTs each finalized interviewer utterance WAV here in parallel with transcription;
this embeds the voice (speaker_engine.py: fixed-length CAM++ embedding), runs online clustering,
and answers with a verdict naming which voice spoke. Voices the user NAMES become persistent
profiles under voice-profiles/<session>/profiles.json, so the same interviewer is recognized in a
later round. Voice fingerprints of real people: local-only by design, git-ignored, deletable.

Endpoints (JSON out, CORS open for the localhost app):
  POST /identify?ts=..&voiced=..&session=<id>   body = 16 kHz mono s16 WAV
       -> {ok, ts, decision, cluster, name, sim, marginPct, clusterN}
  POST /label    {session, cluster, name}   name or rename a voice -> {ok, profile}
  POST /confirm  {session, ts, cluster}     correction: the chunk at ts is this voice -> {ok, profile}
  POST /merge    {session, from, to}        fold one voice into another -> {ok, profile}
  GET  /voices?session=..   -> {ok, clusters:[{cluster,name,n,persistent,lastTs}]}
  DELETE /profiles/<pid>?session=..   forget a stored voice -> {ok, removed}
  GET  /health   -> {ok, model, session, clusters}
  POST /reset?session=..   drop session clusters, KEEP named profiles -> {ok, kept}

Usage: python3 speaker-server.py <port> <model.onnx> [profiles-root]
Needs: pip install sherpa-onnx numpy (launch.command prefers kb/venv). The app works fine without
this service: transcript lines simply stay labeled "Interviewer".
"""
import io, json, os, re, sys, threading, time, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import numpy as np

# The embedding/clustering engine (CAM++, EMBED_SAMPLES standardization, accept/suggest/margin
# thresholds, EMA) is shared with hearing-copilot via copilot-core. Party/role mapping, per-session
# scoping, and this HTTP surface are app-specific and stay here.
from copilot_core.speaker.engine import SpeakerEngine

SAVE_DEBOUNCE_S = 10    # passive centroid drift saves at most this often; label/confirm save now


def slug(session_id):
    s = re.sub(r"[^a-z0-9_-]", "", (session_id or "").lower())
    return s or "default"


class State:
    def __init__(self, model_path, profiles_root):
        self.engine = SpeakerEngine(model_path)
        self.lock = threading.Lock()          # sherpa streams are not assumed reentrant
        self.last_ts = {}                     # cluster -> last chunk ts (ms, from the app)
        self.model = os.path.basename(model_path)
        self.profiles_root = profiles_root
        self.session = None                   # bound by the first request that names one
        self.dirty = False
        self.last_save = 0.0

    def store_path(self):
        return os.path.join(self.profiles_root, slug(self.session), "profiles.json")

    def bind_session(self, session_id):
        """First session named by the app wins for this run; loads its stored profiles."""
        if not session_id or self.session is not None:
            return
        self.session = slug(session_id)
        n = self.engine.load(self.store_path())
        print("[speaker] session %s: loaded %d stored voice profile(s)" % (self.session, n), flush=True)

    def save(self, force=False):
        if self.session is None or (not self.dirty and not force):
            return
        if not force and time.time() - self.last_save < SAVE_DEBOUNCE_S:
            return
        self.engine.save(self.store_path())
        self.dirty = False
        self.last_save = time.time()

    def voice_row(self, p):
        return dict(cluster=p.pid, name=p.name, n=p.n, persistent=p.persistent,
                    lastTs=self.last_ts.get(p.pid))


STATE = None


def parse_wav(body):
    with wave.open(io.BytesIO(body), "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono s16 WAV")
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json_body(self):
        n = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        STATE.bind_session((q.get("session") or [None])[0])
        if u.path == "/health":
            self._send(200, dict(ok=True, model=STATE.model, session=STATE.session,
                                 clusters=len(STATE.engine.profiles)))
        elif u.path == "/voices":
            with STATE.lock:
                out = [STATE.voice_row(p) for p in STATE.engine.profiles]
            self._send(200, dict(ok=True, clusters=out))
        else:
            self._send(404, dict(ok=False, error="unknown path"))

    def do_DELETE(self):
        u = urlparse(self.path)
        m = re.match(r"^/profiles/([\w:.-]+)$", u.path)
        if not m:
            self._send(404, dict(ok=False, error="unknown path"))
            return
        with STATE.lock:
            removed = STATE.engine.remove(m.group(1))
            STATE.dirty = True
            STATE.save(force=True)
        self._send(200, dict(ok=True, removed=removed))

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/identify":
                self._identify(u, q)
            elif u.path == "/label":
                b = self._json_body()
                STATE.bind_session(b.get("session"))
                with STATE.lock:
                    p = STATE.engine.label(b.get("cluster"), b.get("name"))
                    if p:
                        STATE.dirty = True
                        STATE.save(force=True)
                    row = STATE.voice_row(p) if p else None
                self._send(200, dict(ok=bool(p), profile=row,
                                     error=None if p else "unknown cluster"))
            elif u.path == "/confirm":
                b = self._json_body()
                STATE.bind_session(b.get("session"))
                with STATE.lock:
                    p = STATE.engine.confirm(int(b.get("ts", 0)), b.get("cluster"))
                    if p:
                        STATE.dirty = True
                        STATE.save(force=True)
                    row = STATE.voice_row(p) if p else None
                self._send(200, dict(ok=bool(p), profile=row))
            elif u.path == "/merge":
                b = self._json_body()
                STATE.bind_session(b.get("session"))
                with STATE.lock:
                    p = STATE.engine.merge(b.get("from"), b.get("to"))
                    if p:
                        STATE.dirty = True
                        STATE.save(force=True)
                    row = STATE.voice_row(p) if p else None
                self._send(200, dict(ok=bool(p), profile=row))
            elif u.path == "/reset":
                STATE.bind_session((q.get("session") or [None])[0])
                with STATE.lock:
                    STATE.engine.profiles = [p for p in STATE.engine.profiles if p.persistent]
                    STATE.last_ts.clear()
                self._send(200, dict(ok=True, kept=len(STATE.engine.profiles)))
            else:
                self._send(404, dict(ok=False, error="unknown path"))
        except Exception as e:
            self._send(200, dict(ok=False, error=str(e)))   # 200 so the browser logs, never breaks

    def _identify(self, u, q):
        ts = int(float(q.get("ts", ["0"])[0]))
        voiced = float(q.get("voiced", ["0"])[0])
        STATE.bind_session((q.get("session") or [None])[0])
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        samples = parse_wav(body)
        t0 = time.time()
        with STATE.lock:
            v = STATE.engine.identify(samples, voiced, ts=ts)
            cluster = v.get("cluster")
            cluster_n = 0
            if cluster:
                STATE.last_ts[cluster] = ts
                p = [x for x in STATE.engine.profiles if x.pid == cluster]
                cluster_n = p[0].n if p else 0
                if p and p[0].persistent and v.get("decision") == "accept":
                    STATE.dirty = True          # passive EMA drift on a stored profile
            STATE.save()
        self._send(200, dict(ok=True, ts=ts, decision=v.get("decision"), cluster=cluster,
                             name=v.get("name"), sim=v.get("sim"),
                             marginPct=v.get("margin_pct"), clusterN=cluster_n,
                             ms=round((time.time() - t0) * 1000)))


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: speaker-server.py <port> <model.onnx> [profiles-root]")
    port, model = int(sys.argv[1]), sys.argv[2]
    root = sys.argv[3] if len(sys.argv) > 3 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "voice-profiles")
    if not os.path.isfile(model):
        sys.exit("model not found: " + model)
    global STATE
    STATE = State(model, root)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("[speaker] ready on %d (model %s, profiles under %s)" % (port, STATE.model, root),
          flush=True)
    try:
        srv.serve_forever()
    finally:
        STATE.save(force=True)


if __name__ == "__main__":
    main()
