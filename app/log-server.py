#!/usr/bin/env python3
"""Transcript log writer + settings store + Together ASR proxy for Tech Interview Copilot.
Thin wrapper: the actual /log, /settings, and /asr handling lives in copilot_core.logserver.

Usage: python3 log-server.py <logdir> <port>
"""
import os
import sys

from copilot_core.envfile import seed_environ
from copilot_core.logserver import serve

APPDIR = os.path.dirname(os.path.abspath(__file__))
LOGDIR = sys.argv[1] if len(sys.argv) > 1 else "."
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8890
SETTINGS_PATH = os.path.join(APPDIR, "settings.json")        # git-ignored per-machine settings
ENV_PATH = os.path.join(APPDIR, "..", ".env")                # git-ignored

if __name__ == "__main__":
    seed_environ(ENV_PATH, keys=("TOGETHER_API_KEY",))
    serve(LOGDIR, PORT, settings_path=SETTINGS_PATH)
