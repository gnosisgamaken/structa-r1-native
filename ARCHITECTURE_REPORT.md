# Structa R1 — Architecture Report & AI Harnessing Design

**Date:** April 14, 2026
**Base:** `bb1014a` (known-good render)
**Author:** Senior audit, Pedro's request

---

## 1. HARSH AUDIT OF THE OPUS REPORT

The OPUS_HARSH_AUDIT.md got **two things wrong**:

1. **"DOM/SVG binding break"** — False. All 6 core files are byte-identical
   between HEAD and bb1014a. The break was caused by Replit Agent rewriting
   index.html locally, not by any code change we made.

2. **"Dependency on dead code"** — Partially false. The heartbeat, contracts,
   validation, context-router, and probe modules are loaded but their absence
   does NOT break rendering. `rabbit-adapter.js` uses `?.` optional chaining
   on all of them. The cascade never imports any of them directly.

**What the OPUS report got right:**
- The heartbeat concept (autonomous pulsing) is architecturally sound
- Storage needs multi-tier fallback (creationStorage → IndexedDB → localStorage)
- The contract envelope structure is useful for LLM prompt shaping

---

## 2. WHAT EXISTS AND WHAT'S DEAD

### Active Code (renders the app)

| File | Lines | Role |
|------|-------|------|
| `index.html` | 507 | SVG viewport, CSS, overlays, script loading |
| `structa-cascade.js` | 1532 | State machine, SVG rendering, all surfaces |
| `js/camera-capture.js` | 285 | getUserMedia, capture, stream management |
| `js/voice-capture.js` | 394 | STT transcription, voice state |
| `js/r1-llm.js` | 337 | LLM bridge (PluginMessageHandler) |
| `js/rabbit-adapter.js` | 659 | Project memory, log, decisions, persistence |
| `package.json` | 1 | Replit serve config |

**Total active:** 3715 lines

### Loaded But Functionally Dead

| File | Lines | Why Dead |
|------|-------|----------|
| `js/contracts.js` | 87 | Called by rabbit-adapter via `?.` but creates envelopes nobody reads. The LLM never sees structured contracts — it gets raw text via `buildLLMMessage()`. |
| `js/validation.js` | 81 | Validates contracts before store, but validation failures just emit events that nobody handles. No UI shows validation errors. |
| `js/capture-bundles.js` | 40 | Builds bundles from contracts+validation. camera-capture.js calls `StructaCaptureBundle?.build()` — optional, so skipping it means no bundle stored, just a log entry. |
| `js/context-router.js` | 185 | Routes context between surfaces. rabbit-adapter calls `router?.routeAction?.()` — returns undefined, silently skipped. No effect on rendering or behavior. |
| `js/heartbeat.js` | 127 | Has `start(bph)` but `start()` is never called. `maybeStartHeartbeat()` in cascade checks `window.StructaHeartbeat?.bpm` — always 0, so it never starts. |
| `js/rabbit-runtime-probe.js` | 127 | Probes R1 APIs at startup, emits probe events. rabbit-adapter appends them to logs. No UI renders probe data. Pure noise. |
| `structa-cascade-v0.5.js` | ??? | Ancient backup of pre-state-machine code. Never loaded. |

**Total dead:** 647 lines loaded + 1 backup file

### Documentation (14 files)

| File | Status |
|------|--------|
| `STRUCTA_R1_NATIVE_SPEC_V0_7.md` | DELETE — superseded by v1.1 |
| `STRUCTA_R1_NATIVE_SPEC_V0_8.md` | DELETE — superseded by v1.1 |
| `STRUCTA_R1_NATIVE_SPEC_V0_9.md` | DELETE — superseded by v1.1 |
| `STRUCTA_R1_NATIVE_SPEC_V1_0.md` | DELETE — superseded by v1.1 |
| `STRUCTA_R1_NATIVE_SPEC_V1_1.md` | KEEP — current spec |
| `STRUCTA_R1_NATIVE_ARCHITECTURE_BRIEF_V2.md` | KEEP — architecture reference |
| `STRUCTA_R1_NATIVE_IMPLEMENTATION_PLAN_V1.md` | KEEP — implementation plan |
| `STRUCTA_R1_INTERACTION_SPEC_V1.md` | KEEP — interaction patterns |
| `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md` | KEEP — launch checklist |
| `STRUCTA_DEPLOYMENT_READINESS_AUDIT.md` | KEEP — deployment audit |
| `STRUCTA_USER_JOURNEY_AND_DEVICE_QA.md` | KEEP — QA reference |
| `STRUCTA_V2_ENGINEERING_DESIGN.md` | KEEP — engineering spec |
| `STRUCTA_V2_UX_DESIGN.md` | KEEP — UX spec |
| `OPUS_HARSH_AUDIT.md` | DELETE — replaced by this report |
| `replit.md` | KEEP — Replit notes |
| `docs/` folder | KEEP — research + plans |

---

## 3. AI HARNESSING ARCHITECTURE

### 3.1 The Impact Chain

The core idea: every 15 seconds, Structa autonomously thinks about the project.
Each "impact" is a self-contained LLM call that:

1. Reads the current project context (from StructaNative)
2. Decides: research more, or create a decision for the user
3. Stores the result tagged for the next chain step
4. Updates the NOW card with the latest impact

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ IMPACT 1 │───│ IMPACT 2 │───│ IMPACT 3 │───│ DECISION │
│ observe  │   │ research │   │ evaluate │   │ for user │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
   15s            15s            15s            immediate
```

Each impact stores:
- `impact_id`: unique ID (timestamp + sequence)
- `chain_index`: position in chain (1, 2, 3...)
- `parent_id`: previous impact's ID (or null for first)
- `type`: "observe" | "research" | "evaluate" | "decision"
- `verb`: the Structa verb used (inspect, research, decide...)
- `input`: what context was fed to the LLM
- `output`: what the LLM returned
- `tags`: searchable tags (project domain, topic, urgency)
- `created_at`: timestamp

### 3.2 The Self-Prompting Contract

Each LLM call uses a strict prompt template. The R1 LLM is unreliable with
vague instructions. We use the ULTIMATE_R1_CREATIONS_GUIDE.md patterns:

**Observe prompt:**
```
🚫 DO NOT SEARCH. DO NOT SAVE NOTES. DO NOT CREATE REMINDERS.
You are Structa, a project cognition system. You ONLY process what you are given.

[CONTEXT]
Project: {name}
Captures: {capture_count} | Insights: {insight_count} | Open: {open_count}
Recent: {last_3_log_entries}
Last Impact: {previous_impact_summary}

[TASK]
In exactly 5 words, state what is most missing from this project right now.
```

**Research prompt (if observe found a gap):**
```
🚫 DO NOT SEARCH. DO NOT SAVE NOTES.
You are Structa. Based on the observation "{observation}", formulate ONE specific
question that would resolve this gap. Return ONLY the question, nothing else.
```

**Decision prompt (after 3 research impacts):**
```
🚫 DO NOT SEARCH. DO NOT SAVE NOTES.
You are Structa. Based on these impacts:
1. {impact_1_output}
2. {impact_2_output}
3. {impact_3_output}

Create a decision for the user with exactly 3 options.
Format: JSON only. {"decision": "...", "options": ["...", "...", "..."]}
```

### 3.3 The Heartbeat Engine

Replaces the old `heartbeat.js` with a purpose-built Impact Chain engine.

**Configuration:**
- Default BPM: 4 (one beat every 15 seconds)
- Max LLM calls per chain: 4 (observe → research → research → decision)
- Chain cooldown: 60s after a decision is created (let user respond)
- Auto-pause: after 5 minutes of no user interaction
- Resume: on any hardware event (sideClick, longPress, scroll)

**State:**
```javascript
const chain = {
  active: false,
  bpm: 4,                    // beats per minute (4 = every 15s)
  beatCount: 0,
  impacts: [],               // stored impact chain
  currentPhase: 'idle',      // idle | observe | research | evaluate | decision | cooldown
  lastDecisionAt: null,
  lastUserActivity: Date.now(),
  maxImpactsPerChain: 3,     // observe + research × N before decision
  cooldownMs: 60000          // 60s cooldown after decision
};
```

**Beat flow:**
```
beat()
  ├─ check: user active in last 5 min? → if no, pause
  ├─ check: in cooldown? → skip
  ├─ phase = observe? → callLLM(observe_prompt) → store impact → phase = research
  ├─ phase = research? → callLLM(research_prompt) → store impact → increment chain
  ├─ chain >= maxImpacts? → phase = decision → callLLM(decision_prompt) → create NOW decision
  └─ after decision → phase = cooldown, start 60s timer
```

### 3.4 Storage Architecture

All impacts stored in `StructaNative.projectMemory` under a new `impacts` array.
Each impact is tagged with:

```javascript
{
  impact_id: '20260414-031500-obs-001',
  chain_index: 1,
  parent_id: null,
  type: 'observe',
  verb: 'inspect',
  input: 'Project: Atlas. Captures: 3...',
  output: 'missing competitor analysis',
  tags: ['atlas', 'strategy', 'gap'],
  created_at: '2026-04-14T03:15:00Z'
}
```

The `tags` field is generated by a simple keyword extraction from the LLM output.
No NLP needed — just split on spaces, remove stop words, keep top 3 nouns.

### 3.5 Maximalist R1 Layout for Impact Chain

The NOW card becomes the primary view for the impact chain:

```
┌──────────────────────────────┐
│  ATLAS                    ←  │  ← project name (32px)
│  ─────────────────────────── │
│  ● observing...              │  ← chain phase indicator (18px)
│  "missing competitor         │  ← last impact text (14px)
│   analysis"                  │
│  ─────────────────────────── │
│  impact 2/3                  │  ← chain progress (10px)
│  ▓▓▓▓░░░                    │  ← progress bar
│  ─────────────────────────── │
│  ┌─ DECISION ─────────────┐ │  ← when decision arrives
│  │ hire or skip qa?       │ │  ← 18px decision text
│  │                        │ │
│  │ ✓ option a   □ option b│ │  ← 3 options as pills
│  │ □ option c             │ │
│  └────────────────────────┘ │
│  ─────────────────────────── │
│  3 caps · 2 insights · 1 ask │  ← stats (10px)
└──────────────────────────────┘
```

When the chain is running, the NOW card shows live impact status.
When a decision arrives, it expands to fill the card with 3 options.
Side button = approve option A. Scroll = cycle options. Long press = skip.

---

## 4. CLEANUP PLAN

### Delete from repo (dead code):
- `structa-cascade-v0.5.js` — ancient backup
- `STRUCTA_R1_NATIVE_SPEC_V0_7.md` through `V1_0.md` — superseded
- `OPUS_HARSH_AUDIT.md` — replaced by this report

### Keep but refactor (has useful structure):
- `js/contracts.js` — the envelope schema is good, but the `allowedVerbs`
  and `allowedTargets` lists need updating for the impact chain
- `js/validation.js` — the validation pattern is sound, but needs to
  validate impact payloads, not just envelopes
- `js/heartbeat.js` — will be replaced by impact-chain-engine.js
- `js/context-router.js` — the context routing concept is needed for
  impact chain, but the current implementation is disconnected
- `js/rabbit-adapter.js` — core data layer, keep and extend with
  impact storage

### Delete from repo (truly useless):
- `js/capture-bundles.js` — wraps contracts+validation, nobody needs it
- `js/rabbit-runtime-probe.js` — fills logs with noise

### Script loading order after cleanup:
```html
<script src="js/rabbit-adapter.js"></script>
<script src="js/r1-llm.js"></script>
<script src="js/camera-capture.js"></script>
<script src="js/voice-capture.js"></script>
<script src="js/impact-chain-engine.js"></script>  <!-- NEW -->
<script src="structa-cascade.js"></script>
```

---

## 5. IMPLEMENTATION PRIORITY

1. **Clean up deprecated files** — remove dead code, old specs, old audit
2. **Build impact-chain-engine.js** — the heartbeat + self-prompting + storage
3. **Update NOW card rendering** — maximalist layout for impact chain
4. **Wire chain to state machine** — new CHAIN_OBSERVE/CHAIN_RESEARCH states
5. **Test on R1 hardware** — side button approves, scroll cycles, back exits

---

## 6. WHAT THE ULTIMATE GUIDE TELLS US

Key patterns from ULTIMATE_R1_CREATIONS_GUIDE.md:

1. **LLM calls need strong prompt guardrails** — "🚫 DO NOT SEARCH" prefix
   prevents the R1 LLM from going off-script. This is critical for impact
   chain prompts.

2. **Storage MUST use multi-tier fallback** — creationStorage → IndexedDB →
   localStorage. The current rabbit-adapter only uses localStorage. We need
   IndexedDB for impact chain data (can be large).

3. **Camera max 640×480** — for Rabbithole sync. Already implemented.

4. **TTS cannot be stopped once started** — ~50ms per character. We can use
   TTS sparingly: only when a decision is created, speak "new decision ready".

5. **Side button is the most reliable input** — the impact chain should be
   fully navigable with side button + scroll only.

6. **`wantsR1Response: false`** — all impact chain LLM calls must use this.
   We don't want the R1 speaking intermediate research results out loud.

---

*End of report. Ready to implement.*
