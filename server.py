#!/usr/bin/env python3
import http.server
import json
import os
from urllib.parse import urlparse


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
    annotation = compact(input_data.get("transcript") or "", 220)
    image_base64 = input_data.get("imageBase64") or ""
    image_id = compact(input_data.get("imageId") or ((payload.get("meta") or {}).get("imageId")) or "", 80)
    image_ref = input_data.get("imageRef") or ""
    meta = payload.get("meta") or {}

    lines = [
        "Analyze this image for Structa.",
        "Use only the image, project context, and optional annotation.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    lines.extend([
        "",
        "CAPTURE",
        f"camera: {meta.get('facingMode', 'environment')}",
        f"image id: {image_id or 'unknown'}",
        f"image ref: {image_ref or 'inline capture'}",
    ])
    if annotation:
        lines.append(f"annotation: {annotation}")

    lines.extend([
        "",
        "Return exactly these lines:",
        "FACTS: <factual visible description only>",
        "SIGNAL: <project-relevant meaning only>",
        "NEXT: <one short next step>",
    ])

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
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
        return {"ok": False, "error": "; ".join(errors)}

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
    point_a = payload.get("pointA") or {}
    point_b = payload.get("pointB") or {}
    angle = compact((payload.get("input") or {}).get("angle") or "", 280)
    image_data = (point_b.get("imageBase64") or point_a.get("imageBase64") or "")

    lines = [
        "You are Structa, a precision tool for extracting derived insight.",
        "The user has triangulated three inputs and is asking you to synthesize them into one sharp signal.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    lines.extend([
        "",
        f"POINT A — {point_a.get('type', 'context')} · {point_a.get('time', 'recent')}",
        compact(point_a.get("body") or "", 220),
        "",
        f"POINT B — {point_b.get('type', 'context')} · {point_b.get('time', 'recent')}",
        compact(point_b.get("body") or "", 220),
        "",
        "ANGLE",
        angle,
        "",
        "Return exactly:",
        "SIGNAL: <one sentence, max 18 words>",
        "QUESTION: <optional follow-up, max 12 words>",
    ])

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "imageBase64": image_data,
            "timeout": 25000,
            "priority": payload.get("policy", {}).get("priority", "high"),
        },
        "ui": {"summary": "triangle ready", "logLine": "triangle synthesizing"},
        "meta": {"kind": "triangle"},
    }


def triangle_normalize(payload):
    raw = payload.get("rawResponse") or ""
    parsed = parse_labeled_lines(raw)
    signal = parsed.get("SIGNAL") or compact(raw, 120)
    question = parsed.get("QUESTION", "")
    artifacts = [artifact("signal", signal, title="triangle signal", source="triangle")]
    if question:
        artifacts.append(artifact("question", question, title="triangle follow up", source="triangle"))
    claims = [claim(signal, kind="fact", source="triangle", confidence=0.7)]
    if question:
        claims.append(claim(question, kind="question", source="triangle", confidence=0.62))
    return {
        "ok": True,
        "artifacts": artifacts,
        "claims": claims,
        "ui": {"summary": signal, "logLine": "triangle ready"},
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
    summary = compact(parsed.get("SUMMARY") or raw or "", 72)
    selection = payload.get("selection") or {}
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

    def do_POST(self):
        parsed = urlparse(self.path)
        payload = self.read_json()
        if payload is None:
            self.send_json(400, {"ok": False, "error": "invalid json body"})
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
