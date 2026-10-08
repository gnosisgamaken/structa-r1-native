#!/bin/sh
set -eu

# Voice doctrine: Structa speaks only at milestones.
# Two sanctioned wantsR1Response:true sites exist in js/r1-llm.js:
#   1. speakMilestone      (the milestone speech gate)      - allowed
#   2. sendR1CoverSpeech   (image cover speech, dead-path)  - sanctioned second speaker
# Any wantsR1Response / askLLMSpeak occurrence elsewhere is a violation.

matches="$(rg -n 'wantsR1Response\s*:\s*true|askLLMSpeak' js server.py || true)"
violations="$(printf '%s\n' "$matches" | grep -v '^js/r1-llm.js:' || true)"
if [ -n "$violations" ]; then
  echo "voice doctrine violations found:"
  printf '%s\n' "$violations"
  exit 1
fi

owners="$(awk '/^[[:space:]]*function[[:space:]]+[A-Za-z0-9_]+/ { fn=$2; sub(/\(.*/, "", fn) } /wantsR1Response[[:space:]]*:[[:space:]]*true/ { print fn }' js/r1-llm.js)"
literal_count="$(printf '%s\n' "$owners" | grep -c . || true)"
milestone_gate="$(printf '%s\n' "$owners" | grep -cx 'speakMilestone' || true)"
cover_site="$(printf '%s\n' "$owners" | grep -cx 'sendR1CoverSpeech' || true)"

if [ "$literal_count" -ne 2 ] || [ "$milestone_gate" -ne 1 ] || [ "$cover_site" -ne 1 ]; then
  echo "voice doctrine expected exactly 2 wantsR1Response:true sites (speakMilestone + sendR1CoverSpeech)"
  printf '%s\n' "$matches"
  exit 1
fi

echo "voice doctrine ok"
