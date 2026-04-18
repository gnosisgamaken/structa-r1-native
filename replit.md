# Structa R1 Native — Current Project Information

## Overview
Structa is now a Rabbit R1-native project cognition surface, not the old canvas cascade prototype.

It is a low-clutter, card-based operating system for project capture, interpretation, memory, and decision support on a constrained 240×292 viewport.

Core product idea:
- **show** = visual capture
- **tell** = voice capture
- **know** = signal extraction / knowledge browse
- **now** = decisions, blockers, and action surface

The app is designed to feel native to Rabbit hardware:
- direct capture instead of menu-heavy UX
- short, precise prompts
- silent-by-default operation
- local-first memory and state persistence
- human approval around mutations / decisions

## What Structa Is Now
The current app is a browser-based native-style interface for Rabbit R1 that combines:
- a formal state machine UI
- queued async AI/vision processing
- local project memory + registry
- autonomous background impact-chain reasoning
- touch/PTT/camera/voice interactions
- compact knowledge and decision browsing

This is no longer a generic “impact visualization” experiment.
It has evolved into a **project cognition instrument panel**.

## Current Architecture

### Frontend
- **Vanilla HTML / CSS / JavaScript**
- no framework
- no build step
- SVG-driven UI composition
- custom state machine in `structa-cascade.js`

### Runtime model
- Rabbit-first interaction model
- works as a static-style app with a lightweight Python server
- local-first persistence with browser and Rabbit storage fallbacks

### Main interaction surfaces
- **HOME** — 4-card stack / hero selection
- **SHOW** — camera capture / image-based intake
- **TELL** — push-to-talk voice intake
- **KNOW** — asks, signals, decided items, loops
- **NOW** — pending decisions, blockers, next moves
- **LOG** — compact operational trace / queue / phase visibility
- **TRIANGLE** — structured synthesis surface
- **PROJECT SWITCHER** — project registry navigation

## Key Modules
- `index.html` — shell, viewport, drawer, overlays, script loading
- `structa-cascade.js` — main state machine, rendering, gesture routing, surface logic
- `server.py` — lightweight local API helpers / prompt shaping endpoints
- `js/rabbit-adapter.js` — project memory, storage, registry, legacy compatibility views
- `js/voice-capture.js` — STT capture, transcript handling, onboarding/project naming flows
- `js/camera-capture.js` — camera pipeline, capture storage, image analysis queue entry
- `js/r1-llm.js` — LLM bridge / normalization / speaking hooks
- `js/impact-chain-engine.js` — autonomous background chain for observe/clarify/decision
- `js/processing-queue.js` — persistent async queue with recovery and blocker surfacing
- `js/triangle-engine.js` — angle-based synthesis / structured merge surface
- `js/audio-engine.js` — quiet sonic feedback / voice-safe sound layer
- `js/storage-manager.js` — storage fallback handling
- `js/contracts.js` — canonical schemas / contracts
- `js/validation.js` — validation helpers
- `js/icons.js` — icon registry

## Current Product Evolution
Structa has evolved through several distinct phases:

1. **Cascade prototype phase**
   - graph/cascade concept
   - visual experimentation
   - not yet grounded in real R1-native interaction

2. **R1 native surface phase**
   - card stack home
   - camera / PTT / voice / know / now surfaces
   - stronger Rabbit-native behavior

3. **Project cognition phase**
   - project-aware memory model
   - structured captures and insights
   - explicit question / decision / task handling

4. **Queued async processing phase**
   - gesture paths return immediately
   - enrichment work runs through persistent queue
   - failed/stalled jobs surface as blockers instead of silently dying

5. **Autonomous orchestration phase**
   - impact chain reviews project state quietly in background
   - KNOW tone refined
   - NOW becomes a compact action and blocker layer
   - onboarding increasingly derived from real project state

## Important Current Behaviors
- User gesture paths should stay fast and non-blocking.
- Capture is stored first; AI enrichment happens after.
- Queue state persists locally and restores on boot.
- Stalled jobs become visible blockers.
- Project state drives onboarding and recovery.
- Structa should act like a calm, native instrument panel — not a chat app.

## Processing Queue Model
Structa now uses a persistent processing queue for async work.

Documented in: `docs/queue-audit.md`

Key rule:
1. immediate UI feedback
2. immediate local write when possible
3. async enrichment after the gesture path returns

Current queued entry points include:
- voice interpretation
- project title generation
- thread refinement
- image analysis
- triangle synthesis
- autonomous chain steps

## Persistence Model
Current persistence is local-first:
- `creationStorage` when available
- `localStorage` fallback
- project registry within Structa memory
- queue persistence via `structa.queue.v1`

The app supports project-aware memory rather than a single flat note stream.

## Current UX Direction
The app is intentionally:
- compact
- squared-pill / strong identity
- Rabbit-native in feel
- silent by default
- explicit about decisions and blockers
- low chrome, low clutter

Avoid:
- generic dashboard feel
- verbose assistant language
- long explanatory text on-device
- blocking flows on capture or PTT release

## Current Runtime / Serving
### Local run
```bash
python3 server.py
```

### Package script
```bash
npm start
```

### Default package info
- package name: `structa`
- no frontend build pipeline
- lightweight server-backed local development

## Repo Status Snapshot
Current branch:
- `main`

Recent evolution in git includes:
- self-healing onboarding from project state
- onboarding lesson routing into know
- know→show handoff fixes
- log rendering optimization
- image flow optimization
- know tone refinement
- resume capture analysis improvements
- persistent processing queue
- know polish

## Important Docs
- `IMPLEMENTATION.md` — implementation summary and product reasoning
- `ARCHITECTURE_REPORT.md` — architecture audit and harnessing direction
- `STRUCTA_V2_ENGINEERING_DESIGN.md` — state/engine design
- `STRUCTA_V2_UX_DESIGN.md` — visual / UX system
- `STRUCTA_DEPLOYMENT_READINESS_AUDIT.md` — deployment notes
- `docs/queue-audit.md` — current async queue model

## Current Interpretation
Structa is best understood as:

> a Rabbit-native project cognition system that captures signals, organizes working memory, surfaces blockers, and helps a human move a project forward through compact native interaction.

Not:
- a generic notes app
- a chatbot shell
- a generic project manager
- a visual graph toy

## Next Development Focus
Most recent code direction suggests focus on:
- stabilizing queue-backed capture/enrichment flows
- polishing KNOW and NOW surfaces
- improving onboarding from live project state
- preserving native calmness while expanding orchestration depth
- validating all of this on real R1-device behavior
