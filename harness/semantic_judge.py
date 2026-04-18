#!/usr/bin/env python3
from __future__ import annotations

from typing import Dict, List
import re

GENERIC_PHRASES = [
    "refine structure",
    "draft structure proposal",
    "additional source data",
    "resolve issue",
    "improve workflow",
    "review approvals needed",
    "schedule decision review meeting",
]

WEAK_WORDS = {
    "thing", "things", "stuff", "help", "better", "improve", "refine",
    "review", "consider", "maybe", "could", "should", "nice", "cleaner"
}


def _parse_slots(text: str) -> Dict[str, str]:
    parsed: Dict[str, str] = {}
    for line in (text or "").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        parsed[key.strip().upper()] = value.strip()
    return parsed


def _words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def judge_semantics(mode: str, canonical_text: str) -> Dict[str, object]:
    slots = _parse_slots(canonical_text)
    joined = " ".join(slots.values())
    words = _words(joined)

    specificity = 0
    actionability = 0
    grounding = 0
    tone = 0
    generic_flags: List[str] = []

    if len(words) >= 8:
        specificity += 1
    if any(char.isdigit() for char in joined) or any(token in joined.lower() for token in ["approval", "branch", "capture", "routing", "source_trace", "project framing", "duplicate", "pending"]):
        specificity += 1

    if any(slot in slots for slot in ["NEXT_ACTION", "NEXT_MOVE", "FIX_PATH", "QUESTION", "BEST_NEXT_MOVE"]):
        actionability += 1
    if any(token in joined.lower() for token in ["approve", "stage", "archive", "frame", "route", "consolidate", "ground", "ask", "name"]):
        actionability += 1

    if "UNKNOWN" in joined or any(token in joined.lower() for token in ["approval", "pending", "open questions", "blocked", "empty but active"]):
        grounding += 1
    if not any(phrase in joined.lower() for phrase in ["web browsing", "github", "docs", "dlam"]):
        grounding += 1

    if len(words) <= 28:
        tone += 1
    if not any(word in WEAK_WORDS for word in words):
        tone += 1

    for phrase in GENERIC_PHRASES:
        if phrase in joined.lower():
            generic_flags.append(phrase)

    total = specificity + actionability + grounding + tone
    if total >= 7 and not generic_flags:
        band = "strong"
    elif total >= 5:
        band = "acceptable"
    else:
        band = "weak"

    return {
        "specificity": specificity,
        "actionability": actionability,
        "grounding": grounding,
        "tone": tone,
        "total": total,
        "band": band,
        "generic_flags": generic_flags,
    }