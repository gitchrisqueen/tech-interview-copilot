#!/bin/bash
# Stop every Tech Interview Copilot service, including strays left by a previous run.
# Double-click to run. Kills whatever is listening on the app's six ports.
#   8877 web app | 8890 log/settings | 8891 voice profiles | 8892 rag | 8189 whisper | 11501 ollama
echo "Stopping Tech Interview Copilot services..."
for PORT in 8877 8890 8891 8892 8189 11501; do
  PIDS=$(lsof -ti ":$PORT" 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "  port $PORT -> killing $PIDS"
    kill $PIDS 2>/dev/null
    sleep 1
    STILL=$(lsof -ti ":$PORT" 2>/dev/null)
    [ -n "$STILL" ] && { echo "  port $PORT -> force killing $STILL"; kill -9 $STILL 2>/dev/null; }
  else
    echo "  port $PORT -> nothing running"
  fi
done
echo "Done. You can relaunch with launch.command."
