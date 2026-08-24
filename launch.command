#!/bin/bash
# Tech Interview Copilot launcher (macOS). Double-click to run.
# Bootstraps dependencies (npm + a shared Python venv with copilot-core), then starts:
# (1) the web app, (2) the log/settings server, (3) Ollama on a unique port (the bridge
# to Ollama Cloud), (4) the RAG retrieval server, (5) the voice-profile sidecar,
# (6) a local whisper.cpp server (ASR fallback). Then opens the browser. Services it starts
# are stopped when you close this window / Ctrl+C.
#
# Ports are distinct from the hearing-copilot set, so both apps can run at the same time.
# Override paths if needed:
#   WHISPER_SERVER_BIN=/path/to/whisper-server  WHISPER_MODEL=/path/to/ggml-base.en.bin  ./launch.command

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # .../tech-interview-copilot

WEB_PORT=8877
LOGSRV_PORT=8890
RAG_PORT=8892
OLLAMA_PORT=11501
WHISPER_PORT=8189
URL="http://localhost:${WEB_PORT}/index.html"
PIDS=()

LOGDIR="$DIR/logs"
mkdir -p "$LOGDIR"
port_busy() { lsof -i ":$1" >/dev/null 2>&1; }
cleanup() { echo; echo "Stopping services..."; for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

echo "Tech Interview Copilot"
echo "Dir: $DIR"
echo

# ---- 0) Bootstrap: npm install (the copilot-core JS package) + a shared Python venv with
# copilot-core installed (used by web-server.py, log-server.py, speaker-server.py, and
# rag-server.py). Idempotent -- skipped once already installed. ----
if [ ! -d "$DIR/node_modules/@gitchrisqueen/copilot-core" ]; then
  echo "[setup]   installing npm dependencies (@gitchrisqueen/copilot-core)..."
  ( cd "$DIR" && npm install ) || echo "[setup]   npm install failed; the app's core scripts will 404. Run 'npm install' manually."
fi

PYVENV="$DIR/kb/venv"
if [ ! -x "$PYVENV/bin/python" ]; then
  echo "[setup]   creating a Python venv for the app's sidecars (kb/venv)..."
  python3 -m venv "$PYVENV" 2>/dev/null
fi
if [ -x "$PYVENV/bin/python" ] && ! "$PYVENV/bin/python" -c "import copilot_core" >/dev/null 2>&1; then
  echo "[setup]   installing Python dependencies into kb/venv (copilot-core, numpy, pypdf, sherpa-onnx)..."
  "$PYVENV/bin/pip" install -q -r "$DIR/kb/requirements.txt" \
    || echo "[setup]   some Python dependencies failed to install; see the output above."
fi
PY="$PYVENV/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c "import copilot_core" >/dev/null 2>&1; then
  echo "[setup]   WARNING: copilot_core is not importable; web/log/speaker servers will fail to start."
  echo "          Fix: cd \"$DIR\" && kb/venv/bin/pip install -r kb/requirements.txt"
fi

# ---- 1) Web server (serves the app, injects .env secrets into config.js) ----
if port_busy "$WEB_PORT"; then
  echo "[web]     port $WEB_PORT already in use; reusing it."
else
  "$PY" "$DIR/app/web-server.py" "$DIR" "$WEB_PORT" >"$LOGDIR/web.log" 2>&1 &
  PIDS+=($!); echo "[web]     serving on $WEB_PORT (no-cache; log: logs/web.log)"
fi

# ---- 2) Log + settings server (durable transcript, Config-tab persistence, /asr proxy) ----
if port_busy "$LOGSRV_PORT"; then
  echo "[log]     port $LOGSRV_PORT already in use; reusing it."
else
  "$PY" "$DIR/app/log-server.py" "$LOGDIR" "$LOGSRV_PORT" >"$LOGDIR/logserver.log" 2>&1 &
  PIDS+=($!); echo "[log]     log/settings server on $LOGSRV_PORT -> logs/transcript-<date>.jsonl"
  ( sleep 4; line="$(grep -m1 '\[asr\]' "$LOGDIR/logserver.log" 2>/dev/null)"; [ -n "$line" ] && echo "$line" ) &
fi

# ---- 3) Ollama (bridge to Ollama Cloud models + local embedding model) on a unique port ----
if command -v ollama >/dev/null 2>&1; then
  if port_busy "$OLLAMA_PORT"; then
    echo "[ollama]  port $OLLAMA_PORT already in use; reusing it."
  else
    OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" OLLAMA_ORIGINS="http://localhost:${WEB_PORT}" ollama serve >"$LOGDIR/ollama.log" 2>&1 &
    PIDS+=($!); echo "[ollama]  serving on $OLLAMA_PORT (log: logs/ollama.log)"
  fi
else
  echo "[ollama]  not installed; skipping. LLM answers need it: brew install ollama"
fi

# ---- 4) RAG retrieval server (knowledge base + candidate docs) ----
RAGSRV="$DIR/app/rag-server.py"
if [ -f "$RAGSRV" ]; then
  if port_busy "$RAG_PORT"; then
    echo "[rag]     port $RAG_PORT already in use; reusing it."
  else
    "$PY" "$RAGSRV" "$DIR" "$RAG_PORT" >"$LOGDIR/rag.log" 2>&1 &
    PIDS+=($!); echo "[rag]     retrieval server on $RAG_PORT (log: logs/rag.log)"
    if [ ! -f "$DIR/kb/index/kb.sqlite" ]; then
      echo "          NOTE: no knowledge-base index yet. Build it once with:"
      echo "          kb/venv/bin/python kb/ingest.py"
    fi
  fi
fi

# ---- 5) voice-profile sidecar (tells multiple interviewers apart in the transcript) ----
# Fingerprints each interviewer utterance so the app can label lines by voice and let you name
# them. Needs python with sherpa-onnx + numpy (the shared venv above). The app works fine
# without it (lines stay labeled "Interviewer"), so every failure here just skips the service.
SPKSRV="$DIR/app/speaker-server.py"
SPK_PORT=8891
SPK_MODEL="${SPEAKER_MODEL:-$DIR/models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx}"
if [ -f "$SPKSRV" ]; then
  if [ ! -f "$SPK_MODEL" ] && command -v curl >/dev/null 2>&1; then
    echo "[speaker] voice model missing; downloading (~28 MB, one time)..."
    mkdir -p "$(dirname "$SPK_MODEL")"
    curl -sfL --max-time 180 -o "$SPK_MODEL" \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx" \
      || { rm -f "$SPK_MODEL"; echo "[speaker] download failed; voice profiles off this session."; }
  fi
  if [ -f "$SPK_MODEL" ]; then
    if port_busy "$SPK_PORT"; then
      echo "[speaker] port $SPK_PORT already in use; reusing it."
    elif "$PY" -c "import sherpa_onnx, numpy" >/dev/null 2>&1; then
      "$PY" "$SPKSRV" "$SPK_PORT" "$SPK_MODEL" "$DIR/voice-profiles" >"$LOGDIR/speaker.log" 2>&1 &
      PIDS+=($!); echo "[speaker] voice profiles on $SPK_PORT (log: logs/speaker.log)"
    else
      echo "[speaker] python deps missing; voice profiles off. To enable:"
      echo "          kb/venv/bin/pip install -r kb/requirements.txt"
    fi
  fi
fi

# ---- 6) whisper.cpp server for transcription (local ASR fallback) ----
WBIN="${WHISPER_SERVER_BIN:-}"
if [ -z "$WBIN" ]; then
  if command -v whisper-server >/dev/null 2>&1; then WBIN="$(command -v whisper-server)"
  elif [ -x "$HOME/whisper.cpp/build/bin/whisper-server" ]; then WBIN="$HOME/whisper.cpp/build/bin/whisper-server"
  fi
fi
WMODEL="${WHISPER_MODEL:-$HOME/whisper-models/ggml-base.en.bin}"
if [ -n "$WBIN" ] && [ -f "$WMODEL" ]; then
  if port_busy "$WHISPER_PORT"; then
    echo "[whisper] port $WHISPER_PORT already in use; reusing it."
  else
    WTHREADS="${WHISPER_THREADS:-8}"
    "$WBIN" -m "$WMODEL" --host 127.0.0.1 --port "$WHISPER_PORT" -t "$WTHREADS" >"$LOGDIR/whisper.log" 2>&1 &
    PIDS+=($!); echo "[whisper] serving on $WHISPER_PORT (model: $(basename "$WMODEL"); ${WTHREADS} threads)"
  fi
else
  echo "[whisper] not started (optional local ASR fallback). Need whisper-server + a model."
  echo "          binary: ${WBIN:-not found}   model: $WMODEL $( [ -f "$WMODEL" ] || echo '(missing)')"
fi

echo
echo "Open: $URL"
echo "Leave this window open. Press Ctrl+C to stop."
sleep 1
open "$URL"

# Keep running until interrupted.
while true; do sleep 3600; done
