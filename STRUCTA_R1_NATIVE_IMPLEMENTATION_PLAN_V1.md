# Structa R1 Native — Implementation Plan v1

> For Hermes: use subagent-driven-development to execute this plan task-by-task.

**Goal:** Turn Structa R1 Native into a publishable Rabbit R1 app with real native interactions, camera/selfie capture, PTT/voice, structured memory, approval-gated export, and a polished small-screen UX.

**Architecture:** Keep the current visual shell, but split the runtime into a native adapter layer, a capture/storage pipeline, a strict intent/validation layer, and an export/approval layer. The app should remain visually calm while the harness underneath becomes dependable, explicit, and device-native.

**Tech Stack:** Vanilla HTML/CSS/JS, Rabbit R1 creation runtime / SDK primitives, local structured storage, browser/device testing, optional lightweight smoke tests.

---

## Current repo state

Existing core files:
- `index.html`
- `structa-cascade.js`
- `replit.md`

Existing docs already written:
- `STRUCTA_R1_NATIVE_SPEC_V1_0.md`
- `STRUCTA_R1_NATIVE_SPEC_V1_1.md`
- `STRUCTA_R1_INTERACTION_SPEC_V1.md`
- `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md`

This plan assumes the current visual prototype stays as the base shell and the next work is mostly harness wiring plus a few small UI additions.

---

## Milestone 0: verify runtime assumptions before coding

### Task 0.1: confirm Rabbit SDK primitives and fallbacks

**Objective:** Verify which Rabbit-native APIs actually exist in the target runtime so we do not build on fiction.

**Files:**
- Read: `reference/creation-triggers.md` if available in the active workspace
- Read: the Rabbit runtime docs / SDK docs used for the creation environment
- Update: `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md` with any confirmed API names

**Checklist:**
- Confirm `PluginMessageHandler`
- Confirm `wantsR1Response`
- Confirm `wantsJournalEntry`
- Confirm storage primitive(s)
- Confirm camera front/back / selfie toggle support
- Confirm PTT behavior
- Confirm hardware scroll / button events
- Confirm tilt / gyro availability
- Confirm image attachment pathway for prompt or journal entries
- Confirm email/send handoff mechanism

**Exit criteria:**
- A verified list of supported primitives and any required fallbacks.

---

## Milestone 1: native adapter layer

### Task 1.1: create the runtime adapter scaffold

**Objective:** Add one place that talks to the Rabbit runtime and one place that all app actions go through.

**Files:**
- Create: `js/rabbit-adapter.js`
- Create: `js/contracts.js`
- Modify: `index.html`
- Modify: `structa-cascade.js`

**Responsibilities:**
- detect runtime capability
- normalize payloads
- route native calls through a single adapter
- expose `sendToRabbit`, `writeJournal`, `storeCapture`, `openCamera`, `setSelfieMode`, `startPTT`, `stopPTT`
- provide a browser fallback that logs clearly without pretending to be native

**Minimum API shape:**
```js
export function getCapabilities() {}
export function sendStructuredMessage(payload) {}
export function writeJournalEntry(entry) {}
export function storeAsset(asset) {}
export function openCamera(mode) {}
export function setCameraFacing(facing) {}
```

**Exit criteria:**
- The UI can call one adapter instead of mixing direct runtime assumptions everywhere.

### Task 1.2: create the intent contract and validation gate

**Objective:** Force every outgoing action through a strict schema before any native send happens.

**Files:**
- Create: `js/validation.js`
- Create: `js/intent-router.js`
- Modify: `structa-cascade.js`
- Modify: `index.html`

**What it should validate:**
- project_code present
- entry_id present when storing or journaling
- action verb in allowed set
- target type present
- approval mode explicit
- image payloads and response payloads not empty when required

**Exit criteria:**
- Invalid payloads are rejected locally.
- Valid payloads are normalized into one canonical structure.

---

## Milestone 2: capture pipeline

### Task 2.1: wire PTT / voice capture entry points

**Objective:** Make press-to-talk the fastest way to capture intent.

**Files:**
- Create: `js/voice-capture.js`
- Modify: `structa-cascade.js`
- Modify: `index.html`

**Responsibilities:**
- start capture on PTT press
- stop capture on release
- hand transcription to the intent router
- keep spoken confirmations short
- keep the UI quiet by default

**Exit criteria:**
- A voice capture becomes a structured intent that can be inspected before action.

### Task 2.2: add camera open / selfie / flip capture flow

**Objective:** Make camera a first-class native capture interaction.

**Files:**
- Create: `js/camera-capture.js`
- Modify: `index.html`
- Modify: `structa-cascade.js`

**Responsibilities:**
- open camera from app
- switch front/back
- rotate to selfie position
- capture image
- hand the image into the prompt/analysis path

**Required behavior:**
- self-facing capture must be easy to access
- the current capture mode should be visible
- photo capture should be clearly tied to project context

**Exit criteria:**
- Camera can be opened and used as prompt input.
- Selfie mode exists as a deliberate state, not a hidden tweak.

### Task 2.3: create capture bundles with image + response + metadata

**Objective:** Store captures as durable context objects.

**Files:**
- Create: `js/capture-bundles.js`
- Create: `js/storage.js`
- Modify: `structa-cascade.js`

**Required bundle fields:**
- project_code
- entry_id
- source_type
- input_type
- captured_at
- image_asset
- prompt_text
- ai_response
- summary
- approval_state
- tags / node links

**Exit criteria:**
- Every capture can be retrieved as a structured bundle.

---

## Milestone 3: context engine and harness routing

### Task 3.1: build the context model

**Objective:** Represent project, node, issue, decision, asset, and capture cleanly.

**Files:**
- Create: `js/context-model.js`
- Create: `js/context-store.js`
- Modify: `structa-cascade.js`

**Responsibilities:**
- current project state
- current blockers
- next recommended action
- latest AI recommendation
- pending approvals
- export candidates

**Exit criteria:**
- The UI can show context without inventing state.

### Task 3.2: route core verbs through the harness

**Objective:** Make build / patch / delete / solve / consolidate / decide / research / withdraw all map to explicit action flows.

**Files:**
- Create: `js/action-flows.js`
- Create: `js/action-router.js`
- Modify: `structa-cascade.js`

**Exit criteria:**
- Each verb maps to a predictable flow.
- Sensitive actions always require approval.

### Task 3.3: add hidden depth and audit provenance to the context layer

**Objective:** Ensure the audit drawer and deeper nodes are not merely decorative.

**Files:**
- Modify: `structa-cascade.js`
- Modify: `index.html`

**Exit criteria:**
- Log entries, context updates, and approvals are visible in the drawer.
- Hidden nodes surface meaningful state, not random detail.

---

## Milestone 4: export and approval flows

### Task 4.1: build email withdrawal workflow

**Objective:** Let users send selected context to email with explicit approval.

**Files:**
- Create: `js/exporter.js`
- Create: `js/email-export.js`
- Modify: `structa-cascade.js`
- Modify: `index.html`

**Required flow:**
1. choose a context bundle
2. preview the export
3. require explicit approval
4. send or hand off
5. log the action

**Exit criteria:**
- Email export is intentional, previewable, and auditable.

### Task 4.2: build journal write workflow

**Objective:** Persist structured memory without making the user think about storage.

**Files:**
- Create: `js/journal.js`
- Modify: `structa-cascade.js`
- Modify: `index.html`

**Exit criteria:**
- Voice or image captures can become journal entries with metadata.

---

## Milestone 5: UX / IX polish and publish readiness

### Task 5.1: refine the home canvas and drawer behavior

**Objective:** Make the screen feel more native and less like a web surface.

**Files:**
- Modify: `index.html`
- Modify: `structa-cascade.js`
- Possibly create: `css/styles.css` if the inline styles become too large

**Focus areas:**
- tap affordance
- hold affordance
- swipe affordance
- drawer collapse/expand behavior
- label minimization
- icon clarity

**Exit criteria:**
- The home face reads instantly.
- The drawer feels integrated and quiet.

### Task 5.2: small-screen interaction pass

**Objective:** Test on-device ergonomics and discoverability.

**Files:**
- Create: `tests/manual-launch-checklist.md`
- Create optionally: `tests/interaction-smoke.js` or similar

**Checklist:**
- node targets are easy to tap
- drawer handle is discoverable but unobtrusive
- camera mode is obvious
- PTT capture is fast
- export preview is readable
- no accidental double triggers

**Exit criteria:**
- The app feels credible in one-hand use.

---

## Suggested task sequence for subagent execution

1. Verify runtime assumptions and native API availability
2. Build the runtime adapter and validation gate
3. Wire PTT / voice capture
4. Wire camera / selfie / capture bundles
5. Build the context store and action router
6. Add email withdrawal and journal persistence
7. Polish the home canvas and drawer
8. Run IX checks on a real device / emulator

---

## What should remain native vs reusable

### Keep native
- camera
- selfie/front/back toggles
- PTT
- short voice replies
- journal writing
- storage-backed capture bundles
- hardware button handling

### Keep reusable
- intent parsing
- approval logic
- validation
- export packaging
- context model
- action routing

### Simulate only when necessary
- unsupported hardware events
- unsupported native email handoff
- unsupported storage or camera APIs

If a primitive is missing, fail gracefully and keep the app usable.

---

## Definition of publishable

Structa is publishable when:
- the native interactions actually work
- the camera can capture, flip to selfie, and store a bundle
- PTT creates structured context reliably
- the audit trail is coherent
- export / email withdrawal is intentional and approved
- the app still feels calm and premium on the R1 screen
- the user can do serious work without fighting the UI

---

## First commit target

When executing, start with:
- `js/rabbit-adapter.js`
- `js/contracts.js`
- `js/validation.js`
- a small refactor in `structa-cascade.js` to route all runtime calls through the adapter

Then commit that as the foundation for the rest.
