#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import textwrap
import urllib.request

from semantic_judge import judge_semantics
from structa_validator import MODES, validate_response


ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_SCENARIOS = ROOT / "scenarios" / "batch_v1.json"
DEFAULT_OUTPUT_DIR = ROOT / "outputs"
DEFAULT_LMSTUDIO_BASE = "http://127.0.0.1:1234/v1"


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


def load_trace_scenarios(path: pathlib.Path):
    if path.is_dir():
        scenarios: list[dict] = []
        for candidate in sorted(path.glob("s*.json")):
            data = json.loads(candidate.read_text())
            if isinstance(data, list):
                scenarios.extend(data)
            else:
                scenarios.append(data)
        return scenarios
    data = json.loads(path.read_text())
    if isinstance(data, dict):
        return data.get("scenarios", [data])
    return data


def expected_slots(mode: str) -> str:
    slots = MODES.get(mode, [])
    return "\n".join(f"{slot}: <value>" for slot in slots)


def build_user_prompt(scenario: dict) -> str:
    allowed_verbs = ", ".join(scenario.get("allowed_verbs", ["build", "patch", "delete", "solve", "inspect", "withdraw"]))
    allowed_sources = ", ".join(scenario.get("allowed_sources", ["local context only"]))
    user_intent = scenario.get("user_input") or scenario.get("voice_transcript") or ""

    blocks = [textwrap.dedent(
        f"""
        CARD
        project_name: {scenario.get('project_name', 'unknown')}
        project_domain: {scenario.get('project_domain', 'unknown')}
        project_state: {scenario.get('project_state', 'UNKNOWN')}
        archetype: {scenario.get('archetype', 'unknown')}
        user_intent: {user_intent}
        intent_mode: {scenario.get('mode', 'summarize')}
        allowed_verbs: {allowed_verbs}
        allowed_sources: {allowed_sources}
        approval_mode: {scenario.get('approval_mode', 'mutations require approval')}
        voice_mode: transcribe first, never use raw voice as prompt
        response_mode: {scenario.get('mode', 'summarize')}

        RETURN EXACTLY
        {expected_slots(scenario.get('mode', 'summarize'))}
        """
    ).strip()]

    voice_transcript = scenario.get("voice_transcript")
    if voice_transcript:
        blocks.append("VOICE_TRANSCRIPT\n" + str(voice_transcript).strip())

    image_descriptions = scenario.get("image_descriptions") or []
    if image_descriptions:
        image_lines = ["IMAGE_DESCRIPTIONS"]
        for index, desc in enumerate(image_descriptions[:6], start=1):
            image_lines.append(f"{index}. {str(desc).strip()}")
        blocks.append("\n".join(image_lines))

    asset_comments = scenario.get("asset_comments") or []
    if asset_comments:
        comment_lines = ["ASSET_COMMENTS"]
        for index, comment in enumerate(asset_comments[:8], start=1):
            comment_lines.append(f"{index}. {str(comment).strip()}")
        blocks.append("\n".join(comment_lines))

    triangle = scenario.get("triangle") or {}
    if triangle:
        tri_lines = ["TRIANGLE"]
        if triangle.get("point_a"):
            tri_lines.append("POINT_A: " + str(triangle["point_a"]).strip())
        if triangle.get("point_b"):
            tri_lines.append("POINT_B: " + str(triangle["point_b"]).strip())
        if triangle.get("angle"):
            tri_lines.append("ANGLE: " + str(triangle["angle"]).strip())
        blocks.append("\n".join(tri_lines))

    return "\n\n".join(blocks)


def _http_json(url: str, payload: dict, headers: dict | None = None, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


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
    body = _http_json(
        "https://api.openai.com/v1/chat/completions",
        payload,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=60,
    )
    return body["choices"][0]["message"]["content"].strip()


def detect_lmstudio_model(base_url: str) -> str:
    models_url = base_url.rstrip("/") + "/models"
    with urllib.request.urlopen(models_url, timeout=10) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    items = body.get("data") or []
    if not items:
        raise RuntimeError("No LM Studio models loaded. Load one in LM Studio first.")
    preferred = [
        "Qwen3.5-9B-Q4_K_M",
        "Harmonic-Hermes-9B-Q8_0",
        "NVIDIA-Nemotron-3-Nano-4B-Q4_K_M",
    ]
    ids = [item.get("id", "") for item in items]
    for pref in preferred:
        for model_id in ids:
            if pref.lower() in model_id.lower():
                return model_id
    return ids[0]


def call_lmstudio(model: str, system_prompt: str, user_prompt: str, base_url: str, timeout: int) -> tuple[str, str]:
    chosen_model = detect_lmstudio_model(base_url) if model in {"auto", "", None} else model
    payload = {
        "model": chosen_model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    body = _http_json(base_url.rstrip("/") + "/chat/completions", payload, timeout=timeout)
    return body["choices"][0]["message"]["content"].strip(), chosen_model


def mock_response(scenario: dict) -> str:
    mode = scenario.get("mode", "summarize")
    state = scenario.get("project_state", "UNKNOWN")
    text = scenario.get("user_input") or scenario.get("voice_transcript") or ""
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


def run_scenario(scenario: dict, provider: str, model: str, lmstudio_base_url: str, lmstudio_timeout: int) -> dict:
    prompt = build_user_prompt(scenario)
    used_model = model
    if provider == "openai":
        raw = call_openai(model=model, system_prompt=SYSTEM_PROMPT, user_prompt=prompt)
    elif provider == "lmstudio":
        raw, used_model = call_lmstudio(model=model, system_prompt=SYSTEM_PROMPT, user_prompt=prompt, base_url=lmstudio_base_url, timeout=lmstudio_timeout)
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
        "model": used_model,
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


def trace_match_value(actual, expected) -> bool:
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(trace_match_value(actual.get(key), value) for key, value in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) < len(expected):
            return False
        return all(trace_match_value(actual[index], value) for index, value in enumerate(expected))
    return actual == expected


def match_trace_event(actual: dict, expected: dict) -> bool:
    return all(trace_match_value(actual.get(key), value) for key, value in expected.items())


def run_trace_scenario(scenario: dict) -> dict:
    tail = scenario.get("trace_tail") or []
    expected = scenario.get("expect_tail") or []
    matched = []
    mismatches = []
    cursor = 0
    for index, expected_entry in enumerate(expected):
        actual_entry = None
        ok = False
        while cursor < len(tail):
            candidate = tail[cursor]
            cursor += 1
            if isinstance(candidate, dict) and match_trace_event(candidate, expected_entry):
                actual_entry = candidate
                ok = True
                break
            if actual_entry is None:
                actual_entry = candidate
        matched.append(ok)
        if not ok:
            mismatches.append({
                "index": index,
                "expected": expected_entry,
                "actual": actual_entry,
            })
    voice_calls = scenario.get("voice_calls") or {}
    voice_ok = True
    if voice_calls:
        observed = scenario.get("observed_voice_calls") or voice_calls
        voice_ok = match_trace_event(observed, voice_calls)
        if not voice_ok:
            mismatches.append({
                "index": "voice_calls",
                "expected": voice_calls,
                "actual": observed,
            })
    return {
        "id": scenario.get("id", "unknown"),
        "title": scenario.get("title", scenario.get("id", "trace scenario")),
        "kind": "trace",
        "valid": bool(expected) and all(matched) and voice_ok,
        "expected_count": len(expected),
        "actual_count": len(tail),
        "matched": matched,
        "mismatches": mismatches,
    }


def write_trace_outputs(results: list[dict], output_dir: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = output_dir / f"trace-harness-{stamp}.json"
    md_path = output_dir / f"trace-harness-{stamp}.md"
    summary = {
        "total": len(results),
        "passed": sum(1 for item in results if item["valid"]),
        "failed": sum(1 for item in results if not item["valid"]),
    }
    json_path.write_text(json.dumps({"summary": summary, "results": results}, indent=2))
    lines = [
        f"# Structa Trace Harness — {stamp}",
        "",
        f"- total: {summary['total']}",
        f"- passed: {summary['passed']}",
        f"- failed: {summary['failed']}",
        "",
    ]
    for item in results:
        lines.extend([
            f"## {item['id']}",
            f"title: {item['title']}",
            f"valid: {item['valid']}",
            f"expected_count: {item['expected_count']}",
            f"actual_count: {item['actual_count']}",
            "",
        ])
        if item["mismatches"]:
            lines.append("```json")
            lines.append(json.dumps(item["mismatches"], indent=2))
            lines.append("```")
            lines.append("")
    md_path.write_text("\n".join(lines))
    return json_path, md_path


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
            f"model: {item['model']}",
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
    parser.add_argument("--suite", choices=["llm", "trace"], default="llm")
    parser.add_argument("--scenarios", default=str(DEFAULT_SCENARIOS))
    parser.add_argument("--provider", choices=["mock", "openai", "lmstudio"], default="mock")
    parser.add_argument("--model", default="auto")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--lmstudio-base-url", default=DEFAULT_LMSTUDIO_BASE)
    parser.add_argument("--lmstudio-timeout", type=int, default=300)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if args.suite == "trace":
        scenarios = load_trace_scenarios(pathlib.Path(args.scenarios))
        results = [run_trace_scenario(scenario) for scenario in scenarios]
        json_path, md_path = write_trace_outputs(results, pathlib.Path(args.output_dir))
        summary = {
            "total": len(results),
            "passed": sum(1 for item in results if item["valid"]),
            "failed": sum(1 for item in results if not item["valid"]),
        }
        print(json.dumps({
            "ok": summary["failed"] == 0,
            "suite": "trace",
            "json": str(json_path),
            "report": str(md_path),
            "summary": summary,
        }, indent=2))
        return 0 if summary["failed"] == 0 else 1

    scenarios = load_scenarios(pathlib.Path(args.scenarios))
    if args.offset:
        scenarios = scenarios[args.offset:]
    if args.limit:
        scenarios = scenarios[:args.limit]
    results = [
        run_scenario(
            scenario,
            provider=args.provider,
            model=args.model,
            lmstudio_base_url=args.lmstudio_base_url,
            lmstudio_timeout=args.lmstudio_timeout,
        )
        for scenario in scenarios
    ]
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
