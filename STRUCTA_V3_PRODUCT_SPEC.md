# STRUCTA V3 — canonical product and interaction specification

Status: canonical V3 release-candidate specification. Earlier V1/V2 interaction and design documents are historical context when they conflict with this document. Public release still requires the physical R1 lab, product-pilot gates, and confirmation of font embedding rights.

## Product promise

STRUCTA turns conversations, references, and field captures into a living, decision-ready project corpus.

The first-session promise is concrete: within fifteen minutes, a new user possesses a clear project map that another human or AI collaborator can continue without requiring the user to explain the project again.

STRUCTA is not a chatbot, task list, or passive notebook. Conversation is an input. The product is a governed map, evidence, decisions, and a professional handoff.

## Authority model

| STRUCTA may advance | Human authority is required |
|---|---|
| Reversible structure, branch organization, research leads, source linking, summaries, proposed options, validation plans, next-intervention ranking | Approving or reversing consequential decisions, confirming uncertain observations, changing original user statements, treating an inference as fact, safety/code conclusions |

Model-derived perception, research, and candidate envelopes are schema-validated before a project-bound writer may store them. Consequential state changes are schema-valid proposed operations applied by a deterministic reducer and recorded as events. Decisions are addressed by stable ID and may be approved exactly once. In-app return/cancel actions never dismiss, skip, or approve. RabbitOS owns the system Back control; it exits the creation and is not an in-app navigation event.

## Product architecture

1. **Creative core** — the immutable object model, authorization rules, reducer, selectors, and export compiler.
2. **Domain packs** — declarative vocabulary, lenses, gates, image reading rules, risk rules, and export recipes. A pack is data, not a separate agent.
3. **Project ledger** — canonical entities plus an append-only-in-order local event log (bounded to the latest 1,000 events for device storage) and versioned export records. Each export action produces a complete downloadable Markdown or `.structa.json` artifact.

All projects use the creative core. V3 may infer and compose `build`, `campaign`, and `space` lenses from the user brief. The build lens is the launch proof and is dogfooded on STRUCTA itself.

## Canonical project map

The visible map contains three to seven active branches. V3 begins with six universal branches:

| Branch | Driving question | Closure condition |
|---|---|---|
| Outcome | What must exist when this succeeds? | Outcome and success test are explicit |
| People | Who must this work for? | Primary audience and stakeholders are named |
| Direction | Which direction best serves the outcome? | A direction is human-approved with reasons |
| Reality | What limits or enables the project? | Material constraints and dependencies are known |
| Proof | How will we know it works? | Validation and acceptance criteria exist |
| Delivery | What must happen next? | Next actions and handoff are clear |

Each branch has a stable ID, state, intended outcome, driving question, closure condition, evidence links, reference links, unknowns, decisions, tasks, confidence, and provenance. Additional branches are parked beyond the seven-branch attention budget.

States are `seed`, `open`, `blocked`, `decision_ready`, `decided`, `validate`, and `closed`.

## Visual relay

The original capture is stored and shown immediately. Vision analysis is asynchronous, silent, and optional; failure never loses the capture or blocks navigation.

The Rabbit bridge request contains only:

```json
{
  "message": "<schema-bound perception prompt>",
  "payload": { "imageBase64": "<jpeg>" },
  "useLLM": true,
  "wantsR1Response": false,
  "wantsJournalEntry": false
}
```

STRUCTA accepts only a valid `structa.vision.v1` envelope with the exact outstanding `vision_id`. It keeps three separate layers:

- **Observation:** what appears visible.
- **Interpretation:** an inference about meaning.
- **Implication:** possible relevance to a project branch.

Every capture also has one truth role:

| Truth role | Meaning |
|---|---|
| Existing-condition evidence | May support a factual project claim, with provenance and uncertainty |
| Working artifact | Represents a sketch, diagram, proposal, or current build—not an accepted fact |
| External reference | Contributes attributes to adapt or avoid; never becomes project evidence by itself |

Vision proves sketches/diagrams, spaces, and materials/objects first. Uncertainties queue quietly. Review is offered when three items accumulate or when an unresolved item gates a dependent decision/export. Confirm, correct, and dismiss are explicit human operations; leaving review without choosing changes nothing.

## Device surfaces

STRUCTA uses a complete 240×282 coordinate system, PowerGrotesk Regular, lowercase surface copy, warm black, and the existing four color planes.

### Home

The four verbs remain the navigation and mental model:

| Surface | Role |
|---|---|
| SHOW | Capture reference |
| TELL | Capture thought |
| KNOW | Project map |
| NOW | Next intervention |

The selected plane expands; the others compress as structural rails. NOW is selected on a cold session. Attention uses one quiet joint marker, never a numeric badge. There is no visible queue, flush button, log drawer, heartbeat, status dashboard, or debug language.

### SHOW

SHOW is a capture library, not merely a camera button. A new image appears selected before analysis finishes. Wheel browses. A direct touch on the camera affordance supplies the user activation that the R1 WebView requires before `getUserMedia`. On an empty SHOW surface, Side may focus/prime that affordance, but must not be described as opening a cold lens by itself. Once a reference exists, PTT records why it matters. Sketches use `contain`; spaces/materials may use `cover`.

After direct-touch activation, the camera plane appears black immediately and then reveals the feed. There is no instructional wrapper: only the live plane, a raw reticle, readiness copy, and one visible top `cancel` button. Tap or Side captures, Wheel flips the lens, and PTT may annotate. The `cancel` button closes the lens and returns to SHOW without storing a frame. RabbitOS system Back exits the creation; after relaunch, saved originals and project state must still be present.

### TELL

Voice capture always uses the full-screen green plane. A raw recording dot and restrained waveform are the only visible state. Context is routed in data and accessibility text. Release returns to the originating object or surface.

### KNOW

KNOW is a compressed branch map, not a node graph or four-lane feed. Three to seven branches remain legible without a scrolling dashboard. The focused branch expands to show its outcome or highest-value gap. Wheel selects, Side opens detail, and PTT adds/corrects focused context. In-app navigation returns home; RabbitOS system Back exits the creation.

### NOW

NOW presents exactly one highest-leverage intervention: uncertainty batch, decision, consequential question, next map gap/action, or aligned state. Research remains silent background work until it yields a source-backed lead, an uncertainty, or a decision-ready result.

A decision shows its reason, branch, question, and two to four option rails. Wheel focuses, Side locks, and PTT supplies a custom answer. A recommendation is shown only when supported by evidence. Insufficient evidence produces research progress, not a generic “research first” option.

## Advancement rules

Every successful turn must do at least one of the following: resolve an unknown, improve evidence, frame a decision, create a test, or advance/close a branch.

- Research without provenance is a lead or hypothesis, never evidence.
- Research has a finite budget and a closure condition.
- Original user statements, evidence, and approved decisions are immutable except through explicit human correction/reversal events.
- Low-confidence model output becomes an uncertainty, not a claim.
- Safety, structural, fire, electrical, code, and exact-measurement conclusions require expert verification.
- A session ends with what changed, what needs approval, and the single next intervention.

## Professional exports

Every export is versioned and contains the constitution, map, provenance, references, claims/hypotheses, unknowns, constraints, human-approved decisions, pending decisions, validation, tasks, and next move. Markdown is collaborator-ready; `.structa.json` preserves the full ledger and selectors. Domain packs add recipes such as an agent context packet, campaign brief, or spatial handoff.

## V3 release gates

Run the moderated workflow in `docs/v3-product-pilot.md` and the hardware workflow in `docs/v3-r1-release-lab.md`.

- A moderated first-session pilot yields a correctable six-branch map in fifteen minutes.
- A pilot user can correct the map in no more than three substantive edits.
- In blind handoff testing, a collaborator or coding agent can continue from export without re-interviewing the user.
- Every factual claim and reference has provenance and a truth role.
- Decisions work with two, three, and four options and cannot be double-approved.
- In-app navigation changes no decision or uncertainty; RabbitOS Back exits without mutating either.
- Capture receipt appears before analysis and survives offline/timeout/invalid response.
- No unsolicited speech, journal entry, remote asset request, heartbeat, or navigation tick.
- All golden surfaces fit 240×282, remain readable, and expose 44×44 direct-touch targets.
- Wheel focus responds once per detent; Side has no hidden double-click delay.
- The map and corpus remain browseable after LLM, bridge, or network failure.

Physical release requires a 20-capture R1 capability lab across the three target image classes, with at least 18 valid schema-matched silent responses and zero speech, journal entries, or cross-request matches.

Public distribution also requires documented embedding/distribution rights for PowerGrotesk or replacement with a distribution-safe typeface.
