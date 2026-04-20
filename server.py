#!/usr/bin/env python3
import http.server
import json
import os
import pathlib
import time
from urllib.parse import urlparse

CLAIMS_EXTRACT_BUCKETS = {}
CLAIMS_EXTRACT_PER_MINUTE = 10
BUILD_SHA = os.environ.get("STRUCTA_BUILD_SHA", "workspace")
BUILD_AT = os.environ.get("STRUCTA_BUILT_AT", "")


def compact(text, limit=220):
    value = str(text or "").strip()
    value = " ".join(value.split())
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "…"


def build_project_lines(project):
    lines = []
    if not isinstance(project, dict):
        return lines
    if project.get("name"):
        lines.append(f"project: {project['name']}")
    if project.get("type"):
        lines.append(f"type: {project['type']}")
    if project.get("brief"):
        lines.append(f"brief: {compact(project['brief'], 180)}")
    questions = project.get("topQuestions") or []
    if questions:
        lines.append("top questions: " + "; ".join(compact(q, 60) for q in questions[:3]))
    if project.get("summary"):
        lines.append("working memory: " + compact(project["summary"], 240))
    if project.get("selectedSurface"):
        lines.append(f"surface: {project['selectedSurface']}")
    return lines


def build_selection_lines(selection):
    if not isinstance(selection, dict):
        return []
    summary = compact(selection.get("summary") or selection.get("body") or "", 220)
    lines = []
    if selection.get("kind"):
        lines.append(f"selection kind: {selection['kind']}")
    if summary:
        lines.append("selection: " + summary)
    if selection.get("status"):
        lines.append(f"selection status: {selection['status']}")
    claims = selection.get("claims") or []
    if claims:
        for claim_entry in claims[:4]:
            if isinstance(claim_entry, dict) and claim_entry.get("id") and claim_entry.get("text"):
                lines.append(f"claim {claim_entry['id']}: {compact(claim_entry['text'], 90)}")
    return lines


def build_image_prompt(project, input_data, meta=None):
    project = project if isinstance(project, dict) else {}
    input_data = input_data if isinstance(input_data, dict) else {}
    meta = meta if isinstance(meta, dict) else {}
    annotation = compact(input_data.get("voiceAnnotation") or input_data.get("transcript") or "", 180)
    project_name = compact(project.get("name") or "untitled project", 72)
    project_type = compact(project.get("type") or "general", 32)
    branch = project.get("activeBranch") if isinstance(project.get("activeBranch"), dict) else {}
    branch_name = compact(branch.get("name") or branch.get("id") or "main", 48)
    branch_parent = compact(branch.get("parentBranchId") or "", 48)
    recent_claims = []
    for claim in project.get("recentClaims") or []:
        if not isinstance(claim, dict):
            continue
        text = compact(claim.get("text") or "", 80)
        if not text:
            continue
        recent_claims.append(text)
        if len(recent_claims) >= 3:
            break
    open_questions = []
    for question in project.get("openQuestions") or project.get("topQuestions") or []:
        if isinstance(question, dict):
            text = compact(question.get("body") or question.get("text") or question.get("title") or "", 80)
        else:
            text = compact(question, 80)
        if not text:
            continue
        open_questions.append(text)
        if len(open_questions) >= 2:
            break

    prompt_lines = [
        "Project image analysis.",
        "Describe only visible facts relevant to the project.",
        "Return 2 short sentences, then 1-4 bullet claims prefixed with '-'.",
        f"project: {project_name}",
        f"type: {project_type}",
        f"branch: {branch_name}" + (f" (parent {branch_parent})" if branch_parent else ""),
        "focus:",
    ]
    if recent_claims:
        prompt_lines.extend(["- " + claim for claim in recent_claims])
    else:
        prompt_lines.append("- early project")
    prompt_lines.append("questions:")
    if open_questions:
        prompt_lines.extend(["- " + question for question in open_questions])
    else:
        prompt_lines.append("- none yet")
    prompt_lines.extend([
        "intent:",
        annotation or "no annotation — infer relevance from project context above",
        "camera:",
        f"- mode: {compact(meta.get('facingMode') or 'environment', 24)}",
        f"- image: {compact(input_data.get('imageId') or '', 48) or 'unknown'}",
    ])

    text = "\n".join(prompt_lines)
    return compact(text, 1400)


def extract_claim_lines_from_text(raw):
    lines = []
    for line in str(raw or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        claim_text = compact(stripped.lstrip("-").strip(), 160)
        if claim_text:
            lines.append(claim_text)
    if lines:
        return lines[:4]
    text = normalize_multiline(raw)
    fallback_parts = [part.strip() for part in text.replace("\n", " ").split(".") if part.strip()]
    return [compact(part, 160) for part in fallback_parts[:2] if compact(part, 160)]


def extract_claims_from_text(payload):
    input_data = payload.get("input") or {}
    raw_text = input_data.get("text") or payload.get("text") or ""
    source = compact(payload.get("source") or "image", 24).lower() or "image"
    source_ref = payload.get("sourceRef") or {}
    lines = extract_claim_lines_from_text(raw_text)
    claims = extract_simple_claims(lines, source, source_ref=source_ref)
    return {
        "ok": True,
        "claims": claims,
        "ui": {
            "summary": f"{len(claims)} claims",
            "logLine": "claims extracted",
        },
        "meta": {
            "kind": "claims-extract-from-text",
        },
    }


def claims_extract_allowed(payload):
    meta = payload.get("meta") or {}
    input_data = payload.get("input") or {}
    key = compact(meta.get("deviceId") or input_data.get("deviceId") or "anonymous", 120) or "anonymous"
    now = int(time.time())
    bucket = CLAIMS_EXTRACT_BUCKETS.get(key) or []
    bucket = [stamp for stamp in bucket if now - stamp < 60]
    if len(bucket) >= CLAIMS_EXTRACT_PER_MINUTE:
        CLAIMS_EXTRACT_BUCKETS[key] = bucket
        return False
    bucket.append(now)
    CLAIMS_EXTRACT_BUCKETS[key] = bucket
    return True


def normalize_multiline(text):
    return "\n".join(line.strip() for line in str(text or "").splitlines() if line.strip())


def parse_labeled_lines(raw):
    result = {}
    for line in str(raw or "").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        result[key.strip().upper()] = value.strip()
    return result


def soften_branch_prompt(text, limit=120):
    value = compact(text, limit)
    lowered = value.lower()
    if lowered.startswith("what specific help do you need"):
        return "let's open the next branch: what matters most first?"
    if lowered.startswith("what help do you need") or lowered.startswith("what do you need help"):
        return "let's open the next branch: what matters most first?"
    if lowered.startswith("how can i help") or lowered.startswith("how can structa help"):
        return "let's choose where this should begin."
    if lowered.startswith("what should happen first"):
        return "let's decide what should happen first."
    if lowered.startswith("what do you need for") or lowered.startswith("what do you need to"):
        return "let's choose what this needs first."
    if lowered.startswith("what are you trying to"):
        return "let's name what this is moving toward."
    if lowered.startswith("what matters most"):
        return "let's name what matters most first."
    if value.endswith(("?", "!", ".")):
        return value
    if lowered.startswith(("what ", "how ", "where ", "when ", "who ")):
        return value + "?"
    return value


def artifact(kind, body, title="", status="open", source="orchestrator", options=None):
    item = {
        "type": kind,
        "body": compact(body, 220),
        "source": source,
        "status": status,
    }
    if title:
        item["title"] = compact(title, 72)
    if options:
        item["options"] = options[:3]
    return item


def infer_claim_kind(text, fallback="fact"):
    lowered = str(text or "").strip().lower()
    if not lowered:
        return fallback
    if lowered.endswith("?") or lowered.startswith(("what ", "how ", "where ", "when ", "which ")):
        return "question"
    if any(token in lowered for token in ("must ", "need to", "cannot ", "can't ", "should ", "required", "deadline", "by ")):
        return "constraint"
    if any(token in lowered for token in ("prefer", "want", "like", "comfortable", "love", "hate")):
        return "preference"
    if any(token in lowered for token in ("will ", "going to", "plan ", "decide ", "choose ", "moving toward")):
        return "intent"
    return fallback


def estimate_stt_confidence(text):
    words = [word for word in str(text or "").split() if word.strip()]
    if not words:
        return 0.0
    score = 0.45
    if len(words) >= 4:
        score += 0.16
    if len(words) >= 8:
        score += 0.08
    if any(ch in str(text or "") for ch in ".?!,"):
        score += 0.06
    if not any(fragment in str(text or "").lower() for fragment in (" um ", " uh ", " maybe maybe ", "...", "???")):
        score += 0.08
    return round(min(score, 0.96), 2)


def claim(text, kind="fact", source="voice", source_ref=None, confidence=0.68, evidence=None, stt_confidence=None):
    item = {
        "text": compact(text, 160),
        "kind": kind,
        "source": source,
        "confidence": confidence,
        "sourceRef": source_ref or {},
        "evidence": evidence[:] if isinstance(evidence, list) else [],
        "status": "active",
    }
    if stt_confidence is not None:
        item["sttConfidence"] = stt_confidence
    return item


def extract_simple_claims(parts, source, source_ref=None, stt_confidence=None):
    claims = []
    for raw in parts:
        text = compact(raw or "", 160)
        if not text:
            continue
        claims.append(claim(
            text=text,
            kind=infer_claim_kind(text),
            source=source,
            source_ref=source_ref,
            confidence=0.72 if source in {"voice", "answer", "comment"} else 0.7,
            stt_confidence=stt_confidence,
        ))
    return claims


def voice_prepare(payload):
    project = payload.get("project") or {}
    selection = payload.get("selection") or {}
    input_data = payload.get("input") or {}
    transcript = compact(input_data.get("transcript") or "", 400)
    question_text = compact(payload.get("questionText") or input_data.get("questionText") or "", 200)
    answering = bool(payload.get("answeringQuestion"))

    lines = [
        "You are Structa, a precision project orchestrator.",
        "Use only the provided project context and transcript.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    selection_lines = build_selection_lines(selection)
    if selection_lines:
        lines.extend(["", "SELECTION"] + selection_lines)

    if answering:
        lines.extend([
            "",
            "QUESTION",
            question_text or "project question",
            "",
            "USER ANSWER",
            transcript,
            "",
            "Return exactly these lines:",
            "TYPE: answer",
            "INSIGHT: <what the answer unlocks, max 12 words>",
            "NEXT: <one next move, max 8 words>",
            "DECISION: <omit unless the answer clearly commits to one>",
        ])
    else:
        lines.extend([
            "",
            "USER INPUT",
            transcript,
            "",
            "Classify and condense the input.",
            "Return exactly these lines:",
            "TYPE: signal | question | decision | task | note_update",
            "INSIGHT: <one sharp working interpretation, max 14 words>",
            "NEXT: <one next move, max 8 words>",
            "DECISION: <omit unless the input clearly commits to one>",
        ])

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 22000,
            "priority": payload.get("policy", {}).get("priority", "high"),
        },
        "ui": {
            "summary": compact(transcript, 80),
            "logLine": "voice interpreted",
        },
        "meta": {
            "kind": "voice",
            "answeringQuestion": answering,
        },
    }


def voice_normalize(payload):
    raw = payload.get("rawResponse") or ""
    input_data = payload.get("input") or {}
    transcript = compact(input_data.get("transcript") or "", 240)
    answering = bool(payload.get("answeringQuestion"))
    question_text = compact(payload.get("questionText") or input_data.get("questionText") or "", 200)
    parsed = parse_labeled_lines(raw)
    insight = parsed.get("INSIGHT") or compact(raw, 120)
    next_step = parsed.get("NEXT", "")
    decision = parsed.get("DECISION", "")
    kind = (parsed.get("TYPE") or "signal").strip().lower()
    if kind == "answer":
        kind = "signal"
    primary_kind = "signal" if kind in {"decision", "note_update"} else kind
    artifacts = [artifact(primary_kind, insight, source="voice")]
    if decision:
        artifacts.append(artifact("decision", decision, title=decision, source="voice"))
    if next_step:
        artifacts.append(artifact("task", next_step, title="next", source="voice"))
    claims = extract_simple_claims(
        [insight] + ([decision] if decision else []),
        "answer" if answering else "voice",
        source_ref={"questionText": question_text} if answering and question_text else {},
        stt_confidence=estimate_stt_confidence(transcript) if transcript else None,
    )
    response = {
        "ok": True,
        "clean": insight,
        "structured": {
            "raw": normalize_multiline(raw),
            "insight": insight,
            "next": next_step,
            "decision": decision,
            "conf": "med",
        },
        "artifacts": artifacts,
        "claims": claims,
        "ui": {
            "summary": insight,
            "logLine": "voice interpreted",
        },
        "meta": {
            "kind": "voice",
        },
    }
    if answering:
        response["answerNode"] = {
            "body": transcript,
            "claims": [entry["text"] for entry in claims],
            "sttConfidence": estimate_stt_confidence(transcript) if transcript else None,
            "questionText": question_text,
        }
    return response


def image_prepare(payload):
    project = payload.get("project") or {}
    input_data = payload.get("input") or {}
    image_base64 = input_data.get("imageBase64") or ""
    meta = payload.get("meta") or {}
    prompt = build_image_prompt(project, input_data, meta)

    return {
        "ok": True,
        "llm": {
            "prompt": prompt,
            "imageBase64": image_base64,
            "timeout": 40000,
            "priority": payload.get("policy", {}).get("priority", "high"),
        },
        "ui": {
            "summary": "analyzing image",
            "logLine": "image queued",
        },
        "meta": {
            "kind": "image",
        },
    }


def image_normalize(payload):
    raw = payload.get("rawResponse") or ""
    parsed = parse_labeled_lines(raw)
    facts = parsed.get("FACTS", "")
    signal = parsed.get("SIGNAL", "")
    next_step = parsed.get("NEXT", "")
    summary = signal or facts or "frame saved"
    artifacts = [artifact("signal", summary, source="image")]
    if next_step:
        artifacts.append(artifact("task", next_step, title="next", source="image"))
    claims = extract_simple_claims(
        [signal or summary, facts],
        "image",
        source_ref={"imageId": compact(((payload.get("input") or {}).get("imageId") or ((payload.get("meta") or {}).get("imageId")) or ""), 80)},
    )
    return {
        "ok": True,
        "clean": summary,
        "structured": {
            "raw": normalize_multiline(raw),
            "facts": facts,
            "signal": signal,
            "next": next_step,
            "insight": summary,
            "decision": "",
            "conf": "med",
        },
        "artifacts": artifacts,
        "claims": claims,
        "ui": {
            "summary": summary,
            "logLine": "image analyzed",
        },
        "meta": {
            "analysisStatus": "ready",
        },
    }


def normalize_chain_focus(raw):
    if not isinstance(raw, dict):
        return None
    target = raw.get("target") if isinstance(raw.get("target"), dict) else raw
    kind = compact(target.get("kind") or raw.get("kind") or "branch", 32).lower()
    target_id = compact(target.get("id") or raw.get("id") or "", 80)
    branch_id = compact(target.get("branchId") or raw.get("branchId") or target_id or "main", 80)
    phase = compact(raw.get("phase") or "observe", 32).lower()
    if not target_id:
      target_id = branch_id or "main"
    return {
        "kind": kind if kind in {"branch", "question", "claim"} else "branch",
        "id": target_id,
        "branchId": branch_id or "main",
        "phase": phase if phase in {"observe", "clarify", "evaluate", "decision"} else "observe",
    }


def build_chain_digest(project, focus, history):
    nodes = project.get("nodes") or []
    claims = project.get("claims") or []
    answers = project.get("answers") or []
    branch_id = focus.get("branchId") or "main"

    active_branch_claims = [
        claim_item for claim_item in claims
        if claim_item.get("status", "active") == "active"
        and (claim_item.get("branchId") or "main") == branch_id
    ]
    disputed_claims = [
        claim_item for claim_item in claims
        if claim_item.get("status") == "disputed"
    ]
    open_questions = [
        {
            "id": node.get("node_id"),
            "body": compact(node.get("body") or node.get("title") or "", 180),
            "branchId": node.get("meta", {}).get("branch_id") or "main",
            "priority": compact(node.get("meta", {}).get("priority") or "normal", 24).lower(),
            "skippedUntil": node.get("meta", {}).get("skipped_until") or "",
            "evidence_claims": (node.get("meta", {}).get("evidence_claims") or [])[:6],
        }
        for node in nodes
        if node.get("type") == "question"
        and node.get("status") == "open"
        and not node.get("meta", {}).get("skipped_until")
    ]
    recent_answers = [{
        "id": answer.get("id"),
        "questionId": answer.get("questionId"),
        "body": compact(answer.get("body") or "", 160),
        "claims": (answer.get("claims") or [])[:6],
        "at": answer.get("at"),
    } for answer in answers[:8]]
    recent_claims = active_branch_claims[:24]
    cross_branch_disputed = [claim_item for claim_item in disputed_claims if (claim_item.get("branchId") or "main") != branch_id][:8]
    truncated = {}
    if len(active_branch_claims) > len(recent_claims):
        truncated["recent_claims"] = len(active_branch_claims)
    if len(open_questions) > 12:
        truncated["open_questions"] = len(open_questions)
        open_questions = open_questions[:12]
    if len(answers) > 8:
        truncated["recent_answers"] = len(answers)
    if len(disputed_claims) > len(cross_branch_disputed):
        truncated["disputed_claims"] = len(disputed_claims)

    previous_steps = (history or {}).get("previous_steps") or []
    previous_steps = previous_steps[:4]

    branch_context = {
        "id": branch_id,
        "name": compact(branch_id.replace("-", " "), 48),
        "parentBranchId": "",
        "claim_count": len([claim_item for claim_item in claims if (claim_item.get("branchId") or "main") == branch_id]),
        "open_question_count": len([item for item in open_questions if (item.get("branchId") or "main") == branch_id]),
    }

    digest = {
        "recent_claims": recent_claims + cross_branch_disputed,
        "open_questions": open_questions,
        "recent_answers": recent_answers,
        "skipped_questions": [
            {
                "id": node.get("node_id"),
                "body": compact(node.get("body") or node.get("title") or "", 180),
                "skippedUntil": node.get("meta", {}).get("skipped_until") or "",
            }
            for node in nodes
            if node.get("type") == "question"
            and node.get("status") == "open"
            and node.get("meta", {}).get("skipped_until")
        ][:12],
        "disputed_claims": disputed_claims[:8],
        "branch_context": branch_context,
    }
    if truncated:
        digest["truncated"] = truncated
    return {
        "focus": focus,
        "digest": digest,
        "history": {
            "previous_steps": previous_steps,
            "plateau_count": int((history or {}).get("plateau_count") or 0),
        },
    }


def extract_json_block(text):
    raw = str(text or "").strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        pass
    if "```" in raw:
        parts = [segment.strip() for segment in raw.split("```") if segment.strip()]
        for part in parts:
            candidate = part
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
            try:
                return json.loads(candidate)
            except Exception:
                continue
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start:end + 1])
        except Exception:
            return {}
    return {}


def normalize_chain_evidence(value):
    if isinstance(value, list):
        return [compact(item, 64) for item in value if compact(item, 64)]
    if isinstance(value, str):
        return [compact(item, 64) for item in value.replace("|", ",").split(",") if compact(item, 64)]
    return []


def validate_chain_response_shape(data):
    produced = data.get("produced") if isinstance(data.get("produced"), dict) else {}
    errors = []
    for kind in ("claims", "decisions", "tasks"):
        for item in produced.get(kind) or []:
            if not normalize_chain_evidence(item.get("evidence")):
                errors.append(f"{kind}:missing evidence")
    for item in produced.get("questions") or []:
        meta = item.get("meta") if isinstance(item.get("meta"), dict) else {}
        if not normalize_chain_evidence(meta.get("evidence_claims")):
            errors.append("questions:missing evidence")
    return errors


def normalize_triangle_parent_ids(payload):
    parent_ids = []
    for item_key in ("itemA", "itemB"):
        item = payload.get(item_key) if isinstance(payload.get(item_key), dict) else {}
        for claim_id in item.get("claimIds") or []:
            value = compact(claim_id, 64)
            if value and value not in parent_ids:
                parent_ids.append(value)
    return parent_ids


def normalize_triangle_claim_rows(payload):
    rows = []
    for label, item_key in (("A", "itemA"), ("B", "itemB")):
        item = payload.get(item_key) if isinstance(payload.get(item_key), dict) else {}
        claims = item.get("claims") or []
        rows.append(
            {
                "itemId": compact(item.get("itemId") or "", 64),
                "label": label,
                "claims": [
                    {
                        "id": compact(claim_entry.get("id") or "", 64),
                        "text": compact(claim_entry.get("text") or "", 160),
                        "kind": compact(claim_entry.get("kind") or "fact", 24).lower(),
                        "status": compact(claim_entry.get("status") or "active", 24).lower(),
                        "branchId": compact(claim_entry.get("branchId") or "main", 48),
                    }
                    for claim_entry in claims
                    if isinstance(claim_entry, dict) and compact(claim_entry.get("id") or "", 64) and compact(claim_entry.get("text") or "", 160)
                ],
            }
        )
    return rows


def validate_triangle_response_shape(data):
    status = compact(data.get("status") or "", 24).lower()
    if status not in {"synthesized", "ambiguous"}:
        return ["triangle:invalid status"]
    if compact(data.get("body") or "", 40):
        return ["triangle:body not allowed"]
    if status == "synthesized":
        derived_claims = data.get("derived_claims") or []
        if not isinstance(derived_claims, list) or not derived_claims:
            return ["triangle:missing derived_claims"]
        errors = []
        for item in derived_claims:
            if not normalize_chain_evidence(item.get("evidence")):
                errors.append("triangle:derived claim missing evidence")
        return errors
    question = data.get("question") if isinstance(data.get("question"), dict) else {}
    meta = question.get("meta") if isinstance(question.get("meta"), dict) else {}
    if not compact(question.get("body") or "", 160):
        return ["triangle:missing ambiguity question"]
    if not normalize_chain_evidence(meta.get("evidence_claims")):
        return ["triangle:ambiguity question missing evidence"]
    return []


def chain_prepare(payload):
    project = payload.get("project") or {}
    focus = normalize_chain_focus(payload.get("focus"))
    if not isinstance(project, dict) or not focus:
        return {"ok": False, "error": "typed focus and project are required"}
    digest_payload = build_chain_digest(project, focus, payload.get("history") or {})
    lines = [
        "You are Structa's grounded reasoning engine.",
        "Reason only from the typed digest below. Never use outside facts.",
        "Every produced node must cite evidence ids from the digest.",
        "Return strict JSON only.",
        "",
        json.dumps(digest_payload, ensure_ascii=False),
        "",
        "Return JSON with this shape:",
        "{",
        '  "focus": { "phase_next": "clarify", "state_next": "active" },',
        '  "produced": {',
        '    "claims": [{ "text": "...", "kind": "fact", "branchId": "main", "evidence": ["claim-id"] }],',
        '    "questions": [{ "body": "...", "meta": { "evidence_claims": ["claim-id"], "rationale": "..." } }],',
        '    "decisions": [{ "body": "...", "evidence": ["claim-id","claim-id"], "options": ["..."], "recommended": "..." }],',
        '    "tasks": [{ "body": "...", "evidence": ["claim-id"] }]',
        "  },",
        '  "step_metadata": { "rationale": "...", "confidence": 0.0 }',
        "}",
        "If signal is insufficient, return produced as empty arrays and note: \"insufficient_signal\".",
    ]
    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 22000,
            "priority": payload.get("policy", {}).get("priority", "low"),
        },
        "ui": {
            "summary": focus.get("phase") or "observe",
            "logLine": f"chain {focus.get('phase') or 'observe'}",
        },
        "meta": {
            "phase": focus.get("phase") or "observe",
            "focus": focus,
            "digest": digest_payload["digest"],
        },
    }


def chain_normalize(payload):
    focus = normalize_chain_focus(payload.get("focus"))
    if not focus:
        return {"ok": False, "error": "focus missing"}
    parsed = extract_json_block(payload.get("rawResponse") or "")
    if not isinstance(parsed, dict) or not parsed:
        return {
            "ok": True,
            "focus": {"phase_next": focus.get("phase") or "observe", "state_next": "active"},
            "produced": {"claims": [], "questions": [], "decisions": [], "tasks": []},
            "step_metadata": {"rationale": "insufficient signal", "confidence": 0.0, "model": "", "latencyMs": 0},
            "note": "insufficient_signal",
            "ui": {"summary": focus.get("phase") or "observe", "logLine": "chain insufficient signal"},
        }
    errors = validate_chain_response_shape(parsed)
    if errors:
        return {
            "ok": True,
            "focus": {"phase_next": focus.get("phase") or "observe", "state_next": "active"},
            "produced": {"claims": [], "questions": [], "decisions": [], "tasks": []},
            "step_metadata": {
                "rationale": compact("; ".join(errors), 180),
                "confidence": 0.0,
                "model": "",
                "latencyMs": 0,
            },
            "note": "insufficient_signal",
            "ui": {"summary": focus.get("phase") or "observe", "logLine": "chain invalid response"},
        }

    produced = parsed.get("produced") if isinstance(parsed.get("produced"), dict) else {}
    normalized = {
        "ok": True,
        "focus": {
            "phase_next": compact((parsed.get("focus") or {}).get("phase_next") or focus.get("phase") or "observe", 24).lower(),
            "state_next": compact((parsed.get("focus") or {}).get("state_next") or "active", 24).lower(),
        },
        "produced": {
            "claims": [{
                "text": compact(item.get("text") or "", 160),
                "kind": compact(item.get("kind") or "fact", 24).lower(),
                "branchId": compact(item.get("branchId") or focus.get("branchId") or "main", 48),
                "evidence": normalize_chain_evidence(item.get("evidence")),
                "source": "chain",
                "confidence": float(item.get("confidence") or 0.64),
            } for item in produced.get("claims") or [] if compact(item.get("text") or "", 160)],
            "questions": [{
                "id": compact(item.get("id") or "", 64),
                "body": soften_branch_prompt(item.get("body") or ""),
                "meta": {
                    "evidence_claims": normalize_chain_evidence((item.get("meta") or {}).get("evidence_claims")),
                    "rationale": compact((item.get("meta") or {}).get("rationale") or "", 180),
                    "priority": compact((item.get("meta") or {}).get("priority") or "normal", 24).lower(),
                    "branch_id": compact((item.get("meta") or {}).get("branch_id") or focus.get("branchId") or "main", 48),
                    "source": "chain",
                }
            } for item in produced.get("questions") or [] if compact(item.get("body") or "", 160)],
            "decisions": [{
                "id": compact(item.get("id") or "", 64),
                "body": compact(item.get("body") or "", 160),
                "evidence": normalize_chain_evidence(item.get("evidence")),
                "options": [compact(option, 48) for option in (item.get("options") or []) if compact(option, 48)],
                "recommended": compact(item.get("recommended") or "", 48),
            } for item in produced.get("decisions") or [] if compact(item.get("body") or "", 160)],
            "tasks": [{
                "id": compact(item.get("id") or "", 64),
                "body": compact(item.get("body") or "", 160),
                "evidence": normalize_chain_evidence(item.get("evidence")),
            } for item in produced.get("tasks") or [] if compact(item.get("body") or "", 160)],
        },
        "step_metadata": {
            "rationale": compact((parsed.get("step_metadata") or {}).get("rationale") or "", 220),
            "confidence": float((parsed.get("step_metadata") or {}).get("confidence") or 0.0),
            "model": compact((parsed.get("step_metadata") or {}).get("model") or "", 64),
            "latencyMs": int((parsed.get("step_metadata") or {}).get("latencyMs") or 0),
        },
        "note": compact(parsed.get("note") or "", 120),
        "ui": {
            "summary": compact((parsed.get("step_metadata") or {}).get("rationale") or focus.get("phase") or "chain step", 72),
            "logLine": "chain step",
        },
    }
    return normalized


def triangle_prepare(payload):
    project = payload.get("project") or {}
    item_a = payload.get("itemA") or {}
    item_b = payload.get("itemB") or {}
    angle = payload.get("angle") if isinstance(payload.get("angle"), dict) else {}
    branch_context = payload.get("branchContext") if isinstance(payload.get("branchContext"), dict) else {}
    claim_rows = normalize_triangle_claim_rows(payload)

    lines = [
        "You are Structa's constrained triangle reasoner.",
        "Reason only from the typed claim graph below.",
        "Every derived claim must cite at least two parent ids from the parent set.",
        "If the bridge is weak or ambiguous, return an ambiguity question instead of forcing a synthesis.",
        "Return strict JSON only.",
        "",
        json.dumps({
            "project": {
                "name": project.get("name") or "",
                "type": project.get("type") or "",
                "summary": compact(project.get("summary") or "", 240),
            },
            "branchContext": {
                "id": compact(branch_context.get("id") or "main", 48),
                "name": compact(branch_context.get("name") or "main", 48),
                "parentBranchId": compact(branch_context.get("parentBranchId") or "", 48),
            },
            "itemA": {
                "itemId": compact(item_a.get("itemId") or "", 64),
                "claimIds": [claim_entry["id"] for claim_entry in claim_rows[0]["claims"]],
                "claims": claim_rows[0]["claims"],
            },
            "itemB": {
                "itemId": compact(item_b.get("itemId") or "", 64),
                "claimIds": [claim_entry["id"] for claim_entry in claim_rows[1]["claims"]],
                "claims": claim_rows[1]["claims"],
            },
            "angle": {
                "text": compact(angle.get("text") or "", 280),
                "sttConfidence": float(angle.get("sttConfidence") or 0.0),
            },
        }, ensure_ascii=False),
        "",
        "Return JSON with this shape:",
        "{",
        '  "status": "synthesized" | "ambiguous",',
        '  "title": "...",',
        '  "branchId": "main",',
        '  "derived_claims": [{ "text": "...", "kind": "fact", "branchId": "main", "evidence": ["claim-id-a","claim-id-b"] }],',
        '  "unresolved_tensions": [{ "between": ["claim-id-a","claim-id-b"], "note": "..." }],',
        '  "question": { "body": "...", "meta": { "evidence_claims": ["claim-id-a","claim-id-b"], "rationale": "..." } },',
        '  "step_metadata": { "confidence": 0.0 }',
        "}",
        "When status is ambiguous, derived_claims must be empty and question must be present.",
        "Do not return any body field or free-form prose summary."
    ]

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 25000,
            "priority": payload.get("policy", {}).get("priority", "high"),
        },
        "ui": {"summary": "triangle ready", "logLine": "triangle synthesizing"},
        "meta": {"kind": "triangle", "parent_ids": normalize_triangle_parent_ids(payload)},
    }


def triangle_normalize(payload):
    parsed = extract_json_block(payload.get("rawResponse") or "")
    if not isinstance(parsed, dict) or not parsed:
        parsed = {}
    errors = validate_triangle_response_shape(parsed) if parsed else ["triangle:invalid response"]
    parent_ids = normalize_triangle_parent_ids(payload)

    if errors:
        return {"ok": False, "error": "; ".join(errors)}

    status = compact(parsed.get("status") or "ambiguous", 24).lower()
    if status == "synthesized":
        derived_claims = []
        for item in parsed.get("derived_claims") or []:
            evidence = normalize_chain_evidence(item.get("evidence"))
            if len(evidence) < 2:
                continue
            derived_claims.append({
                "text": compact(item.get("text") or "", 160),
                "kind": compact(item.get("kind") or "fact", 24).lower(),
                "branchId": compact(item.get("branchId") or (payload.get("branchContext") or {}).get("id") or "main", 48),
                "evidence": evidence,
                "source": "triangle",
                "confidence": float(item.get("confidence") or 0.72),
            })
        if not derived_claims:
            status = "ambiguous"
            parsed["question"] = parsed.get("question") or {
                "body": "which connection matters most here?",
                "meta": {
                    "evidence_claims": parent_ids[:2],
                    "rationale": "triangle lacked enough grounded overlap",
                }
            }
        else:
            tensions = []
            for entry in parsed.get("unresolved_tensions") or []:
                between = normalize_chain_evidence(entry.get("between"))[:2]
                if len(between) == 2:
                    tensions.append({
                        "between": between,
                        "note": compact(entry.get("note") or "", 120),
                    })
            return {
                "ok": True,
                "status": "synthesized",
                "title": compact(parsed.get("title") or "triangle signal", 72),
                "branchId": compact(parsed.get("branchId") or (payload.get("branchContext") or {}).get("id") or "main", 48),
                "derived_claims": derived_claims,
                "unresolved_tensions": tensions,
                "step_metadata": {
                    "confidence": float((parsed.get("step_metadata") or {}).get("confidence") or 0.0),
                    "latencyMs": int((parsed.get("step_metadata") or {}).get("latencyMs") or 0),
                    "model": compact((parsed.get("step_metadata") or {}).get("model") or "", 64),
                },
                "ui": {"summary": compact(parsed.get("title") or "triangle signal", 72), "logLine": "triangle ready"},
                "meta": {"kind": "triangle"},
            }

    question = parsed.get("question") if isinstance(parsed.get("question"), dict) else {}
    meta = question.get("meta") if isinstance(question.get("meta"), dict) else {}
    return {
        "ok": True,
        "status": "ambiguous",
        "question": {
            "body": compact(question.get("body") or "which connection matters most here?", 160),
            "meta": {
                "evidence_claims": normalize_chain_evidence(meta.get("evidence_claims"))[:4] or parent_ids[:2],
                "rationale": compact(meta.get("rationale") or "triangle stayed ambiguous", 180),
                "priority": "normal",
                "branch_id": compact((payload.get("branchContext") or {}).get("id") or "main", 48),
                "source": "triangle",
            }
        },
        "step_metadata": {
            "confidence": float((parsed.get("step_metadata") or {}).get("confidence") or 0.0),
            "latencyMs": int((parsed.get("step_metadata") or {}).get("latencyMs") or 0),
            "model": compact((parsed.get("step_metadata") or {}).get("model") or "", 64),
        },
        "ui": {"summary": compact(question.get("body") or "triangle stayed ambiguous", 72), "logLine": "triangle ambiguous"},
        "meta": {"kind": "triangle"},
    }


def thread_refine_prepare(payload):
    project = payload.get("project") or {}
    selection = payload.get("selection") or {}
    input_data = payload.get("input") or {}
    transcript = compact(input_data.get("transcript") or "", 240)

    lines = [
        "You are Structa, extracting knowledge from one project comment.",
        "Return labeled lines only. No prose outside the labels.",
        "Keep the user's intent grounded in the current item.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    selection_lines = build_selection_lines(selection)
    if selection_lines:
        lines.extend(["", "ITEM"] + selection_lines)

    lines.extend([
        "",
        "COMMENT",
        transcript,
        "",
        "Return exactly:",
        "SUMMARY: <one line, max 8 words>",
        "CLAIM1: <claim or omit>",
        "CLAIM2: <claim or omit>",
        "CLAIM3: <claim or omit>",
        "CLARIFIES: <claim id or omit>",
        "CONTRADICTS: <claim id or omit>",
    ])

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 12000,
            "priority": payload.get("policy", {}).get("priority", "low"),
        },
        "ui": {
            "summary": "comment refining",
            "logLine": "comment refining",
        },
        "meta": {
            "kind": "thread-refine",
        },
    }


def thread_refine_normalize(payload):
    raw_text = payload.get("rawResponse") or ""
    raw = compact(raw_text, 160).lower()
    parsed = parse_labeled_lines(raw_text)
    selection = payload.get("selection") or {}
    transcript = compact(((payload.get("input") or {}).get("transcript") or ""), 72)
    selection_hint = compact(selection.get("summary") or selection.get("body") or "", 72)
    summary = compact(parsed.get("SUMMARY") or raw or transcript or selection_hint or "comment captured", 72)
    source_ref = payload.get("sourceRef") or {"itemId": selection.get("id") or ""}
    claims = extract_simple_claims(
        [parsed.get("CLAIM1", ""), parsed.get("CLAIM2", ""), parsed.get("CLAIM3", "")],
        "comment",
        source_ref=source_ref,
        stt_confidence=estimate_stt_confidence((payload.get("input") or {}).get("transcript") or ""),
    )
    clarifies = compact(parsed.get("CLARIFIES") or "", 48)
    contradicts = compact(parsed.get("CONTRADICTS") or "", 48)
    return {
        "ok": True,
        "summary": summary,
        "claims": claims,
        "clarifies": clarifies or "",
        "contradicts": contradicts or "",
        "ui": {
            "summary": summary,
            "logLine": "comment refined",
        },
        "meta": {
            "kind": "thread-refine",
        },
    }


def claims_backfill_prepare(payload):
    project = payload.get("project") or {}
    body = compact(payload.get("body") or ((payload.get("selection") or {}).get("body")) or "", 320)
    lines = [
        "Extract up to three concrete project claims.",
        "Return only labeled lines. No prose.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    lines.extend([
        "",
        "ITEM",
        body or "unknown item",
        "",
        "Return exactly:",
        "CLAIM1: <claim or omit>",
        "CLAIM2: <claim or omit>",
        "CLAIM3: <claim or omit>",
    ])
    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 18000,
            "priority": payload.get("policy", {}).get("priority", "low"),
        },
        "ui": {
            "summary": "claim backfill",
            "logLine": "claims backfill",
        },
        "meta": {
            "kind": "claims-backfill",
        },
    }


def claims_backfill_normalize(payload):
    raw = payload.get("rawResponse") or ""
    parsed = parse_labeled_lines(raw)
    source_ref = payload.get("sourceRef") or {}
    claims = extract_simple_claims(
        [parsed.get("CLAIM1", ""), parsed.get("CLAIM2", ""), parsed.get("CLAIM3", "")],
        payload.get("source") or "backfill",
        source_ref=source_ref,
    )
    return {
        "ok": True,
        "claims": claims,
        "ui": {
            "summary": f"{len(claims)} claims",
            "logLine": "claims backfilled",
        },
        "meta": {
            "kind": "claims-backfill",
        },
    }


def project_title_prepare(payload):
    transcript = compact(payload.get("transcript") or ((payload.get("input") or {}).get("transcript")) or "", 240)
    project = payload.get("project") or {}
    lines = [
        "You are Structa, naming a new project from the user's first words.",
        "Return only a 2-3 word lowercase title that captures the project's subject.",
        "No explanation, no quotes, no punctuation, no trailing period.",
        "If the transcript is unusable, return: untitled project",
        "",
        "TRANSCRIPT:",
        transcript,
    ] + build_project_lines(project)
    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 3000,
            "priority": payload.get("policy", {}).get("priority", "high"),
        },
        "ui": {
            "summary": "project title",
            "logLine": "naming project",
        },
        "meta": {
            "kind": "project-title",
        },
    }


def project_title_normalize(payload):
    raw = compact(payload.get("rawResponse") or "", 64).lower()
    cleaned = "".join(ch if (ch.isalnum() or ch.isspace()) else " " for ch in raw)
    cleaned = " ".join(cleaned.split())
    for prefix in ("title ", "project about ", "project ", "this is about ", "this is ", "about ", "name ", "called "):
        if cleaned.startswith(prefix):
            cleaned = cleaned[len(prefix):].strip()
    words = cleaned.split()[:3]
    title = " ".join(words).strip() or "untitled project"
    return {"ok": True, "title": title}


class StructaHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def log_message(self, format, *args):
        print(f"127.0.0.1 - - [{self.log_date_time_string()}] {format % args}")

    def send_json(self, status, data):
        body = json.dumps(data or {}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/__structa_asset/"):
            parts = parsed.path.split("/", 3)
            if len(parts) < 4:
                self.send_json(404, {"ok": False, "error": "asset path missing"})
                return
            relative_path = parts[3].lstrip("/")
            root = pathlib.Path(os.getcwd()).resolve()
            target = (root / relative_path).resolve()
            if target != root and root not in target.parents:
                self.send_json(403, {"ok": False, "error": "asset path denied"})
                return
            if not target.is_file():
                self.send_json(404, {"ok": False, "error": "asset not found"})
                return
            try:
                body = target.read_bytes()
            except Exception as err:
                self.send_json(500, {"ok": False, "error": str(err)})
                return
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(target)))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/healthz":
            self.send_json(200, {
                "ok": True,
                "server_time": int(time.time()),
            })
            return
        if parsed.path == "/buildinfo":
            self.send_json(200, {
                "ok": True,
                "sha": BUILD_SHA,
                "built_at": BUILD_AT,
                "endpoints": [
                    "/healthz",
                    "/buildinfo",
                    "/v1/diagnostic/echo",
                    "/v1/voice/interpret",
                    "/v1/image/context_prompt",
                    "/v1/image/analyze",
                    "/v1/claims/extract_from_text",
                    "/v1/claims/backfill",
                    "/v1/chain/digest_preview",
                    "/v1/chain/step",
                    "/v1/triangle/synthesize",
                    "/v1/thread/extract",
                    "/v1/project/title",
                ],
            })
            return
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        payload = self.read_json()
        if payload is None:
            self.send_json(400, {"ok": False, "error": "invalid json body"})
            return
        if parsed.path == "/v1/diagnostic/echo":
            self.send_json(200, {
                "ok": True,
                "echo": payload,
                "server_time": int(time.time()),
            })
            return
        if parsed.path == "/v1/thread/refine":
            self.send_json(410, {"ok": False, "error": "thread refine retired", "redirect": "/v1/thread/extract"})
            return
        if parsed.path == "/v1/chain/digest_preview":
            debug_enabled = "debug=1" in (parsed.query or "") or bool(payload.get("debug"))
            focus = normalize_chain_focus(payload.get("focus"))
            if not debug_enabled:
                self.send_json(403, {"ok": False, "error": "digest preview requires debug=1"})
                return
            if not isinstance(payload.get("project"), dict) or not focus:
                self.send_json(400, {"ok": False, "error": "typed focus and project are required"})
                return
            self.send_json(200, {"ok": True, **build_chain_digest(payload.get("project") or {}, focus, payload.get("history") or {})})
            return
        if parsed.path == "/v1/image/context_prompt":
            project = payload.get("project")
            if not isinstance(project, dict):
                self.send_json(400, {"ok": False, "error": "project is required"})
                return
            input_data = payload.get("input") or {}
            meta = payload.get("meta") or {}
            self.send_json(200, {
                "ok": True,
                "prompt": build_image_prompt(project, input_data, meta),
                "ui": {"summary": "bridge image prompt", "logLine": "image prompt ready"},
                "meta": {"kind": "image-context-prompt"},
            })
            return
        if parsed.path == "/v1/claims/extract_from_text":
            if not claims_extract_allowed(payload):
                self.send_json(429, {"ok": False, "error": "claims extraction rate limited"})
                return
            self.send_json(200, extract_claims_from_text(payload))
            return

        handlers = {
            "/v1/voice/interpret": (voice_prepare, voice_normalize),
            "/v1/image/analyze": (image_prepare, image_normalize),
            "/v1/chain/step": (chain_prepare, chain_normalize),
            "/v1/triangle/synthesize": (triangle_prepare, triangle_normalize),
            "/v1/thread/extract": (thread_refine_prepare, thread_refine_normalize),
            "/v1/claims/backfill": (claims_backfill_prepare, claims_backfill_normalize),
            "/v1/project/title": (project_title_prepare, project_title_normalize),
        }
        handler = handlers.get(parsed.path)
        if not handler:
            self.send_json(404, {"ok": False, "error": "unknown endpoint"})
            return

        try:
            if payload.get("rawResponse") is not None:
                data = handler[1](payload)
            else:
                data = handler[0](payload)
            self.send_json(200, data)
        except Exception as err:
            self.send_json(500, {"ok": False, "error": str(err)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), StructaHandler)
    print(f"Serving Structa on 0.0.0.0 port {port} (http://0.0.0.0:{port}/) ...")
    server.serve_forever()
