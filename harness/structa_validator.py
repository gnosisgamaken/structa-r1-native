#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional
import json
import re

MODES: Dict[str, List[str]] = {
    "summarize": ["STATE", "BLOCKER", "NEXT_MOVE", "CONFIDENCE"],
    "propose_actions": ["INTENT", "TARGET", "ACTION_STATE", "NEXT_ACTION", "FALLBACK"],
    "withdraw_export": ["SUMMARY", "KEY_FACTS", "SOURCE_TRACE"],
    "clarify": ["QUESTION"],
    "build": ["INTENT", "TARGET", "ACTION_STATE", "NEXT_ACTION", "FALLBACK"],
    "inspect": ["BEST_NEXT_MOVE", "CAUTION"],
    "solve": ["DIAGNOSIS", "FIX_PATH", "APPROVAL_REQUIRED", "NEXT_ACTION"],
    "delete": ["INTENT", "TARGET", "ACTION_STATE", "APPROVAL_REQUIRED", "NEXT_ACTION", "FALLBACK"],
}

BANNED_PHRASES = [
    r"\bi can(?:'|’)t access\b",
    r"\bi cannot access\b",
    r"\bweb browsing\b",
    r"\bbrowse the web\b",
    r"\bgithub\b",
    r"\bdeepwiki\b",
    r"\bdlam\b",
    r"\brepository access\b",
    r"\bdocs?\b",
    r"\bconsult docs\b",
    r"\btool limitations?\b",
    r"\bexternal app\b",
]

HEADING_RE = re.compile(r"^#{1,6}\s*(.+?)\s*$")
LABEL_RE = re.compile(r"^([A-Za-z][A-Za-z0-9_ ]{0,48}?):\s*(.*)$")
BULLET_RE = re.compile(r"^[-*•]\s+(.*)$")


@dataclass
class ValidationResult:
    mode: str
    valid: bool
    sanitized: Optional[str]
    score: int
    issues: List[str]
    canonicalized: bool

    def to_dict(self) -> Dict[str, object]:
        return asdict(self)


def _normalize(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9_-]*\n?", "", text).strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    return text


def _has_banned_phrase(text: str) -> Optional[str]:
    lowered = text.lower()
    for pat in BANNED_PHRASES:
        if re.search(pat, lowered, flags=re.I):
            return pat
    return None


def _slot_name(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", label.strip()).strip("_").upper()


def _parse_direct_label_card(text: str, slots: List[str]) -> Optional[Dict[str, str]]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) != len(slots):
        return None
    data: Dict[str, str] = {}
    for expected_slot, line in zip(slots, lines):
        match = LABEL_RE.match(line)
        if not match:
            return None
        label = _slot_name(match.group(1))
        value = match.group(2).strip()
        if label != expected_slot or label in data or not value:
            return None
        data[label] = value
    return data if all(slot in data for slot in slots) else None


def _parse_wrapped_heading_card(text: str, slots: List[str]) -> Optional[Dict[str, str]]:
    lines = [ln.rstrip() for ln in text.splitlines()]
    data: Dict[str, List[str]] = {}
    current: Optional[str] = None
    saw_any_slot = False
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        heading = HEADING_RE.match(line)
        if heading:
            label = _slot_name(heading.group(1))
            if label in slots:
                current = label
                saw_any_slot = True
                data.setdefault(label, [])
                continue
        match = LABEL_RE.match(line)
        if match:
            label = _slot_name(match.group(1))
            if label in slots:
                current = label
                saw_any_slot = True
                data.setdefault(label, [])
                if match.group(2).strip():
                    data[label].append(match.group(2).strip())
                continue
        bullet = BULLET_RE.match(line)
        if bullet and current:
            data.setdefault(current, []).append(bullet.group(1).strip())
            continue
        if current:
            data.setdefault(current, []).append(line)
    if not saw_any_slot:
        return None
    normalized: Dict[str, str] = {}
    for slot in slots:
        parts = data.get(slot)
        if not parts:
            return None
        normalized[slot] = " ".join(part for part in parts if part).strip()
    return normalized


def validate_response(text: str, mode: str, strict: bool = True) -> ValidationResult:
    slots = MODES.get(mode)
    if not slots:
        return ValidationResult(mode=mode, valid=False, sanitized=None, score=0, issues=[f"unknown mode: {mode}"], canonicalized=False)
    normalized = _normalize(text)
    issues: List[str] = []
    banned = _has_banned_phrase(normalized)
    if banned:
        return ValidationResult(mode=mode, valid=False, sanitized=None, score=0, issues=[f"banned phrase matched: {banned}"], canonicalized=False)
    direct = _parse_direct_label_card(normalized, slots)
    if direct:
        canonical = "\n".join(f"{slot}: {direct[slot]}" for slot in slots)
        exact = canonical == normalized
        return ValidationResult(mode=mode, valid=True, sanitized=canonical, score=3 if exact else 2, issues=[] if exact else ["normalized to canonical slot shape"], canonicalized=not exact)
    if not strict:
        wrapped = _parse_wrapped_heading_card(normalized, slots)
        if wrapped:
            canonical = "\n".join(f"{slot}: {wrapped[slot]}" for slot in slots)
            return ValidationResult(mode=mode, valid=True, sanitized=canonical, score=2, issues=["wrapped card normalized"], canonicalized=True)
    return ValidationResult(mode=mode, valid=False, sanitized=None, score=0, issues=["missing required slots or extra prose outside slots"], canonicalized=False)


def main() -> int:
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("mode")
    parser.add_argument("--sanitize", action="store_true")
    args = parser.parse_args()

    result = validate_response(sys.stdin.read(), mode=args.mode, strict=not args.sanitize)
    print(json.dumps(result.to_dict(), indent=2, ensure_ascii=False))
    return 0 if result.valid else 1


if __name__ == "__main__":
    raise SystemExit(main())