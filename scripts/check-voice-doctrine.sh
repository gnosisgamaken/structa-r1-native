#!/bin/sh
set -eu

matches="$(rg -n 'wantsR1Response\s*:\s*true|askLLMSpeak' js server.py || true)"
violations="$(printf '%s\n' "$matches" | grep -v '^js/r1-llm.js:' || true)"
literal_count="$(printf '%s\n' "$matches" | grep -c 'wantsR1Response' || true)"

if [ -n "$violations" ]; then
  echo "voice doctrine violations found:"
  printf '%s\n' "$violations"
  exit 1
fi

if [ "$literal_count" -ne 1 ]; then
  echo "voice doctrine expected 1 literal wantsR1Response:true"
  printf '%s\n' "$matches"
  exit 1
fi

echo "voice doctrine ok"
