#!/usr/bin/env python3
"""Static file server for Tech Interview Copilot. Thin wrapper: the no-cache handler and
%KEY% secret injection live in copilot_core.webserver -- see that module for details.

Usage: python3 web-server.py <root-dir> <port>
(root-dir should be the tech-interview-copilot directory itself; the app is self-contained.)
"""
import os
import sys

from copilot_core.webserver import serve

APPDIR = os.path.dirname(os.path.abspath(__file__))          # .../tech-interview-copilot/app
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(APPDIR, "..")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8877
ENV_PATH = os.path.join(APPDIR, "..", ".env")                # .../tech-interview-copilot/.env
CONFIG_PATH = os.path.join(APPDIR, "config.js")
KEYS = ("OPENAI_API_KEY", "GROQ_API_KEY", "OLLAMA_API_KEY", "TOGETHER_API_KEY")

if __name__ == "__main__":
    serve(root=ROOT, port=PORT, config_path=CONFIG_PATH, env_path=ENV_PATH, keys=KEYS)
