# Structa Phase 2 — Premium Polish + Project Switching

> For Hermes: use this as the source of truth for the next Structa phase after Pass 1 calmness cleanup.

## Goal
Advance Structa from a strong single-project prototype into a premium-feeling project cognition tool with:
- clearer typography hierarchy
- clearer action model
- cleaner surface composition
- a deliberate multi-project switching concept
- sound-system readiness without shipping sounds yet

---

## Current truth

### What is already improved
Pass 1 reduced the worst friction:
- raw visible log noise
- anxious heartbeat narration
- jumpy motion
- tiny log chrome

### What remains unresolved
The product is now attractive and calmer, but still lacks:
1. premium hierarchy
2. one obvious next action per surface
3. a strong empty-state model
4. a true multi-project architecture
5. a prepared sound language system

---

# Multi-project truth audit

## Current implementation status
Structa does NOT yet support true multi-project browsing/switching.

### Evidence in code
- `js/rabbit-adapter.js`
  - stores a single `memory.projectMemory`
  - exposes `getActiveProject()` only
  - `setProjectName()` mutates the single current project
- `js/voice-capture.js`
  - recognizes voice commands like `switch to project X`
- `structa-cascade.js`
  - currently handles `switch-project` by logging:
    - `switch: ... (coming soon)`
  - `new-project` only renames the current project if still untitled
- `structa-cascade.js`
  - shake is already wired via `devicemotion`, but currently only sends the user home when not already on home

## Conclusion
We can support project switching.
But we should NOT fake it with a list over a single-project memory model.

Proper support requires:
1. project registry/storage layer
2. active project selection state
3. project switcher surface
4. migration from single `projectMemory` into `projects[] + active_project_id`

---

# Product decision: brutal project list

## Proposed interaction
From HOME / stack page:
- shake opens a brutal project list
- list is intentionally simple, fast, and almost severe
- user scrolls through projects
- side click / tap opens selected project
- shake again or back dismisses list

## Why this is right
This fits Structa well because:
- the home stack stays emotional and premium
- project switching becomes explicit and memorable
- the switcher can be utilitarian without contaminating the main surfaces
- it gives the product a hidden but powerful operator affordance

## Desired tone
The project list should feel:
- blunt
- fast
- high-control
- low-decoration
- almost terminal-like, but still premium

Not:
- cute
- card-heavy
- dashboard-like
- over-animated

## Suggested structure
Project switcher contents:
- title: `projects`
- optional tiny subtitle: `shake to close`
- vertically stacked project rows
- each row shows:
  - project name
  - type or short status
  - maybe one tiny activity marker
- active project clearly marked

## Interaction model
When switcher is open:
- scroll wheel / scrollUp / scrollDown → move selection
- sideClick / tap → activate selected project
- back / shake → dismiss switcher
- long press optional later for create/archive, not in v1

## V1 rule
No mutations from the list in first pass.
Only:
- browse
- select
- close

This keeps it brutal and safe.

---

# Architecture needed for real project switching

## New memory model
Replace single-project assumption with:

```js
memory = {
  active_project_id: 'project_x',
  projects: [
    {
      project_id: 'project_x',
      name: 'atlas',
      type: 'software',
      user_role: 'operator',
      created_at: '...',
      updated_at: '...',
      projectMemory: { ...existing project structure... },
      journals: [...optional per-project],
      captures: [...optional per-project summary refs]
    }
  ],
  uiState: { ... },
  logs: [...global visible logs],
  assets: [...shared or scoped],
}
```

## Migration strategy
On load:
- if legacy `memory.projectMemory` exists and `projects` does not,
- create one default project entry from legacy memory,
- set it as `active_project_id`,
- preserve current behavior.

This keeps old installs working.

## Adapter layer additions
Add to `js/rabbit-adapter.js`:
- `getProjects()`
- `getActiveProjectId()`
- `switchProject(projectId)`
- `createProject(name, type?)`
- `ensureProjectRegistry()`
- `getActiveProjectRecord()`

Then refactor existing methods like:
- `touchProjectMemory()`
- `getProjectMemory()`
- `setProjectName()`
- `setProjectType()`
- `setUserRole()`
- `addNode()` / `resolveNode()`

So they operate on the active project record instead of a single root singleton.

---

# New state: PROJECT_SWITCHER

## State-machine addition
Add a dedicated state:

```js
PROJECT_SWITCHER: 'project_switcher'
```

## State data

```js
stateData = {
  projectListIndex: 0,
  projectListScrollOffset: 0
}
```

## Entry behavior
When entering `PROJECT_SWITCHER`:
- capture currently active project index
- set selection to active project row
- suppress home-card movement
- suppress home drawer leakage

## Exit behavior
When exiting `PROJECT_SWITCHER`:
- restore prior state to HOME
- keep selected home card stable
- no extra animation drama

---

# Surface-by-surface premium polish priorities

## 1. HOME
### Goal
Make home feel like the app you want to reopen constantly.

### Required changes
- stronger title/lockup hierarchy
- more precise front-card padding
- cleaner hero card typography
- clearer footer behavior
- if empty-state text exists, it must feel intentional
- if the project switcher exists, home should hint at project identity but not become a dashboard

### Rule
HOME should stay iconic, not informationally crowded.

## 2. SHOW
### Goal
Make visual memory feel premium and real.

### Required changes
- stronger hero image/capture layout
- better capture empty state
- clearer primary action
- better recent-strip composition
- more obvious saved-state feedback

## 3. TELL
### Goal
Make voice feel elegant, native, and trustworthy.

### Required changes
- stronger hold-to-speak action row
- cleaner recent voice history layout
- better empty state
- calmer transcript/review hierarchy

## 4. NOW
### Goal
Make next-action / decision space feel operational and sharp.

### Required changes
- one obvious current decision/action
- reduced semantic clutter
- better hierarchy between pending / resolved / suggested
- no abstract decision theatre

## 5. KNOW
### Goal
Make retrieval fast and legible.

### Required changes
- stronger lane hierarchy
- clearer result item structure
- less chip clutter
- clearer detail entry affordance

---

# Typography + layout hierarchy rules for Phase 2

## Rule 1
Each surface gets exactly 3 text levels max:
- title
- primary body/action
- secondary metadata

## Rule 2
No truncated meaningful copy in hero areas.
If a phrase cannot fit elegantly, rewrite it.

## Rule 3
Primary actions must be optically stronger than labels.

## Rule 4
Footer / lower strips must feel designed, not leftover.

## Rule 5
The emotional hero and the operational action cannot compete.
One must lead.

---

# Action model redesign

## Product principle
Every surface should answer:
- what am I looking at?
- what can I do now?
- what happens if I scroll / click / hold?

## Per-surface action rule
### HOME
One dominant open action, not many.

### SHOW
One dominant capture/review action.

### TELL
One dominant speak action.

### NOW
One dominant next-move / decision action.

### KNOW
One dominant browse/open-detail action.

## Anti-pattern
No decorative pseudo-controls.
No mysterious dashes or fragments that look tappable but mean nothing.

---

# Sound readiness plan (no implementation yet)

## Goal
Prepare Structa so sound can be added later without architectural rework.

## What to do now
Do NOT wire actual Mii sounds yet.
Instead, prepare:

### 1. Cue taxonomy
Define stable cue slots:
- `appOpen`
- `focusMove`
- `saveConfirm`
- `resultReady`
- `closeBack`
- `aliveRare`

### 2. Trigger policy
Each cue should have:
- allowed states
- cooldown
- suppression conditions
- max repeat behavior

### 3. Sound facade
A single audio facade should own sound playback decisions.
Do not scatter `play('sound')` across the app.

Suggested API:

```js
StructaAudio.playCue('appOpen')
StructaAudio.playCue('saveConfirm')
StructaAudio.playCue('resultReady')
```

### 4. Cooldown rules
Especially for `aliveRare`:
- foreground only
- no more than once per 60–120s
- only when something meaningful changed
- never on every heartbeat

## Phase 2 output
At the end of this phase, the codebase should be READY for sound design,
but should not yet contain final sound assets or cue spam.

---

# Recommended implementation order

## Phase 2A — architecture first
1. add project registry model
2. add migration from legacy single-project memory
3. add `switchProject()` adapter support
4. add `PROJECT_SWITCHER` state
5. make shake open switcher from HOME

## Phase 2B — premium home polish
1. home hierarchy
2. hero card typography
3. footer / empty state redesign
4. project identity integration

## Phase 2C — surface polish
1. SHOW
2. TELL
3. NOW
4. KNOW

## Phase 2D — sound readiness only
1. add cue taxonomy
2. add trigger rules
3. add facade / cooldown skeleton
4. no final sounds yet

---

# Acceptance criteria

## Multi-project
- legacy users still see their current project intact
- more than one project can exist in memory
- project switcher opens from HOME via shake
- project switching actually changes active memory
- `switch to project X` no longer says `coming soon`

## Premium polish
- clearer hierarchy on HOME
- one obvious next action per surface
- lower strips / empty states feel designed
- no accidental-looking control fragments

## Sound readiness
- cue slots exist
- trigger rules exist
- no sound spam
- ready to drop in curated Mii candidates later

---

# My product call
The brutal shake-to-project-list idea is good.
It is exactly the kind of hidden-power interaction that makes Structa feel special.

But it should be real.
Not a fake list over a single project.

So the right move is:
- architecture first
- then switcher
- then premium surface polish
- then sound layer
