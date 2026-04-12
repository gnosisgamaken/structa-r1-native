# Structa R1 Native — Architecture Brief v2

## Goal
Turn Structa from a polished interactive prototype into a real Rabbit-native instrument.

The next version should feel:
- compact
- premium
- deliberate
- touch-first
- quiet by default
- impossible to confuse with a desktop web app

This brief is the architecture contract for the next phase.

## What the audit says, bluntly
The current experience has three problems:

1. The motion model is not doing useful work.
   - It reads as decorative.
   - It does not explain state.
   - It creates confusion instead of hierarchy.

2. The current card logic is not yet native enough.
   - The interface has cards, but not a convincing selected-state stack.
   - The selected item should feel isolated and intentional.
   - The current movement does not map cleanly to Rabbit-native behavior.

3. The typography and system-bar treatment still feel too web-like.
   - Tiny text is off-brand.
   - The top safe area is not being treated as a true native constraint.
   - Page theme-color alone is not enough to control the device system bar.

## Product stance
Structa is not a chat UI.
Structa is not a dashboard.
Structa is not a browser page with widgets.

Structa is a project cognition instrument for Rabbit R1.
It should behave like a physical surface with stable states.

## Non-negotiable rules
- No tiny text anywhere in the primary surface.
- No ornamental motion.
- No horizontal carousel behavior.
- No desktop-style chrome.
- No more than 3 cards should feel active at once.
- One selected card must dominate the surface.
- Bottom log bar may remain, but it must stay quiet and secondary.
- Future imagery / illustration support must be additive, not structural.

## Recommended information architecture

### 1) Top safe area / system band
This is not app content.
It is the device-safe shell.

Responsibilities:
- host native-safe status treatment
- hold app identity in a compact form
- never expose oversized headers
- never invite accidental back taps

Rule:
- if the runtime cannot truly tint the system bar, do not fake it with page content.
- handle it as a native runtime concern or as a safe-area constraint, not as decorative HTML.

### 2) Selected card stack
This becomes the main home surface.

Structure:
- square cards
- single selected card in front
- one card above or below as a preview
- optional third card as a dimmed background state

Behavior:
- selected card is fully readable and actionable
- adjacent cards are partially visible only as context
- movement is minimal and state-driven
- the stack should feel like a native app menu, not a slideshow

### 3) Bottom log drawer
Keep it, but shrink its authority.

Role:
- trace
- audit
- last action summary
- lightweight live status

Do not let it compete with the selected card.

### 4) Capture surface
Capture should remain a first-class path.

Modes:
- voice
- camera
- selfie / front-back switching
- journal / memory write
- withdrawal / export

The capture surface should open from the selected card model, not float independently as a second home.

## Card model
The future home should use a square-card stack.

Suggested model:
- base cards are square
- selected card is centered and visually isolated
- the selected card contains:
  - title
  - short action label
  - one strong visual motif or icon
  - one clear primary action
- the stack can reveal related cards by vertical navigation

The card itself is the unit of meaning.
The motion is only there to make selection legible.

## Visual hierarchy
Use a native-app hierarchy, not a web-card hierarchy.

Priority order:
1. selected card title
2. selected card action
3. supporting icon / illustration
4. log / trace information
5. secondary metadata

Rules:
- avoid tiny supporting text
- avoid long explanatory subtitles
- avoid multiple competing labels on the same card
- prefer one strong title and one compact action tag

## Motion model
The current motion model should be retired.

Replace it with:
- tiny lift on select
- short settle on deselect
- soft depth change between stack positions
- no drifting
- no decorative card orbit
- no continuous animation unless it communicates state

Motion should answer only one question:
“What is selected right now?”

If a motion does not answer that question, remove it.

## Native interaction model

### Tap
- select card
- activate default action on second tap if appropriate

### Swipe vertical
- move through stack items
- change selected card

### Long press
- reveal more actions or deeper context
- only if the card has a real secondary meaning

### PTT
- capture voice into structured intent
- normalize before routing

### Camera
- open camera as a native capture task
- store image + response bundle

### Back / escape
- close overlays
- step back one state
- never be destructive by default

## System bar and safe-area handling
Important technical note:

Page-level `theme-color` is not enough when the requirement is true native bar behavior.
It may affect browser chrome in some contexts, but it will not reliably solve the device-safe area problem.

The architecture should treat this as one of three possibilities:
1. native runtime control of system UI
2. edge-to-edge layout with true inset handling
3. fallback browser approximation only when native control is unavailable

In all cases:
- do not let content touch the top edge carelessly
- do not place important tap targets in the accidental back zone
- do not rely on the browser to behave like a native shell

## Typography and spacing rules
- use larger, calmer type
- no tiny labels in the primary viewport
- no crowded micro-metadata
- keep line count per card low
- favor strong alignment over clever nesting
- allow more breathing room than a typical dashboard

Suggested rule of thumb:
- one card = one primary statement
- one supporting line max
- one primary action max

## What to preserve
Do not throw away the good parts.

Preserve:
- the bottom log concept
- voice and camera entry paths
- approval gating for mutations
- the compact device-sized frame
- the project cognition metaphor
- the ability to later decorate cards with images / illustrations

## What to remove or de-emphasize
- useless movement
- cluttered labels
- overly chatty helper text
- web-like top headers
- tiny text in footers or cards
- any motion that exists only because the UI can animate

## Next architecture phase

### Phase 1 — Structural simplification
- define the square-card stack formally
- define selected state and preview state
- define log drawer as secondary only
- remove motion that is not state-bearing

### Phase 2 — Native shell discipline
- correct system-bar / safe-area strategy
- define top band behavior
- enforce app frame constraints on all sizes

### Phase 3 — Typography and spacing pass
- rebuild text scale
- increase card legibility
- remove all tiny text from primary surfaces

### Phase 4 — Interaction mapping
- tap / swipe / hold / capture / back behavior
- card stack navigation semantics
- selection and action rules

### Phase 5 — Decorative layer
- only after the structure is correct
- images, illustrations, richer card contents
- keep the same hierarchy and stack logic

## Acceptance criteria
This version is good when:
- the screen feels native at a glance
- the selected card is obvious immediately
- the stack has meaning without extra explanation
- there is no confusing decorative motion
- no text feels tiny
- the top safe area feels intentional
- the bottom log remains useful but quiet
- the interface feels like a Rabbit instrument, not a web experiment

## Hard constraints for the team
- Do not add animation unless it carries meaning.
- Do not add text if a stronger visual hierarchy can replace it.
- Do not widen the information architecture without removing something else.
- Do not let the system bar become a decorative header.
- Do not reintroduce desktop UI habits.

## Recommended next deliverable
A formal vNext interaction map with:
- square-card state machine
- selected / preview / hidden rules
- top-safe-area strategy
- log drawer contract
- capture flow mapping
- exact typography scale

That is the right next document before code changes.
