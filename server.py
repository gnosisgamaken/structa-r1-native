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


def chain_prepare(payload):
    project = payload.get("project") or {}
    phase = (payload.get("phase") or "observe").strip().lower()
    context = compact(payload.get("contextSummary") or project.get("summary") or "", 600)
    recent = payload.get("recentArtifacts") or []
    blockers = payload.get("blockers") or {}

    lines = [
        "You are Structa's chain engine.",
        "Work only from the supplied project state.",
        "",
        "PROJECT",
    ] + build_project_lines(project)

    if context:
        lines.extend(["", "CONTEXT", context])

    if blockers:
        blocker_bits = []
        if blockers.get("pendingCount"):
            blocker_bits.append(f"pending decisions: {blockers['pendingCount']}")
        if blockers.get("questionCount"):
            blocker_bits.append(f"open questions: {blockers['questionCount']}")
        if blocker_bits:
            lines.extend(["", "BLOCKERS", " | ".join(blocker_bits)])

    if recent:
        lines.extend(["", "RECENT IMPACTS"])
        for item in recent[:4]:
            lines.append("- " + compact(item.get("output") or item.get("body") or "", 120))

    if payload.get("discoveryMode"):
        lines.extend([
            "",
            "Return exactly:",
            "QUESTION: <one calm branch-opening prompt, max 12 words>",
            "Tone: guiding, project-building, never harsh.",
            "Avoid asking for specific help.",
            "Prefer prompts about what matters first, what needs a place, or where this begins.",
        ])
    elif phase == "observe":
        lines.extend([
            "",
            "Return exactly:",
            "OBSERVE: <five to eight words describing what is most missing>",
        ])
    elif phase == "clarify":
        lines.extend([
            "",
            "Return exactly:",
            "CLARIFY: <one short clarification angle, max 8 words>",
        ])
    else:
        lines.extend([
            "",
            "Return either:",
            "DECISION: <one decision, max 10 words>",
            "OPTIONS: <option one> | <option two> | <option three>",
            "",
            "or:",
            "CLARIFY: <one short clarification angle, max 8 words>",
        ])

    return {
        "ok": True,
        "llm": {
            "prompt": "\n".join(lines),
            "timeout": 24000 if phase == "evaluate" else 20000,
            "priority": payload.get("policy", {}).get("priority", "low"),
        },
        "ui": {
            "summary": phase,
            "logLine": f"chain {phase}",
        },
        "meta": {
            "phase": phase,
            "discoveryMode": bool(payload.get("discoveryMode")),
        },
    }


def chain_normalize(payload):
    raw = payload.get("rawResponse") or ""
    parsed = parse_labeled_lines(raw)
    if payload.get("discoveryMode"):
        question = soften_branch_prompt(parsed.get("QUESTION") or compact(raw, 120))
        return {
            "ok": True,
            "artifacts": [artifact("question", question, title="structa asks", source="chain")],
            "claims": [claim(question, kind="question", source="chain", confidence=0.62)],
            "ui": {"summary": question, "logLine": "discovery question"},
            "meta": {"action": "discovery", "phase": "cooldown"},
        }
    if parsed.get("DECISION"):
        options = [compact(opt, 36) for opt in parsed.get("OPTIONS", "").split("|") if opt.strip()]
        return {
            "ok": True,
            "artifacts": [artifact("decision", parsed["DECISION"], title=parsed["DECISION"], source="chain", options=options)],
            "claims": [claim(parsed["DECISION"], kind="intent", source="chain", confidence=0.64)],
            "ui": {"summary": parsed["DECISION"], "logLine": "decision ready"},
            "meta": {"action": "decision", "phase": "cooldown"},
        }
    if parsed.get("CLARIFY"):
        return {
            "ok": True,
            "artifacts": [artifact("signal", parsed["CLARIFY"], source="chain")],
            "claims": [claim(parsed["CLARIFY"], kind="question", source="chain", confidence=0.6)],
            "ui": {"summary": parsed["CLARIFY"], "logLine": "clarify"},
            "meta": {"action": "clarify", "phase": "clarify"},
        }
    observe = parsed.get("OBSERVE") or compact(raw, 120)
    return {
        "ok": True,
        "artifacts": [artifact("signal", observe, source="chain")],
        "claims": [claim(observe, kind="fact", source="chain", confidence=0.6)],
        "ui": {"summary": observe, "logLine": "observe"},
        "meta": {"action": "observe", "phase": "clarify"},
    }


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
