# Structa R1 Native Interaction Spec v1

## 1. Purpose

Structa R1 Native is a creative-professional project cognition system for Rabbit R1.
It should feel like a native instrument, not a web app:
- fast to understand
- quiet by default
- gesture-rich
- voice-first when needed
- structured for serious work
- beautiful enough to invite use, but disciplined enough to handle real operations

This spec defines the full interaction model before deeper harness integration.
It is the source of truth for what the user can do, what the app should do, and how Rabbit-native features map into product behavior.

## 2. Design principles

1. Native first
- Every major interaction should feel like it belongs on the R1.
- Prefer direct device gestures and hardware actions over on-screen controls.

2. Silent by default
- The UI should not chatter.
- Spoken replies should be short and only used when they add clarity.

3. Structured over conversational
- Free-form input must be converted into structured intent.
- The system should preserve the original capture, but act on the normalized form.

4. Context is the product
- Captures, images, voice, and decisions should all become project context.
- The app should consolidate, not scatter.

5. Human approval for mutation
- Drafting, staging, summarizing, and indexing can happen automatically.
- Destructive or externally visible actions require explicit approval.

6. Beautiful but serious
- The visual language can feel game-like.
- The behavior must feel like production software for creative professionals.

## 3. Core surfaces

The app has five primary surfaces:

1. Home canvas
- 4 visible primary nodes
- hidden deeper nodes available by reveal gestures
- no clutter
- no chat history dominating the view

2. Audit drawer
- collapsed by default
- expands for logs, decisions, and traces
- swipe-up to open, swipe-down to close

3. Capture surface
- microphone capture
- camera capture
- image-to-text capture
- quick intent creation

4. Context surface
- project state
- nodes, issues, decisions, assets
- current blockers
- next recommended action

5. Export surface
- email withdrawal
- journal write
- image + response packaging
- handoff artifacts for external use

## 4. Interaction vocabulary

Core verbs:
- build
- patch
- delete
- solve
- inspect
- consolidate
- decide
- research
- withdraw
- approve
- rollback
- capture
- export
- journal
- email

The app can show supporting verbs in UI, but these are the primary action classes.

## 5. Input and control matrix

### 5.1 Touch / tap

Tap on a primary node:
- select the node
- show its immediate state
- update the context focus

Tap selected node again:
- trigger the node’s default action
- usually open, inspect, or begin its sequence

Tap outside active content:
- dismiss overlays
- collapse the drawer if open
- return focus to home state if appropriate

### 5.2 Hold / long press

Hold CORE or MEMORY:
- reveal the deeper layer
- expose contract / validator or equivalent hidden nodes
- preserve the current selection state

Hold on a selected node for longer than the reveal threshold:
- open an expanded contextual card
- show extra metadata
- optionally expose related actions

Hold should feel intentional, not accidental.
The threshold should be in the low-400ms range, not too long.

### 5.3 Swipe

Horizontal swipe on the main canvas:
- move between primary nodes
- cycle focus without opening menus

Vertical swipe up on the audit drawer handle:
- expand the drawer

Vertical swipe down on the audit drawer handle:
- collapse the drawer

Vertical swipe on content area:
- only if unambiguous and not competing with scrolling
- can be mapped later to quick context actions or capture shortcuts

### 5.4 Scroll wheel / rotary input

If hardware scroll or wheel input is available:
- cycle visible nodes
- scroll through context items when inside lists
- nudge through capture options in compact mode

Scroll should never feel like page scrolling in a browser.
It should feel like moving through a device state machine.

### 5.5 Physical buttons / hardware keys

PTT button:
- begin voice capture
- hold to talk
- release to submit transcription to the harness

Back button / Escape:
- close overlays
- collapse drawer
- step back one context level
- if already at the home face, do nothing destructive

Enter / confirm:
- trigger the selected item
- confirm a proposed action

Arrow keys:
- cycle between nodes and focus states

### 5.6 Microphone / voice input

Microphone capture is the default fast entry path.
The user can speak naturally, but the system must normalize what is said into structure.

Voice flow:
1. press PTT
2. speak
3. transcribe
4. normalize into intent
5. route to context / action / approval pipeline

Voice should support:
- quick capture
- project commands
- context questions
- dictation for notes
- export instructions
- approval prompts

### 5.7 Camera

Camera is a first-class interaction.
This is important, not optional.

Camera capabilities should include:
- activate camera from the app
- rotate to selfie position when requested
- capture scene/image as prompt input
- capture a document, workspace, whiteboard, object, or reference
- store the image with the associated AI response and metadata
- optionally generate text from the image and attach it to the project context

Camera use cases:
- capture visual context from the field
- identify whiteboards, sketches, packaging, signage, environments
- create a visual prompt for the model
- attach image evidence to a decision or issue
- build a project memory trail that includes photos + analysis

Camera flow:
1. user opens camera
2. app enters capture mode
3. user can switch front/back or rotate to selfie
4. user captures image
5. image is sent through the local validation path
6. image is optionally transcribed / described into text
7. result is stored as a context asset
8. the AI response is attached to the capture
9. the capture can be summarized, exported, or journaled

Camera storage requirements:
- store original image
- store a generated text description or OCR output if available
- store the linked prompt
- store the AI response
- store project code and entry id
- store timestamp and capture type

### 5.8 Tilt / gyroscope / motion

Tilt should be an optional secondary gesture, not a core dependency.
Use it for delightful, lightweight behaviors only.

Possible mappings:
- subtle tilt to shift focus between nearby nodes
- stronger tilt to reveal a secondary panel
- shake to request a new node suggestion
- tilt to change emphasis or mood in creative mode

Rules:
- never make tilt required for core navigation
- never bind critical actions to tilt alone
- keep motion feedback subtle

## 6. Rabbit-native interaction model

This section defines what should be native to Rabbit R1 rather than simulated as desktop UI.

Rabbit-native interactions:
- PTT capture
- short spoken response
- journal entry generation
- camera capture
- camera selfie flip / rotation
- hardware button handling
- scroll wheel / touch navigation
- compact native confirmations
- storage-backed memory
- image prompt handling

Provider-agnostic harness logic:
- intent parsing
- approval rules
- prompt normalization
- response validation
- context compression
- action routing
- asset indexing
- export packaging

The UI should call into the native layer, but the harness should remain reusable.

## 7. Action flows

### 7.1 Inspect

Use when the user wants to understand something.
Possible triggers:
- tap a node
- ask a question by voice
- open a project card
- capture an image for analysis

Result:
- show context
- provide summary
- list blockers
- surface next action

### 7.2 Build

Use when the user wants structure created.
Examples:
- new project skeleton
- new node tree
- new issue set
- new context bundle

Result:
- propose structure
- ask for approval if it mutates persistent data
- stage changes before commit

### 7.3 Patch

Use when the user wants to improve or refine something.
Examples:
- adjust a project note
- revise context
- update a decision
- change an image caption or interpretation

Result:
- show diff-like summary
- require approval when the patch affects live data

### 7.4 Delete

Use when the user wants removal.
Examples:
- delete a node
- remove a capture
- remove a stale draft

Result:
- always show a confirmation step
- show what will be lost
- preserve audit trail unless explicitly deleted by policy

### 7.5 Solve

Use when the user wants the system to reason through a problem.
Examples:
- prioritize blockers
- resolve an issue chain
- interpret an image
- suggest the next move

Result:
- structured answer
- recommendations
- confidence / uncertainty
- optional follow-up action proposal

### 7.6 Consolidate

Use when multiple fragments need merging.
Examples:
- multiple notes into one project summary
- multiple photos into a single context bundle
- scattered ideas into a decision card

Result:
- canonical summary
- linked sources
- duplicate detection
- export options

### 7.7 Decide

Use when the user wants a recommendation turned into a choice.
Examples:
- choose between options
- accept a plan
- lock in a direction

Result:
- best option
- why it wins
- what stays open
- approval needed if action follows

### 7.8 Research

Use when the user wants the app to gather context or draft research notes.
Examples:
- research a venue
- research a product
- research a competitor

Result:
- indexed research context
- source links if available
- summary
- action suggestions

### 7.9 Withdraw / export

Use when context needs to leave the app.
Targets:
- email
- journal
- clipboard if supported later
- share sheet if supported later

Result:
- package context into a clean artifact
- include selected node(s), summary, and attachments
- user approves before sending externally

## 8. Camera-specific flows

### 8.1 Photo as prompt

User takes a photo.
The photo becomes a prompt input, not just an attachment.

Pipeline:
1. capture image
2. optionally rotate front camera to selfie if requested
3. preprocess and validate locally
4. send image + context envelope
5. generate description / text extraction
6. produce structured response
7. store both image and response together

### 8.2 Selfie mode

Selfie mode is a deliberate camera state.
Use it when the user wants:
- themselves in the capture
- a face-to-context note
- a spoken update with image context
- a quick reflective project memo

Selfie mode behavior:
- switch to front camera
- show a clear visual cue
- preserve the last used project context
- keep it quick, not buried in settings

### 8.3 Visual context capture

This is the field-work mode.
Use it for:
- whiteboards
- site visits
- signage
- physical objects
- environments
- packaging
- menu boards
- paperwork

System behavior:
- capture
- describe
- extract text when possible
- classify the image into project context
- attach to a node, issue, or decision

### 8.4 Image memory bundle

Every stored capture should be represented as a bundle:
- image
- transcription / description
- prompt or intent
- AI response
- project code
- entry id
- source type
- timestamp
- approval state

This makes the image retrievable later as a project memory, not just a camera roll item.

## 9. Voice, journal, and email integration

### 9.1 Voice to journal

If the user speaks a note, the app should:
- transcribe it
- normalize it
- optionally write a journal entry
- optionally link it to a node or capture

### 9.2 Voice to email

If the user says to send context to email:
- package the selected context
- show a short preview
- require confirmation
- send only the approved bundle

### 9.3 Image to journal

If a photo is meaningful:
- write the AI description to journal
- link the image asset
- store the response and timestamp

## 10. Context model

Every interaction should try to enrich one or more of these objects:
- project
- node
- issue
- decision
- asset
- capture
- journal entry
- export package

Required fields for an action or capture object:
- project_code
- entry_id
- source_type
- input_type
- intent
- target
- summary
- attachments
- approval_state
- created_at
- updated_at

## 11. UI state model

### 11.1 Home state
- 4 primary nodes visible
- drawer collapsed
- no active modal
- no extra chrome

### 11.2 Focus state
- one node selected
- related context visible
- hidden nodes may appear if appropriate

### 11.3 Capture state
- voice capture active or camera active
- live input focused
- background content remains calm

### 11.4 Review state
- user sees a structured proposal
- accepts, edits, or rejects

### 11.5 Export state
- preview bundle ready
- user approves email / withdrawal

## 12. Approval rules

No surprise execution.

Needs explicit approval:
- delete
- email send
- external export
- mutation of persistent project data
- replacing an existing asset
- any action that affects the user’s record outside the current session

Can happen automatically:
- summarization
- transcription
- description generation
- indexing
- local draft creation
- local context linking

## 13. Native feedback rules

Feedback should be short and immediate.
Examples:
- “Captured.”
- “Saved to journal.”
- “Ready to send.”
- “Photo linked.”
- “Context updated.”
- “Approve to export.”

Do not ramble.
Do not explain the obvious.

## 14. Logging and audit behavior

The audit log should:
- stay collapsed by default
- open with swipe or tap
- show the latest actions
- make it easy to review what happened
- remain visually quiet

Important log entries:
- voice captured
- image captured
- journal written
- approval requested
- export sent
- context bundled
- action rejected
- validation failed

## 15. UX constraints for the R1 screen

- Keep touch targets usable on a small portrait display
- Prefer one action per screen region
- Avoid dense menus
- Keep labels minimal
- Make icons and shapes do the communication
- Preserve the sense of a designed object
- Avoid desktop UI habits

## 16. Phased implementation plan

### Phase A — Interaction contract
- define all triggers
- define all native actions
- map hardware to app behaviors
- freeze the approval rules

### Phase B — Adapter layer
- wire Rabbit SDK primitives
- support PTT, camera, storage, journal, voice replies
- validate before sending to the LLM

### Phase C — Capture pipeline
- voice capture to structured intent
- camera capture to image prompt
- image response bundle storage

### Phase D — Context engine
- project/node/issue/decision model
- email withdrawal
- audit trail
- persistent memory index

### Phase E — IX testing
- small screen usability
- gesture accuracy
- camera flow speed
- voice flow reliability
- export friction
- recovery from wrong taps or cancelled captures

### Phase F — Creative-professional workflows
- build
- open
- consolidate
- decide
- research
- withdraw
- field capture with images

## 17. Open questions to resolve in the SDK adapter

These need verification against the exact Rabbit SDK / creation runtime:
- exact PTT event names and lifecycle
- exact camera API for front/back switching and selfie rotation
- image storage and retrieval primitives
- journal entry persistence API
- hardware scroll / wheel event names
- tilt / gyroscope event availability and thresholds
- best way to attach metadata to a capture bundle
- best way to send context to email or native sharing
- whether audio capture can be paired with an image prompt in one session

## 18. Definition of done for this interaction layer

The layer is complete when:
- every major hardware / sensor interaction is mapped
- camera is first-class and supports selfie rotation
- captures can become structured context
- images can be stored with AI responses
- voice is short, natural, and structured
- the audit drawer stays quiet by default
- approval gates are explicit
- the app feels native on R1 instead of like a browser

## 19. Final statement

Structa should feel like a creative instrument that can think, capture, and organize.
The user should be able to move from idea, to image, to context, to decision, to email without the app ever feeling like a noisy chatbot.

That is the target.
