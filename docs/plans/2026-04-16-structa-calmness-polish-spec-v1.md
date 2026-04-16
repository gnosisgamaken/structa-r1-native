# Structa Calmness + Polish Spec v1

> For Hermes: use this as the source of truth for the next polish phase. The goal is not to make Structa louder or smarter-looking. The goal is to make it calmer, clearer, more precise, and more trustworthy on Rabbit R1.

## Goal
Transform the current strong harness/architecture build into a calm, premium, low-anxiety Rabbit R1 tool.

## Product stance
Structa is not a debug console.
Structa is not a nervous AI narrator.
Structa is not a decision machine that performs its own intensity.

Structa should feel like:
- peace of mind
- clarity
- gentle control
- grounded momentum
- quiet intelligence

## Core diagnosis
The current build is architecturally strong but emotionally and visually under-tuned.

The main issues are:
1. Tiny text and weak hierarchy
2. Logs exposed as raw telemetry instead of product language
3. Heartbeat is too explicit and too talkative
4. Motion is too springy / high-amplitude for a precision tool
5. Surfaces mix too much state, metadata, and action
6. The system over-exposes its own internal churn
7. The app can feel cool and alive, but not yet calm and trustworthy

---

# Non-negotiable product rules

## Rule 1: No tiny text on primary surfaces
If a user cannot read it instantly on-device, it must be enlarged, simplified, or removed.

Immediate implications:
- log text must increase from current 9px treatment
- muted metadata must still be legible
- footer/status micro-telemetry should be removed or redesigned
- primary action text should never be smaller than supporting labels

## Rule 2: One obvious next action per screen
Every surface must make the next move obvious.
No ambiguous clusters like `approve / skip / next` without hard semantic separation.

## Rule 3: Visible logs must be human-facing, not pipeline-facing
Current user-visible logs leak implementation language.
That must stop.

Visible logs must communicate:
- what happened
- whether the user should care
- whether the system is calm / ready / waiting

Visible logs must not expose:
- duplicated machine words
- contradictory internal status chatter
- raw STT prefixes
- implementation terms like `decision decision`, `capture capture`, `stt`, `bpm`
- privacy-sensitive actions without clear context framing

## Rule 4: Heartbeat defaults to quiet
Heartbeat should mostly act in the background.
It should not repeatedly speak.
It should not theatrically announce itself.
It should not generate anxiety.

## Rule 5: Motion must feel anchored and reassuring
No exaggerated bounce. No big jumps. No cartoon urgency.
Animation should communicate state change with low amplitude and short duration.

## Rule 6: The app must not make the user babysit the AI
The system can think in the background.
The user should only see distilled useful deltas.

---

# Priority problems to solve

## P0 — raw log surface is product-breaking
### Evidence in current code
- `structa-cascade.js:133-216` renders visible log rows directly from raw messages
- `r1-llm.js:91` logs STT as `stt: ...`
- `impact-chain-engine.js:175-177` logs `type + ': ' + output`
- `impact-chain-engine.js:209-226` creates noisy public-facing decision events + TTS
- screenshots show duplicate phrases, broken wording, and contradictory states

### Desired behavior
Visible logs should become a calm event feed.

Allowed visible events:
- voice saved
- image saved
- visual note ready
- insight added
- decision ready
- waiting for you
- capture reviewed
- question answered
- project updated

Disallowed visible events:
- `decision decision skipped`
- `capture capture`
- `stt: ...`
- `beat 10: 0 stale, 1 open`
- `started at 10 bph`
- `system chain speed: 2bpm`
- raw LLM strings
- ready/failed pairs shown back-to-back without interpretation

### Implementation direction
Introduce a visible-log formatter layer before appending rows.

Suggested new concept:
- `formatVisibleLog(entry)`
- `shouldShowVisibleLog(entry)`
- map raw event kinds/messages into short, stable, user-safe phrases
- dedupe similar entries within a short window
- collapse repeated machine events into one meaningful outcome

---

## P0 — heartbeat must stop sounding anxious
### Evidence in current code
- `heartbeat.js` logs every beat and suggestions
- `impact-chain-engine.js` runs every 15s by default (`bpm: 4` where comments mean beats/min)
- `impact-chain-engine.js:218-226` sends spoken `new decision ready`
- current product behavior drifts toward recursive meta-decisions

### Desired behavior
Heartbeat should be:
- mostly invisible
- silent by default
- useful when it surfaces something
- focused on synthesis, not self-description

### Heartbeat policy v1
1. No repeating spoken phrases
2. No default spoken response on routine beats
3. Only surface an event when one of these happens:
   - a genuinely new insight was extracted
   - a real user-facing question needs answer
   - a decision is ready and distinct
   - a capture was processed into something useful
4. Background beats should not create visible noise when nothing important changed
5. Heartbeat frequency should be calmer than the current “every 15 seconds with visible churn” behavior

### Intelligence policy v1
Heartbeat should optimize for:
- quiet context consolidation
- gap detection
- useful next-move shaping
- preparing material for the user

Heartbeat should avoid:
- decisions about decisions
- repeated self-reasoning loops
- visible overactivity
- “let’s calculate”-style filler or synthetic hype

---

## P0 — motion language must be rewritten
### Evidence in current code
- `index.html:466-494` defines spring bounce / urgent jump animations
- `structa-cascade.js:548-557` applies spring notifications to home cards
- user reports cards jumping too high and feeling wrong

### Desired behavior
Motion should feel:
- precise
- weighted
- low amplitude
- confidence-building
- almost architectural

### Motion rules v1
1. Remove bounce language from card notifications
2. Replace vertical jump with subtle scale or 1-2px settle
3. Keep duration short (120–180ms range)
4. Avoid overshoot curves that feel playful or unstable
5. Home card movement should never feel like “look at me!”
6. Heartbeat-related motion should be nearly subliminal

### Suggested replacements
- `spring-bounce` → soft scale pulse (1.00 → 1.02 → 1.00)
- `spring-urgent` → subtle emphasis (1.00 → 1.03 + slight opacity/accent shift)
- no `translateY(-4px)` jumps on a tiny precision screen

---

## P0 — text hierarchy and scale need a reset
### Evidence in current code
- `index.html` uses 9px and 10px widely in log chrome
- screenshots show tiny metadata and weak distinction between important vs secondary content
- large titles coexist with undersized actions

### Desired behavior
Define a brutally simple type system for the 240×292 viewport.

### Type rules v1
- Display title: only for page identity, not decoration
- Section title: one stable size
- Body/action text: one stable readable size
- Metadata: one smaller but still readable size
- No 9px user-facing primary text

### Practical recommendations
- collapsed log strip: 11–12px max, but extremely short
- expanded log content: 10–11px minimum with better line-height and timestamp demotion
- remove or rewrite tiny footer telemetry on surfaces like tell/know/now
- do not let titles consume space that actions need

---

## P1 — now/know/tell/show surfaces need cleaner role separation
### Current issue
The surfaces are conceptually promising but still mix:
- section identity
- category/filter chips
- metadata
- internal system state
- action prompts

This leads to “interesting but not settled.”

### Surface goals
#### HOME
- launcher / orientation / calm glanceability
- no telemetry chatter
- one obvious selected card
- secondary cards should remain secondary

#### NOW
- the actionable next move
- no abstract decision theatre
- one strong decision/action at a time
- no cramped triads

#### KNOW
- retrieval and review
- not a mini-dashboard
- no cryptic taxonomy overload
- top controls must be sparse and obvious

#### TELL
- calm input surface
- one strong speak action
- recent voice entries shown clearly
- no tiny summary junk

#### SHOW
- visual capture and recent images
- confidence that a capture was actually saved
- no ambiguous half-state

---

## P1 — wording should stop sounding like internal lore
Terms like `signals`, `loops`, `decision arena`, and raw operational labels can work only if the surface is crystal clear.
Right now they often increase ambiguity.

### Language rules v1
Prefer:
- clear
- human
- short
- operational
- emotionally steady

Avoid:
- machine poetry without support
- internal architecture language in user surfaces
- jargon that sounds diagnostic or surveillant

---

# Immediate implementation pass

## Pass 1 — calm the app
This should happen before any larger visual redesign.

### Task group A — visible logs cleanup
Files:
- `structa-cascade.js`
- `js/r1-llm.js`
- `js/impact-chain-engine.js`
- `js/rabbit-adapter.js` (if needed for visible log filtering)

Changes:
1. Add visible-log normalization layer
2. Remove raw `stt:` logs from visible stream
3. Remove duplicate/contradictory visible events
4. Replace machine labels with user-facing phrases
5. Dedupe repeated similar messages within short windows
6. Ensure timestamps format consistently

### Task group B — heartbeat quieting
Files:
- `js/heartbeat.js`
- `js/impact-chain-engine.js`
- `js/r1-llm.js`

Changes:
1. Turn off routine spoken heartbeat responses
2. Reduce visible heartbeat log spam
3. Gate visible heartbeat events behind meaningful changes
4. Lower aggressiveness of default chain behavior
5. Stop recursive “decision about decisions” churn where possible

### Task group C — motion calm-down
Files:
- `index.html`
- maybe `structa-cascade.js`

Changes:
1. Replace spring bounce / urgent jump animations
2. Remove exaggerated translateY movement
3. Keep only subtle anchored emphasis
4. Ensure heartbeat-related motion is quiet

### Task group D — tiny text removal in chrome/log surfaces
Files:
- `index.html`
- `structa-cascade.js`

Changes:
1. Remove 9px user-facing log treatment
2. Improve row spacing/indentation
3. Make timestamp less dominant but readable
4. Make collapsed log strip simpler and calmer

---

# File-by-file guidance

## `index.html`
Primary targets:
- `#log-drawer`
- `#log-handle`
- `#log-preview`
- `#log`
- `.entry`
- `.muted`
- `.accent`
- spring animation keyframes

Change goals:
- bigger, calmer log typography
- less toy-like animation
- less visual chatter in collapsed state

## `structa-cascade.js`
Primary targets:
- `pushLog()`
- `refreshLogFromMemory()`
- `setLogDrawer()`
- `notifyCard()`
- home/now/know/tell/show status text builders

Change goals:
- visible-log formatting
- dedupe and state cleanup
- less noisy status copy
- calmer card notifications

## `js/heartbeat.js`
Primary targets:
- `start()` / `beat()` visible log generation
- suggestion surfacing

Change goals:
- no routine chatter
- no exposed machine rhythm
- only meaningful outcomes surface

## `js/impact-chain-engine.js`
Primary targets:
- chain defaults
- phase behavior
- `storeImpact()`
- `storeDecision()`
- TTS trigger

Change goals:
- make chain feel quietly useful, not performatively alive
- remove exposed process noise
- cut anxiety-inducing announcements

## `js/r1-llm.js`
Primary targets:
- `window.onPluginMessage` STT logging
- sanitization and extraction

Change goals:
- reduce raw pipeline leakage into visible UX
- keep technical trace internal if needed

---

# Acceptance criteria for the next pass

## Visual
- no tiny unreadable user-facing text in primary surfaces
- no visible debug-looking braces or raw fragments
- no large bounce/jump motion on cards
- logs feel composed rather than dumped

## Emotional
- heartbeat feels calm
- no repetitive spoken filler
- app feels quieter and more controlled
- user no longer feels they need to monitor the machine constantly

## Product
- visible events are understandable
- one obvious next move per surface
- surfaces feel more intentional and less compressed

---

# Definition of success
After Pass 1, Structa should feel:
- less like a cool prototype
- less like a debug instrument
- less like an anxious AI system
- more like a trustworthy, quiet, high-control tool

That still will not be the final perfect app.
But it will create the right emotional and visual foundation for the later premium layout pass.

---

# Recommended next step
Implement Pass 1 now:
1. visible log cleanup
2. heartbeat quieting
3. motion calm-down
4. tiny text removal in log chrome

This is the highest-leverage work and directly matches the device feedback.