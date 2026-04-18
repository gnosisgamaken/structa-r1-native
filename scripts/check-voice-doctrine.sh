#!/bin/sh
set -eu

matches="$(rg -n 'wantsR1Response\s*:\s*true|askLLMSpeak' js server.py || true)"
violations="$(printf '%s\n' "$matches" | grep -v '^js/r1-llm.js:' || true)"

if [ -n "$violations" ]; then
  echo "voice doctrine violations found:"
  printf '%s\n' "$violations"
  exit 1
fi

echo "voice doctrine ok"
