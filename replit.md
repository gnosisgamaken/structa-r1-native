# STRUCTA R1 Native — current project context

`STRUCTA_V3_PRODUCT_SPEC.md` is the canonical product and interaction contract. Earlier V1/V2 documents are historical when they conflict with it.

## Product

STRUCTA is a Rabbit R1-native project instrument, not a chatbot, feed, dashboard, or generic outliner. Its promise is a clear, decision-ready project map that another human or AI collaborator can continue.

- **show** — capture and browse references
- **tell** — capture and browse original thinking
- **know** — inspect the governed project map
- **now** — handle one highest-leverage intervention

The fixed device surface is 240×282. Use PowerGrotesk Regular only; do not synthesize bold weights. The four colored planes, lowercase copy, full-screen camera/voice, wheel selection, Side action, and PTT context are product invariants. RabbitOS owns system Back and exits the creation; app-local return and cancel must use visible in-app controls.

## Authority and truth

- STRUCTA may advance reversible structure and source-backed research.
- A human must approve, correct, dismiss, or reverse consequential decisions.
- Original user statements are never silently rewritten.
- Existing-condition evidence, working artifacts, and external references have different truth semantics.
- Unsourced research is a lead/hypothesis, never evidence.
- Structural, fire, electrical, code, safety, and exact-measurement conclusions require expert verification.

## Runtime architecture

- `js/project-engine.js` — V3 ledger, six-branch map, deterministic operations, decisions, uncertainty review, exports
- `js/domain-packs.js` — declarative creative-core, build, campaign, and spatial lenses
- `js/vision-protocol.js` — strict silent Rabbit vision request/response contract
- `js/rabbit-adapter.js` — project registry, local persistence, stable project-bound writes
- `js/orchestrator.js` — local prompt preparation and deterministic normalization/fallbacks
- `js/r1-llm.js` — queued Rabbit bridge, exact vision collector, provenance-aware research
- `js/camera-capture.js` — save-first capture, local thumbnail/analysis asset, asynchronous visual relay
- `js/voice-capture.js` — full-screen PTT, project-bound enrichment, project briefing, custom decision answers
- `js/impact-chain-engine.js` — bounded background project advancement
- `structa-cascade.js` — fixed viewport state machine, renderers, hardware and direct-touch routing

All asynchronous work must retain its originating `projectId`. Switching projects while a job is running must never write into the newly active project.

## Interaction rules

- Capture is visible and durable before enrichment begins.
- AI failure never loses an original or blocks navigation.
- In-app navigation changes no decision or uncertainty; RabbitOS Back exits without mutating either.
- A cold camera requires direct-touch user activation on R1. Side may prime the empty-SHOW camera affordance, but must never be the only `getUserMedia` trigger.
- NOW decisions use stable identity, two to four real options, and explicit human approval.
- Three queued uncertainties—or one high-impact uncertainty gating a decision—outrank the decision card.
- Direct-touch targets are at least 44×44 and must not overlap.
- Production has no visible logs, queue/flush controls, heartbeat, navigation ticks, or unsolicited speech/journal entries.

## Run and verify

```bash
npm install
npm start
npm test
```

The app uses `python3 server.py`; there is no frontend build step and no STRUCTA-owned AI backend.

Do not call the silent visual relay production-ready until `docs/v3-r1-release-lab.md` passes on physical hardware. Do not call the overall product generally available until `docs/v3-product-pilot.md` passes.

Before public distribution, confirm PowerGrotesk embedding/repository-distribution rights or replace the font.
