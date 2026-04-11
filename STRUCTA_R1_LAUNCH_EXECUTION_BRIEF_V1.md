# Structa R1 Native — Launch Execution Brief v1

## Goal
Move Structa R1 Native from polished prototype to publishable native app.

This brief translates the interaction spec into an implementation order, with Rabbit-native bindings, harness assumptions, and test gates.

## Product posture
Structa is a creative-professional project cognition system.
It should feel like a native instrument on Rabbit R1:
- visually bold, but not noisy
- quiet by default
- fast to capture
- easy to inspect
- safe for real work
- built around context, not chat

## What is already true
- The visual shell is in place.
- The home canvas has a strong native feel.
- The audit drawer is collapsed by default.
- The app already supports a compact four-node home state with hidden depth.
- The next step is not more aesthetic theory; it is wiring real device behavior and harness logic.

## Build strategy
Use a layered approach:
1. Native interaction adapter
2. Capture and storage pipeline
3. Harness / intent routing
4. Export and approval flows
5. UX/IX testing and polish

Do not mix all of these in one pass.

## 1. Interaction map

### 1.1 Home canvas
Primary screen with 4 visible nodes.

Interactions:
- tap node: select
- tap again: trigger node default action
- hold CORE or MEMORY: reveal deeper layer
- horizontal swipe: cycle nodes
- arrow keys: cycle nodes
- Enter / Space: trigger current selection

Purpose:
- keep project state visible
- make the next move obvious
- keep the interface calm

### 1.2 Audit drawer
Collapsed log / history / trace layer.

Interactions:
- swipe up: open
- swipe down: close
- tap handle: toggle
- Escape / Back: close if open

Purpose:
- show provenance
- expose the last actions
- remain secondary to the main canvas

### 1.3 Voice / PTT capture
Fastest creation path.

Interactions:
- press and hold PTT: start capture
- release: submit transcription
- spoken input: normalize into structured intent
- short reply: optional native voice confirmation

Purpose:
- quick project capture
- commands without typing
- field-friendly interaction

### 1.4 Camera capture
First-class interaction, not a side feature.

Interactions:
- open camera from app
- switch front/back
- rotate to selfie position
- capture image
- image can become a prompt input

Purpose:
- capture field context
- take reference images
- store visual evidence with response and metadata

### 1.5 Journal / memory
Structured memory path.

Interactions:
- write structured journal entry
- attach node / capture / prompt / response
- preserve project_code and entry_id

Purpose:
- stable memory
- searchable context
- continuity across sessions

### 1.6 Email withdrawal / export
External handoff path.

Interactions:
- choose bundle
- preview content
- approve send
- email context out

Purpose:
- get context outside the app
- turn internal work into shareable artifacts

### 1.7 Tilt / gyro
Optional delight layer.

Interactions:
- subtle tilt: shift focus or emphasis
- shake: request fresh node suggestion or context refresh

Rules:
- never required for core tasks
- never the only route to an important action

### 1.8 Scroll / rotary input
If hardware supports it, use it for state navigation.

Interactions:
- scroll: cycle nodes or list items
- press/confirm: trigger selected state if applicable

Purpose:
- fast browsing without tapping repeatedly

## 2. Rabbit-native bindings

### Native primitives to wire first
- PluginMessageHandler
- wantsR1Response: true
- wantsJournalEntry: true
- creationStorage
- hardware events for PTT / scroll / button actions
- camera capture / selfie flip
- any supported image prompt / attachment flow

### Rabbit-native behaviors
These should feel native, not simulated:
- PTT
- short voice responses
- camera capture
- selfie rotation / front-back switch
- journal entry creation
- local structured memory write
- audit-like event trace

### Provider-agnostic harness logic
These should stay reusable:
- intent parsing
- validation
- prompt normalization
- action routing
- approval gating
- response schema enforcement
- asset indexing
- export packaging

## 3. Critical SDK/runtime assumptions to verify

Do not assume these without checking the runtime:
- exact PTT event names and lifecycle
- whether microphone capture can be intercepted and normalized before LLM submission
- exact camera API surface
- support for front/back camera switching
- support for selfie rotation / camera orientation state
- storage size limits for images and bundles
- how images are attached to a prompt or journal entry
- whether journal entries support metadata payloads
- whether tilt / gyro / accelerometer is available in this runtime
- whether scroll wheel is available or emulated
- how native email / send flows are exposed

If any of these are missing, the app should degrade gracefully rather than pretending support exists.

## 4. Publishable build order

### Milestone 1 — Native adapter layer
Goal: make the app speak Rabbit.

Deliverables:
- PluginMessageHandler wrapper
- structured payload builder
- response handler
- short voice confirmation path
- journal entry submission path
- local validation before send

Acceptance:
- voice and journal actions can be triggered from the app
- responses are short and controlled
- invalid payloads are rejected locally

### Milestone 2 — Capture pipeline
Goal: make voice and camera first-class capture tools.

Deliverables:
- PTT capture flow
- camera open / close flow
- selfie/front-camera toggle
- image prompt ingestion
- response + image bundle storage

Acceptance:
- a capture produces a stored bundle
- a photo can be described and stored with AI output
- selfie mode is clearly available

### Milestone 3 — Context engine
Goal: make the app useful for actual work.

Deliverables:
- project / node / issue / decision model
- quick context access
- consolidate / decide / research / solve flows
- audit trail entries for every meaningful action

Acceptance:
- user can inspect current state fast
- the system can summarize and reorganize context
- the app remains calm and non-chatty

### Milestone 4 — Export and withdrawal
Goal: move context out of the app cleanly.

Deliverables:
- email withdrawal
- journal write flow
- preview and approval step
- export bundle formatting

Acceptance:
- context can be sent out intentionally
- no surprise external send
- audit trail records the export

### Milestone 5 — UX/IX hardening
Goal: make it credible on device.

Deliverables:
- touch target audit
- gesture reliability test
- drawer behavior polish
- camera flow polish
- audio feedback polish
- small-screen readability pass

Acceptance:
- one-handed use is comfortable
- the screen feels native and premium
- no accidental double actions

## 5. Next PR-sized tasks

### PR 1 — Native event bridge
Scope:
- adapter for Rabbit SDK hooks
- payload schema
- response + journal plumbing

Why first:
- without the bridge, everything else is a fake demo

### PR 2 — Camera capture and selfie mode
Scope:
- camera launch
- camera rotation state
- image storage bundle
- prompt attachment

Why second:
- camera is a core interaction, not a nice-to-have

### PR 3 — PTT voice capture
Scope:
- press / hold / release flow
- transcription normalization
- short spoken responses

Why third:
- voice is the fastest field entry mode

### PR 4 — Structured storage and memory index
Scope:
- project_code + entry_id bundles
- image + response + metadata storage
- journal indexing

Why fourth:
- memory is what makes this a cognition system, not a toy

### PR 5 — Export / email withdrawal
Scope:
- bundle preview
- approval gating
- send to email / native handoff

Why fifth:
- this is the real business utility path

## 6. Validation gates

### Must-pass checks before publish
- no crashes on home canvas
- tap / hold / swipe behavior is stable
- audit drawer opens and closes cleanly
- PTT capture works reliably
- camera opens and can rotate to selfie if supported
- captured images are stored with metadata and response
- journal entries are created correctly
- email withdrawal has explicit approval
- invalid payloads are rejected locally
- app still feels calm on the small screen

### UX/IX checks
- first screen communicates state immediately
- no clutter overtakes the main canvas
- drawer remains secondary
- icons/tiles are readable and actionable
- hardware and touch feel unified
- spoken responses stay short

## 7. Hard opinions

### Native vs simulated
Native:
- camera
- PTT
- voice reply
- journal
- storage
- hardware navigation

Reusable / simulated where needed:
- prompt parsing
- approval logic
- bundle formatting
- export preview
- action routing

### What should not happen
- no chatty assistant behavior
- no hidden surprise export
- no assuming camera / selfie support without verification
- no making tilt or scroll critical to core use
- no turning the app into a dashboard

## 8. Recommended production sequence

1. Verify SDK/runtime primitives
2. Wire adapter layer
3. Implement camera + selfie
4. Implement PTT and short voice output
5. Store images with AI responses
6. Add journal and email export
7. Harden approval gates and validation
8. Run device-level IX testing
9. Polish and publish

## 9. What to tell the implementation model

The implementation model should be told:
- Structa is a creative-professional native R1 app
- the UI is already directionally correct
- now wire real device behavior
- keep the app quiet and structured
- camera is first-class
- images must be stored with response and metadata
- email withdrawal needs approval
- launch quality depends on small-screen reliability, not just appearance

## 10. Definition of publishable

Structa is publishable when:
- it feels native on Rabbit R1
- the main flow is obvious in one glance
- voice, camera, journal, and export all work
- captures become structured context
- the audit trail is coherent
- the app is beautiful without becoming fragile
- real creative professionals could use it without feeling they are inside a demo

That is the bar.
