#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import textwrap
import urllib.request

from semantic_judge import judge_semantics
from structa_validator import MODES, validate_response


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_SCENARIOS = ROOT / "scenarios" / "batch_v1.json"
DEFAULT_OUTPUT_DIR = ROOT / "outputs"


SYSTEM_PROMPT = textwrap.dedent(
    """
    You are Structa, a project cognition system.
    Respond like a card engine, not a generic assistant.
    Use only the supplied scenario.
    Do not mention web browsing, tool limitations, GitHub, docs, DLAM, or external apps.
    Do not add extra prose outside the requested slots.
    If facts are missing, mark them UNKNOWN.
    Mutations require approval.
    Clarify mode must ask exactly one question.
    Keep the response short and exact.
    """
).strip()


def load_scenarios(path: pathlib.Path):
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        return data.get("scenarios", [])
    return data


def expected_slots(mode: str) -> str:
    slots = MODES.get(mode, [])
    return "\n".join(f"{slot}: <value>" for slot in slots)


def build_user_prompt(scenario: dict) -> str:
    allowed_verbs = ", ".join(scenario.get("allowed_verbs", ["build", "patch", "delete", "solve", "inspect", "withdraw"]))
    allowed_sources = ", ".join(scenario.get("allowed_sources", ["local context only"]))
    return textwrap.dedent(
        f"""
        CARD
        project_name: {scenario.get('project_name', 'unknown')}
        project_domain: {scenario.get('project_domain', 'unknown')}
        project_state: {scenario.get('project_state', 'UNKNOWN')}
        archetype: {scenario.get('archetype', 'unknown')}
        user_intent: {scenario.get('user_input', '')}
        intent_mode: {scenario.get('mode', 'summarize')}
        allowed_verbs: {allowed_verbs}
        allowed_sources: {allowed_sources}
        approval_mode: {scenario.get('approval_mode', 'mutations require approval')}
        voice_mode: transcribe first, never use raw voice as prompt
        response_mode: {scenario.get('mode', 'summarize')}

        RETURN EXACTLY
        {expected_slots(scenario.get('mode', 'summarize'))}
        """
    ).strip()


def call_openai(model: str, system_prompt: str, user_prompt: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY missing")
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    return body["choices"][0]["message"]["content"].strip()


def mock_response(scenario: dict) -> str:
    mode = scenario.get("mode", "summarize")
    state = scenario.get("project_state", "UNKNOWN")
    text = scenario.get("user_input", "")
    if mode == "summarize":
        return f"STATE: {state}\nBLOCKER: unclear structure\nNEXT_MOVE: name what matters first\nCONFIDENCE: medium"
    if mode == "clarify":
        return "QUESTION: What matters most first?"
    if mode == "withdraw_export":
        return f"SUMMARY: {state}\nKEY_FACTS: {text[:60] or 'UNKNOWN'}\nSOURCE_TRACE: LOCAL_ONLY"
    if mode in {"propose_actions", "build"}:
        return "INTENT: create structure\nTARGET: current project state\nACTION_STATE: proposed\nNEXT_ACTION: stage first branch\nFALLBACK: stop"
    if mode == "delete":
        return "INTENT: remove stale branch\nTARGET: duplicate branch\nACTION_STATE: proposed\nAPPROVAL_REQUIRED: true\nNEXT_ACTION: await approval\nFALLBACK: archive branch"
    if mode == "inspect":
        return "BEST_NEXT_MOVE: ground the next conclusion\nCAUTION: avoid unverified claims"
    if mode == "solve":
        return "DIAGNOSIS: routing conflict\nFIX_PATH: stage one canonical path\nAPPROVAL_REQUIRED: true\nNEXT_ACTION: request approval"
    return "STATE: UNKNOWN\nBLOCKER: UNKNOWN\nNEXT_MOVE: stop\nCONFIDENCE: low"


def run_scenario(scenario: dict, provider: str, model: str) -> dict:
    prompt = build_user_prompt(scenario)
    if provider == "openai":
        raw = call_openai(model=model, system_prompt=SYSTEM_PROMPT, user_prompt=prompt)
    else:
        raw = mock_response(scenario)

    strict = validate_response(raw, scenario["mode"], strict=True)
    lenient = validate_response(raw, scenario["mode"], strict=False)
    canonical = strict.sanitized or lenient.sanitized or ""
    semantics = judge_semantics(scenario["mode"], canonical) if canonical else {
        "specificity": 0,
        "actionability": 0,
        "grounding": 0,
        "tone": 0,
        "total": 0,
        "band": "weak",
        "generic_flags": ["validation_failed"],
    }

    return {
        "id": scenario.get("id"),
        "mode": scenario.get("mode"),
        "provider": provider,
        "model": model,
        "raw_output": raw,
        "strict": strict.to_dict(),
        "lenient": lenient.to_dict(),
        "semantic": semantics,
    }


def summarize(results: list[dict]) -> dict:
    total = len(results)
    strict_pass = sum(1 for item in results if item["strict"]["valid"])
    lenient_pass = sum(1 for item in results if item["lenient"]["valid"])
    bands = {"strong": 0, "acceptable": 0, "weak": 0}
    for item in results:
        bands[item["semantic"]["band"]] = bands.get(item["semantic"]["band"], 0) + 1
    return {
        "total": total,
        "strict_pass": strict_pass,
        "lenient_pass": lenient_pass,
        "semantic_bands": bands,
    }


def write_outputs(results: list[dict], output_dir: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    jsonl_path = output_dir / f"harness-run-{stamp}.jsonl"
    md_path = output_dir / f"harness-run-{stamp}.md"

    with jsonl_path.open("w") as handle:
        for item in results:
            handle.write(json.dumps(item, ensure_ascii=False) + "\n")

    summary = summarize(results)
    lines = [
        f"# Structa Harness Run — {stamp}",
        "",
        f"- total: {summary['total']}",
        f"- strict_pass: {summary['strict_pass']}",
        f"- lenient_pass: {summary['lenient_pass']}",
        f"- semantic_strong: {summary['semantic_bands'].get('strong', 0)}",
        f"- semantic_acceptable: {summary['semantic_bands'].get('acceptable', 0)}",
        f"- semantic_weak: {summary['semantic_bands'].get('weak', 0)}",
        "",
    ]
    for item in results:
        lines.extend([
            f"## {item['id']} — {item['mode']}",
            f"strict_valid: {item['strict']['valid']}",
            f"lenient_valid: {item['lenient']['valid']}",
            f"semantic_band: {item['semantic']['band']}",
            "",
            "```",
            item['raw_output'],
            "```",
            "",
        ])
    md_path.write_text("\n".join(lines))
    return jsonl_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local text-only Structa harness batches.")
    parser.add_argument("--scenarios", default=str(DEFAULT_SCENARIOS))
    parser.add_argument("--provider", choices=["mock", "openai"], default="mock")
    parser.add_argument("--model", default="gpt-4.1-mini")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    args = parser.parse_args()

    scenarios = load_scenarios(pathlib.Path(args.scenarios))
    results = [run_scenario(scenario, provider=args.provider, model=args.model) for scenario in scenarios]
    jsonl_path, md_path = write_outputs(results, pathlib.Path(args.output_dir))
    print(json.dumps({
        "ok": True,
        "scenarios": len(results),
        "provider": args.provider,
        "model": args.model,
        "jsonl": str(jsonl_path),
        "report": str(md_path),
        "summary": summarize(results),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())