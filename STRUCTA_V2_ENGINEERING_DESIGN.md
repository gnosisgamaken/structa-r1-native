# Structa V2 — State Machine & Agent Architecture

## 1. Formal State Machine

### 1.1 States

```
HOME
SHOW_PRIMED → CAMERA_OPEN → CAMERA_CAPTURE → HOME
TELL_PRIMED → VOICE_OPEN → VOICE_PROCESSING → HOME
KNOW_BROWSE → KNOW_DETAIL → KNOW_BROWSE
KNOW_ANSWER → VOICE_OPEN (reuse, with answeringQuestion set) → KNOW_BROWSE
NOW_BROWSE → NOW_DECISION → NOW_BROWSE
NOW_BLOCKER → NOW_BROWSE
LOG_OPEN → HOME
```

No more SHOW_HINT or TELL_HINT states. Those were the source of the broken camera UX. Instead: single tap and PTT both go directly to the capture surface. The "primed" states exist purely for pre-warming getUserMedia (invisible to user, ~200ms).

### 1.2 State Definition Table

Each state has:
- `enter()`: actions on entry
- `exit()`: actions on exit
- `render()`: what's drawn
- `handlers`: which hardware inputs are active and what they do

#### HOME

| Property | Value |
|----------|-------|
| enter() | Start heartbeat if project has content. Render 4-card stack. |
| exit() | Cancel any pending notification animations. |
| render() | Wordmark, 4 cards (hero at scale 1.5, stack at 0.50/0.69/0.92), log drawer preview, notification dots on KNOW/NOW. |
| scroll↓ | next card (cycle: show→tell→know→now→show) |
| scroll↑ | prev card |
| tap hero | Open card's primary surface (SHOW→camera, TELL→voice, KNOW→browse, NOW→browse) |
| tap stack | Select that card as hero (just changes selection, no surface open) |
| PTT down | If hero=SHOW: open camera. If hero=TELL: open voice. Otherwise: ignore. |
| PTT up | If in capture: execute capture (camera) or stop listening (voice). |
| back | Close app (let Rabbit OS handle it). Only state where back closes app. |
| long-press | No-op on home (was causing confusion). |

#### SHOW_PRIMED (invisible, ~200ms)

| Property | Value |
|----------|-------|
| enter() | Call getUserMedia({video: {facingMode: "environment"}}) in background. Set surface to "camera". |
| exit() | If not transitioning to CAMERA_OPEN, kill the stream. |
| render() | Still showing HOME (no visual change). |
| scroll↑ | Cancel priming, go HOME. |
| back | Cancel priming, go HOME. |
| tap | Transition to CAMERA_OPEN (stream already ready). |
| PTT up | Transition to CAMERA_OPEN then immediately to CAPTURE (user was holding PTT to shoot). |

This state exists to mask getUserMedia latency. The user taps SHOW or presses PTT on SHOW, we start warming the camera in ~200ms, and by the time the gesture completes, the stream is ready. If the user scrolls away or presses back before the stream is ready, we cancel.

#### CAMERA_OPEN

| Property | Value |
|----------|-------|
| enter() | Full-screen camera preview. Log "camera open". Send SDK payload with useLLM=false, wantsR1Response=false. |
| exit() | Stop camera stream. Hide overlay. Set surface to "home". |
| render() | Full-screen camera feed with minimal chrome: thin crosshair center, flip icon top-right, "back" hint top-left. Background = black. |
| tap (center) | CAPTURE intent → transition to CAMERA_CAPTURE |
| scroll | Flip camera (front/back). Log "camera flipped". |
| PTT down | Same as tap — capture. PTT is a natural "shoot" gesture. |
| back | → HOME |

#### CAMERA_CAPTURE

| Property | Value |
|----------|-------|
| enter() | Flash white frame. Capture current video frame to canvas → toDataURL → store. Send to StructaLLM.processImage(). Close camera stream. |
| exit() | Hide flash. Transition to HOME. |
| render() | Brief white flash (100ms), then HOME. |
| all inputs | Blocked during capture processing (~500ms). |

#### TELL_PRIMED (invisible, ~100ms)

| Property | Value |
|----------|-------|
| enter() | Set surface to "voice". No STT yet. |
| exit() | Set surface to "home". |
| render() | Still showing HOME. |
| PTT up | → VOICE_OPEN then immediately VOICE_PROCESSING. |
| back | → HOME |

#### VOICE_OPEN

| Property | Value |
|----------|-------|
| enter() | Show green overlay. CreationVoiceHandler.postMessage("start"). Log "listening". |
| exit() | Hide overlay. document.body.classList.remove("input-locked"). |
| render() | Full-screen green overlay (#92ff9d). Large mic glyph (white). Waveform (white bars). "listening" status text. |
| PTT down | Already open — no-op. |
| PTT up | → VOICE_PROCESSING. CreationVoiceHandler.postMessage("stop"). |
| back | → HOME. CreationVoiceHandler.postMessage("stop"). |

#### VOICE_PROCESSING

| Property | Value |
|----------|-------|
| enter() | Hide overlay. Take transcript from STT result. Clean up (strip "question mark" etc). Run handleTranscript(). |
| exit() | n/a (auto-transitions) |
| render() | Brief "processing" flash on home (200ms green border pulse), then HOME. |
| all inputs | Blocked during processing. Auto-transition to HOME after ~300ms. |

#### KNOW_BROWSE

| Property | Value |
|----------|-------|
| enter() | Set surface to "insight". Build know model. render(). |
| exit() | Set surface to "home". Clear knowDetail flag. |
| render() | Full-screen gold (#f8c15d). Header: know icon + "know". 4 lane tabs (asks, signals, decided, loops). Filter chip. Item count. Current lane summary. Best match item preview. |
| scroll↓ | Next lane tab (asks→signals→decided→loops) |
| scroll↑ | Prev lane tab |
| long-press | Cycle filter chip (latest→next→asks→assets) |
| tap | → KNOW_DETAIL (open the best-match item) |
| side | → KNOW_DETAIL (same as tap — open current item) |
| back | → HOME |

#### KNOW_DETAIL

| Property | Value |
|----------|-------|
| enter() | Set knowDetail=true. Reset knowItemIndex=0. render(). |
| exit() | Set knowDetail=false. |
| render() | Same gold background. Item title (16px). Date (10px). Section label. Item body (14px, wrapped). Action area at bottom. |
| scroll↓ | Next item in current lane/filter |
| scroll↑ | Prev item |
| tap | If item is a question → transition to KNOW_ANSWER via voice. Otherwise → back to KNOW_BROWSE. |
| side | If item is a question → KNOW_ANSWER. Otherwise → KNOW_BROWSE. |
| back | → KNOW_BROWSE |

#### KNOW_ANSWER

This state reuses VOICE_OPEN/VOICE_PROCESSING but with a flag set so the transcript routes to answer resolution instead of normal voice processing.

| Property | Value |
|----------|-------|
| enter() | Set answeringQuestion={index, text}. Open voice overlay (same green as TELL). StructaVoice.setQuestionContext(). |
| exit() | Clear answeringQuestion. |
| render() | Identical to VOICE_OPEN (green overlay, mic glyph, waveform). |
| PTT up | → VOICE_PROCESSING with answering context. handleTranscript routes to resolveQuestion() instead of normal processing. |
| back | Cancel answer. → KNOW_DETAIL. |

#### NOW_BROWSE

| Property | Value |
|----------|-------|
| enter() | Set surface to "project". Build now summary. render(). |
| exit() | Set surface to "home". |
| render() | Full-screen orange (#ff8a65). Header: now icon + "now". Project name (11px). "since last time" section (14px). If pending decisions: decision box with 3 options. If blockers: blocker box with urgency. "next move" section (14px). Footer stats (10px). |
| scroll↓ | Next pending decision / blocker |
| scroll↑ | Prev pending decision / blocker |
| tap option | Execute that option (approve/skip/custom). → NOW_BROWSE (refreshed). |
| side | Approve current decision/blocker option. |
| back | If pending decisions exist: skip current decision → NOW_BROWSE. If no pending: → HOME. |
| back (2x) | → HOME (after skipping all pending). |

#### NOW_DECISION (variant of NOW_BROWSE with decision focus)

Displayed inline within NOW_BROWSE. Not a separate state. When a decision is the active item, the NOW_BROWSE render shows the decision box with 3 options.

#### NOW_BLOCKER (variant of NOW_BROWSE with blocker focus)

Same as NOW_DECISION but with red-tinted box, urgency indicator, and more prominent display.

#### LOG_OPEN

| Property | Value |
|----------|-------|
| enter() | Expand log drawer. Load visible-only entries. |
| exit() | Collapse drawer. |
| render() | Dark drawer slides up from bottom. White text log entries with timestamps. |
| scroll | Scroll log entries. |
| back | → HOME (or previous surface). |
| long-press | Export logs to Rabbit Hole (journal). |

### 1.3 State Transition Diagram

```
                    ┌─────────────────────────────────────────┐
                    │                                         │
    ┌──────┐  tap  │  ┌──────────┐  tap  ┌───────────────┐  │
    │ HOME │───────┼─►│ SHOW     │──────►│ CAMERA_OPEN   │  │
    │      │  PTT  │  │ _PRIMED  │  PTT  │               │  │
    │      ├───────┤  └──────────┘  up   ├───────────────┤  │
    │      │       │                      │ CAMERA        │  │
    │      │  tap  │  ┌──────────┐  tap  │ _CAPTURE      │──┘
    │      ├───────┼─►│ TELL     │──────►└───────────────┘
    │      │  PTT  │  │ _PRIMED  │  PTT
    │      ├───────┤  └──────────┘  up
    │      │       │                      ┌───────────────┐
    │      │  tap  │                      │ VOICE_OPEN    │──┐
    │      ├───────┼─────────────────────►│               │  │
    │      │       │         PTT           ├───────────────┤  │
    │      │  tap  │         up            │ VOICE         │  │
    │      ├───────┼─────────────────────►│ _PROCESSING   │──┘
    │      │       │                      └───────────────┘
    │      │  tap  │  ┌───────────────┐
    │      ├───────┼─►│ KNOW_BROWSE   │◄──┐
    │      │       │  └───────────────┘   │
    │      │       │     tap       │      │
    │      │       │     ┌─────────▼───┐  │
    │      │       │     │ KNOW_DETAIL │──┘
    │      │       │     └─────────────┘
    │      │       │     side (question)
    │      │       │     ┌─────────────┐
    │      │       └────►│ KNOW_ANSWER │──► VOICE_OPEN (reuse)
    │      │              └─────────────┘
    │      │
    │      │  tap  │  ┌───────────────┐
    │      ├───────┼─►│ NOW_BROWSE    │
    │      │       │  └───────────────┘
    │      │
    │      │  log  │  ┌───────────────┐
    │      ├───────┼─►│ LOG_OPEN      │
    │      │       │  └───────────────┘
    │      │
    └──────┘  back (only from HOME)
              exits app
```

### 1.4 Implementation Pattern

Replace all scattered booleans with a single state variable:

```js
const STATES = {
  HOME: 'home',
  SHOW_PRIMED: 'show_primed',
  CAMERA_OPEN: 'camera_open',
  CAMERA_CAPTURE: 'camera_capture',
  TELL_PRIMED: 'tell_primed',
  VOICE_OPEN: 'voice_open',
  VOICE_PROCESSING: 'voice_processing',
  KNOW_BROWSE: 'know_browse',
  KNOW_DETAIL: 'know_detail',
  KNOW_ANSWER: 'know_answer',
  NOW_BROWSE: 'now_browse',
  LOG_OPEN: 'log_open'
};

let currentState = STATES.HOME;
let stateData = {}; // per-state context (e.g., answeringQuestion, decisionIndex)

function transition(newState, data = {}) {
  const prev = currentState;
  STATES[prev]?.exit?.();
  currentState = newState;
  stateData = { ...stateData, ...data };
  STATES[newState]?.enter?.(stateData);
  render();
}
```

This replaces: hintMode, pttActive, activeSurface, knowDetail, answeringQuestion, knowLaneIndex, knowItemIndex, knowChipIndex, decisionIndex, logOpen — all folded into currentState + stateData.

---

## 2. Agent Heartbeat System

### 2.1 Frequency Tiers

| Tier | BPH | Interval | Trigger | Purpose |
|------|-----|----------|---------|---------|
| IDLE | 1 | 60 min | No recent captures (>30 min) | Keep memory alive, minor consolidation |
| ACTIVE | 10 | 6 min | Has captures/insights but no pending tasks | Process unstructured items, generate questions |
| PROCESSING | 30 | 2 min | Has backlog items or research tasks | Execute research, consolidate, generate decisions |
| URGENT | 60 | 1 min | Has unresolved blockers or >3 pending decisions | Fast iteration on blockers |

### 2.2 Beat Task Queue

Each heartbeat beat processes ONE task from the queue. No parallel processing. The queue is prioritized:

```
Priority 0: BLOCKER_RESOLUTION (if user resolved a blocker, agent acts on it immediately)
Priority 1: BLOCKER_DETECTION (scan for contradictions, missing dependencies)
Priority 2: CAPTURE_PROCESSING (convert raw captures → structured insights)
Priority 3: RESEARCH_EXECUTION (execute next research task)
Priority 4: QUESTION_GENERATION (identify knowledge gaps)
Priority 5: CONSOLIDATION (merge similar items, dedup)
Priority 6: DECISION_GENERATION (when enough context gathered, propose a decision)
```

On each beat:
1. Pop highest-priority task from queue
2. Build LLM prompt with project context
3. Send ONE LLM call via PluginMessageHandler
4. Process response → update project memory
5. If response generates new tasks, add to queue
6. Adjust heartbeat frequency based on queue depth
7. If response surfaces a blocker or decision → notify UI (spring-jump NOW card)

### 2.3 LLM Prompts Per Task Type

#### CAPTURE_PROCESSING
```
You are Structa's project agent. Process this capture into structured context.

Project: {name}
Domain: {domain}
Existing insights: {insights_summary}
Existing questions: {questions_summary}

Capture: "{capture_text}"
Source: {voice | camera}
Timestamp: {timestamp}

Return JSON:
{
  "insight": { "title": "...", "body": "...", "next": "..." },
  "questions": [{ "text": "..." }],
  "decisions": null,
  "blockers": null,
  "backlog_items": [{ "title": "...", "body": "..." }]
}
```

#### RESEARCH_EXECUTION
```
You are Structa's project agent. Research this topic for the project.

Project: {name}
Research topic: "{topic}"
Existing insights: {insights_summary}

Provide findings in this format:
{
  "insight": { "title": "...", "body": "distilled findings", "next": "..." },
  "questions": [],
  "decisions": null,
  "blockers": null
}
```

#### QUESTION_GENERATION
```
You are Structa's project agent. Based on the project state, identify knowledge gaps.

Project: {name}
Insights: {insights_summary}
Decisions: {decisions_summary}
Open questions: {questions_summary}

Return:
{
  "insight": null,
  "questions": [{ "text": "question the project needs answered" }],
  "decisions": null,
  "blockers": null
}
```

#### BLOCKER_DETECTION
```
You are Structa's project agent. Check for contradictions or blockers.

Project: {name}
Insights: {all_insights}
Decisions: {all_decisions}
Backlog: {all_backlog}

Return:
{
  "insight": null,
  "questions": [],
  "decisions": null,
  "blockers": [{
    "description": "what's blocked and why",
    "severity": "high | medium | low",
    "options": [
      { "label": "option A", "reasoning": "why this might work" },
      { "label": "option B", "reasoning": "why this might work" },
      { "label": "option C", "reasoning": "alternative approach" }
    ]
  }]
}
```

#### DECISION_GENERATION
```
You are Structa's project agent. Based on what we know, propose a decision.

Project: {name}
Insights: {insights_summary}
Decisions: {decisions_summary}
Open questions remaining: {questions_count}

Return:
{
  "insight": null,
  "questions": [],
  "decisions": [{
    "text": "decision to be made",
    "options": [
      { "label": "option A", "reasoning": "..." },
      { "label": "option B", "reasoning": "..." },
      { "label": "option C", "reasoning": "..." }
    ]
  }],
  "blockers": null
}
```

#### CONSOLIDATION
```
You are Structa's project agent. Check for similar or duplicate items to merge.

Insights: {all_insights}
Backlog: {all_backlog}

Return:
{
  "merge_pairs": [{ "keep_index": 0, "merge_index": 3, "reason": "similar topic" }],
  "new_insights": [{ "title": "merged title", "body": "combined content" }],
  "remove_indices": [3, 7]
}
```

### 2.4 Heartbeat State Machine

```
         ┌──────────┐
         │  STOPPED  │ (app backgrounded)
         └────┬─────┘
              │ app foregrounded
              ▼
    ┌──────────────────┐
    │     IDLE         │◄──────────────────┐
    │  1 BPH / 60min   │                   │
    └────────┬─────────┘                   │
             │ new capture received        │
             ▼                              │
    ┌──────────────────┐   queue empty     │
    │     ACTIVE       │───────────────────┘
    │  10 BPH / 6min   │
    └────────┬─────────┘
             │ backlog > 0 or research task
             ▼
    ┌──────────────────┐
    │   PROCESSING     │
    │  30 BPH / 2min   │
    └────────┬─────────┘
             │ blocker detected
             ▼
    ┌──────────────────┐   blocker resolved
    │     URGENT       │──────────────────┐
    │  60 BPH / 1min   │                   │
    └──────────────────┘   queue empty + no blocker
                           └──► ACTIVE or IDLE
```

### 2.5 Rate Limiting

- Maximum 1 LLM call per beat
- Minimum 5 seconds between LLM calls (MIN_GAP_MS)
- If LLM call fails, skip this beat, retry next beat
- Queue depth cap: 20 tasks. If exceeded, drop lowest-priority CONSOLIDATION tasks.
- Conversation history for agent: last 4 agent exchanges (not user voice exchanges)

### 2.6 Persistence

Agent state persisted in StructaNative memory:
```js
{
  heartbeat_tier: "active",        // current frequency
  task_queue: [...],               // serialized task objects
  last_beat_at: "2026-04-13T...",  // ISO timestamp
  last_llm_call_at: "2026-04-13T...",
  beat_count: 42,                  // total beats this session
  agent_conversation_history: [...], // agent's own conversation
  processing_stats: {
    captures_processed: 12,
    insights_generated: 8,
    questions_raised: 5,
    decisions_proposed: 2,
    blockers_detected: 1,
    consolidations: 3
  }
}
```

---

## 3. Autonomous Harnessing Flows

### 3.1 RESEARCH (fully autonomous)

Trigger: Agent identifies a topic that needs research (from a capture, question, or blocker option).

Flow:
1. Agent creates research_task: { topic, status: "pending", created_at }
2. On next PROCESSING beat, agent picks up the task
3. Agent sends RESEARCH_EXECUTION prompt with topic + project context
4. LLM returns distilled findings as an insight
5. Agent stores insight, marks task as "complete"
6. If findings reveal new questions → add to task queue (QUESTION_GENERATION)
7. If findings reveal a decision point → add to task queue (DECISION_GENERATION)
8. KNOW card springs (new insight)

No human needed at any step. The entire loop runs in background beats.

### 3.2 CONSOLIDATE (fully autonomous)

Trigger: Agent detects similar items during QUESTION_GENERATION or routine scan.

Flow:
1. Agent sends CONSOLIDATION prompt with all insights + backlog
2. LLM returns merge pairs
3. Agent merges items, updates references
4. No UI notification (silent operation)

### 3.3 QUESTION (autonomous generation, human answers)

Trigger: Agent identifies knowledge gap during CAPTURE_PROCESSING or RESEARCH_EXECUTION.

Flow:
1. Agent generates question text from LLM response
2. Adds to project.open_questions[]
3. KNOW card springs (new question)
4. Human sees question in KNOW → asks lane
5. Human taps question → KNOW_ANSWER → VOICE_OPEN
6. Human speaks answer → stored in project memory
7. If answer resolves the question → agent processes it on next beat

### 3.4 DECIDE (human-in-the-loop)

Trigger: Agent has enough context to propose a decision, or a blocker requires a choice.

Flow:
1. Agent generates 3 options with reasoning from LLM response
2. Creates pending_decision: { text, options: [...], source: "agent", created_at }
3. Adds to project.pending_decisions[]
4. NOW card springs urgently (orange pulse)
5. Human opens NOW → sees decision with 3 squared buttons
6. Human taps option → decision.approved = true, option stored
7. Agent processes the approved decision on next beat
8. Decision moves from pending_decisions[] to decisions[]

### 3.5 BLOCKER (human-in-the-loop, urgent)

Trigger: Agent detects contradiction, missing dependency, or stalled progress.

Flow:
1. Agent creates blocker: { description, severity, options: [...], created_at }
2. Adds to project.blockers[] and project.pending_decisions[]
3. NOW card springs urgently (rapid orange pulse)
4. Human opens NOW → sees blocker in red-tinted box with 3 options
5. Human picks resolution option
6. Agent executes the resolution:
   - If "research more" → creates research_task
   - If "pivot direction" → updates project context
   - If "skip for now" → moves blocker to resolved, adds to backlog
7. Heartbeat upgrades to URGENT until blocker resolved
8. After resolution → heartbeat downgrades to previous tier

---

## 4. Notification System

### 4.1 Triggers

| Event | Target | Animation | Duration | CSS Class |
|-------|--------|-----------|----------|-----------|
| New insight | KNOW card | Gold pulse | 0.6s | `.notify-know` |
| New question | KNOW card | Gold pulse | 0.6s | `.notify-know` |
| Pending decision | NOW card | Orange pulse | 0.8s | `.notify-now` |
| Blocker detected | NOW card | Rapid orange pulse | 1.2s | `.notify-urgent` |
| Agent processing | Current surface | Subtle border glow | 0.3s | `.notify-processing` |

### 4.2 Animation Definition

```css
@keyframes spring-know {
  0%   { transform: scale(1) translateY(0); }
  30%  { transform: scale(1.06) translateY(-2px); }
  60%  { transform: scale(1.02) translateY(0); }
  100% { transform: scale(1) translateY(0); }
}

@keyframes spring-now {
  0%   { transform: scale(1) translateY(0); }
  25%  { transform: scale(1.08) translateY(-3px); }
  50%  { transform: scale(1.03) translateY(1px); }
  75%  { transform: scale(1.05) translateY(-1px); }
  100% { transform: scale(1) translateY(0); }
}

@keyframes spring-urgent {
  0%   { transform: scale(1); }
  15%  { transform: scale(1.10) translateY(-4px); }
  30%  { transform: scale(0.98); }
  45%  { transform: scale(1.06) translateY(-2px); }
  60%  { transform: scale(1.01); }
  75%  { transform: scale(1.03) translateY(-1px); }
  100% { transform: scale(1); }
}

.notify-know .card-hero  { animation: spring-know 0.6s ease-out; }
.notify-now  .card-hero  { animation: spring-now 0.8s ease-out; }
.notify-urgent .card-hero { animation: spring-urgent 1.2s ease-out; }
```

### 4.3 Rules

- Only animate on HOME state (when cards are visible in the stack)
- If user is already in KNOW or NOW surface, skip the home animation
- Notifications queue: if multiple events fire during one render cycle, play the highest-severity animation
- Decay: animation plays once, then removes the CSS class
- No sound, no vibration

### 4.4 Integration Point

```js
// In the agent's beat callback, after updating project memory:
function notifyCard(cardId, severity) {
  if (currentState !== STATES.HOME) return;
  const svg = document.getElementById('scene');
  svg.classList.add(`notify-${severity}`);
  setTimeout(() => svg.classList.remove(`notify-${severity}`), 1200);
}

// Usage:
// notifyCard('know', 'know');    // gold pulse
// notifyCard('now', 'now');      // orange pulse
// notifyCard('now', 'urgent');   // rapid orange pulse
```

---

## 5. Data Model

### 5.1 Project Memory Schema

```js
{
  name: "string",
  domain: "string",
  created_at: "ISO8601",
  updated_at: "ISO8601",

  // Raw inputs
  captures: [
    {
      id: "cap_001",
      type: "voice | image",
      raw_text: "transcript or image description",
      summary: "one-line summary",
      source: "tell | show | agent",
      created_at: "ISO8601",
      processed: true
    }
  ],

  // Structured knowledge
  insights: [
    {
      id: "ins_001",
      title: "short title",
      body: "full insight text",
      next: "suggested next action",
      source: "voice | camera | agent-research | agent-consolidate",
      confidence: 0.8,
      chips: ["latest", "next"],
      created_at: "ISO8601"
    }
  ],

  // Open questions
  open_questions: [
    {
      id: "que_001",
      text: "question text",
      source: "voice | agent",
      status: "open | answered",
      answer: null | { text: "...", source: "voice", answered_at: "ISO8601" },
      created_at: "ISO8601"
    }
  ],

  // Approved decisions
  decisions: [
    {
      id: "dec_001",
      text: "what was decided",
      chosen_option: "option A",
      reasoning: "why this was chosen",
      source: "voice | agent",
      created_at: "ISO8601"
    }
  ],

  // Awaiting human approval
  pending_decisions: [
    {
      id: "pdec_001",
      text: "decision to make",
      options: [
        { label: "Option A", reasoning: "..." },
        { label: "Option B", reasoning: "..." },
        { label: "Option C", reasoning: "..." }
      ],
      source: "voice | agent",
      severity: "normal | blocker",
      created_at: "ISO8601"
    }
  ],

  // Open tasks
  backlog: [
    {
      id: "blk_001",
      title: "task title",
      body: "description",
      status: "open | in_progress | done",
      source: "voice | agent",
      created_at: "ISO8601"
    }
  ],

  // Active blockers
  blockers: [
    {
      id: "blk_001",
      description: "what's blocked",
      severity: "high | medium | low",
      options: [
        { label: "...", reasoning": "..." },
        { label: "...", reasoning": "..." },
        { label: "...", reasoning": "..." }
      ],
      status: "active | resolved",
      resolution: null | { option: "...", resolved_at: "..." },
      created_at: "ISO8601"
    }
  ],

  // Autonomous research tasks
  research_tasks: [
    {
      id: "res_001",
      topic: "what to research",
      status: "pending | in_progress | complete | failed",
      result: null | { insight_id: "ins_002" },
      created_at: "ISO8601",
      completed_at: null | "ISO8601"
    }
  ],

  // Agent state
  agent_state: {
    heartbeat_tier: "idle | active | processing | urgent",
    task_queue: [{ type: "...", priority: 0, data: {} }],
    last_beat_at: "ISO8601",
    beat_count: 42,
    stats: {
      captures_processed: 12,
      insights_generated: 8,
      questions_raised: 5,
      decisions_proposed: 2,
      blockers_detected: 1,
      consolidations: 3
    }
  }
}
```

### 5.2 ID Generation

```js
function generateId(prefix) {
  return `${prefix}_${String(Date.now()).slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
}
// Examples: cap_384729_a3f1, ins_384730_b7c2, que_384731_d4e8
```

---

## 6. Implementation Plan

### Phase 1: State Machine Rewrite (structa-cascade.js)
- Replace all booleans with formal currentState + stateData
- Implement transition() function with enter/exit/render
- Remove hint mode entirely
- Wire SHOW/TELL primed states for getUserMedia pre-warming
- Add spring-jump CSS animations

### Phase 2: Camera Flow Fix (camera-capture.js + cascade)
- Single tap on SHOW → SHOW_PRIMED → CAMERA_OPEN
- PTT on SHOW → SHOW_PRIMED → CAMERA_OPEN → CAMERA_CAPTURE (on release)
- Remove all hint overlay code
- Ensure useLLM=false on camera SDK payloads

### Phase 3: Agent Task Queue (heartbeat.js)
- Implement task queue with priority ordering
- Add beat processing logic (one LLM call per beat)
- Add CAPTURE_PROCESSING and QUESTION_GENERATION task types
- Wire beat results back to project memory

### Phase 4: Agent Flows (r1-llm.js + heartbeat.js)
- Add RESEARCH_EXECUTION flow
- Add CONSOLIDATION flow
- Add BLOCKER_DETECTION flow
- Add DECISION_GENERATION flow
- Wire results to KNOW/NOW card notifications

### Phase 5: Blocker/Decision UI (cascade + index.html)
- Redesign NOW card with 3-option decision buttons
- Add blocker display with red tint
- Wire side/back/tap to option selection
- Add urgent notification for blockers

### Phase 6: Polish
- Test all state transitions
- Verify log noise suppression
- Test heartbeat frequency scaling
- Test notification animations
- Full regression test on R1 hardware
