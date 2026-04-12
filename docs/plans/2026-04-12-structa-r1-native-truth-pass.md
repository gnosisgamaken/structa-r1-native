# structa r1 native truth pass implementation plan

> for hermes: this plan exists to stop guessing. verify the rabbit runtime first, then redesign the home composition and hardware flows from observed truth.

goal: turn structa from a browser-shaped prototype into a rabbit-r1-native app with verified hardware event wiring, corrected spatial composition, and a practical project follow-up loop.

architecture: split the next pass into three layers. first, add a runtime probe layer that records real rabbit sdk events and payloads. second, reset the home composition so it only shows the card stack and a minimal audit preview. third, rebuild show, tell, know, and now around verified hardware events rather than browser assumptions.

tech stack: plain html, svg, vanilla js, rabbit runtime bridge via PluginMessageHandler, creationStorage fallback, localStorage fallback, browser verification, real device verification.

---

## hard truths from the last device review

- top spacing is wasteful and the app name sits too low
- the home scene mixes too many concerns at once
- overlapping card layers are reducing readability instead of creating hierarchy
- logs are too visible and too wide
- native system back is not returning to home reliably
- wheel does not control the right surface at the right time
- ptt is being listened to in logs but not producing the right hardware-first outcomes
- camera is still behaving like a browser overlay, not a rabbit-native capture state
- we are logging synthetic states more confidently than we are proving native runtime behavior

## non-negotiables for this pass

- lower-case only everywhere visible
- powergrotesk-regular only
- no fake in-app back arrow
- no explanatory helper text on home cards
- no extra camera or voice wrappers
- native back must return to home from anywhere inside the app
- ptt must be hardware-first
- wheel must be hardware-first
- each rabbit device remains scoped to its own project memory

---

## milestone 0: preserve the current branch point

### task 0.1: tag the current state before the truth pass

objective: create a safe return point before rewriting behavior.

files:
- none

step 1: create a lightweight checkpoint tag
run:
`git tag structa-pre-truth-pass-2026-04-12`

step 2: verify the tag exists
run:
`git tag --list | grep structa-pre-truth-pass-2026-04-12`
expected:
- one matching line

step 3: push the tag
run:
`git push origin structa-pre-truth-pass-2026-04-12`

---

## milestone 1: rabbit runtime probe

### task 1.1: create a dedicated probe module

objective: capture and display the exact native events the rabbit runtime actually emits.

files:
- create: `js/rabbit-runtime-probe.js`
- modify: `index.html`
- modify: `js/rabbit-adapter.js`

step 1: create the probe file with one public surface

implementation sketch:
```js
(() => {
  const state = {
    events: [],
    listeners: [],
    active: false
  };

  function record(source, name, payload = null) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source,
      name,
      payload,
      created_at: new Date().toISOString()
    };
    state.events.push(entry);
    state.events = state.events.slice(-120);
    window.dispatchEvent(new CustomEvent('structa-probe-event', { detail: entry }));
    return entry;
  }

  function attachWindowListener(name) {
    const handler = event => record('window', name, event?.detail || null);
    window.addEventListener(name, handler);
    state.listeners.push(() => window.removeEventListener(name, handler));
  }

  function attachDocumentListener(name) {
    const handler = event => record('document', name, {
      key: event?.key,
      code: event?.code,
      deltaY: event?.deltaY
    });
    document.addEventListener(name, handler, { passive: false });
    state.listeners.push(() => document.removeEventListener(name, handler, { passive: false }));
  }

  function attachPluginWrapper() {
    const bridge = window.PluginMessageHandler;
    if (!bridge || typeof bridge.postMessage !== 'function') return;
    const original = bridge.postMessage.bind(bridge);
    bridge.postMessage = payload => {
      record('bridge-out', 'PluginMessageHandler.postMessage', payload);
      return original(payload);
    };
  }

  function start() {
    if (state.active) return;
    state.active = true;
    [
      'backbutton',
      'scrollUp',
      'scrollDown',
      'sideClick',
      'longPressStart',
      'longPressEnd',
      'pttStart',
      'pttEnd'
    ].forEach(attachWindowListener);
    ['keydown', 'wheel', 'pointerdown', 'pointerup'].forEach(attachDocumentListener);
    attachPluginWrapper();
    record('probe', 'started', { userAgent: navigator.userAgent });
  }

  function stop() {
    state.listeners.splice(0).forEach(dispose => dispose());
    state.active = false;
    record('probe', 'stopped');
  }

  function getEvents() {
    return [...state.events];
  }

  window.StructaRuntimeProbe = Object.freeze({ start, stop, getEvents, record });
})();
```

step 2: load it before rabbit-adapter.js in `index.html`

step 3: call `window.StructaRuntimeProbe.start()` during app boot when probe mode is enabled

step 4: append probe events into adapter memory so they can be exported later

step 5: commit
```bash
git add index.html js/rabbit-runtime-probe.js js/rabbit-adapter.js
git commit -m "feat: add rabbit runtime probe scaffold"
```

### task 1.2: add a probe mode switch

objective: allow strict device testing without mixing normal app logs and probe logs invisibly.

files:
- modify: `js/rabbit-adapter.js`
- modify: `structa-cascade.js`

step 1: add one runtime flag
- `const probeMode = location.hash.includes('probe') || localStorage.getItem('structa-probe') === '1';`

step 2: expose it from `StructaNative.getCapabilities()`

step 3: when probe mode is on, route hardware event traces into the audit surface with a distinct kind

step 4: keep probe logs separate from normal user-facing logs in memory

step 5: commit
```bash
git add js/rabbit-adapter.js structa-cascade.js
git commit -m "feat: add probe mode state and logging"
```

### task 1.3: verify real rabbit event names on device

objective: stop assuming event names and record the actual runtime contract.

files:
- modify later: `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md`

step 1: deploy probe build to rabbit

step 2: on device, perform each action one at a time:
- system back button
- wheel up
- wheel down
- side button click
- ptt hold start
- ptt hold end
- camera open
- camera capture
- front/back switch

step 3: export the latest 33 probe logs

step 4: document the observed names and payloads in the launch brief

expected output:
- a verified table of actual event names and payload fields

---

## milestone 2: home composition reset

### task 2.1: remove non-essential home content

objective: make the home screen only about navigation powers.

files:
- modify: `structa-cascade.js`

step 1: remove the home summary block under the cards
- delete the current `drawNowPanel()` behavior from home mode
- keep project summary only inside the expanded `now` surface

step 2: remove helper hints from cards
- delete:
  - `ptt to capture`
  - `hold ptt`
  - `tap for insight`
  - `project at a glance`

step 3: keep card face to:
- icon
- name
- maybe one tiny role line only if still needed after device test

step 4: commit
```bash
git add structa-cascade.js
git commit -m "feat: strip home screen to card powers only"
```

### task 2.2: reclaim top space

objective: move the app wordmark up and give the stack the room it needs.

files:
- modify: `structa-cascade.js`
- modify: `index.html`

step 1: tighten the top-safe layout model
- keep system bar as a hard boundary
- place `structa` immediately below it, not floating in the upper third

step 2: move the card stack upward into the freed space

step 3: re-balance selected card y-position so the active card owns the screen center more confidently

step 4: commit
```bash
git add index.html structa-cascade.js
git commit -m "feat: tighten top spacing and recenter stack"
```

### task 2.3: make side cards feel like album browsing, not overlap clutter

objective: preserve the side-stack effect without text collision.

files:
- modify: `structa-cascade.js`

step 1: reduce text visibility on non-selected cards
- side cards should show mostly shape and icon
- card names only if still legible
- no role text on side cards

step 2: reduce background card contrast and content density

step 3: make selected card either own the scene or clearly remain a navigation card, not both

step 4: commit
```bash
git add structa-cascade.js
git commit -m "feat: simplify side-card stack hierarchy"
```

---

## milestone 3: logs become discreet and hardware-aware

### task 3.1: shrink the home audit preview

objective: make logs glanceable, not dominant.

files:
- modify: `index.html`
- modify: `structa-cascade.js`

step 1: reduce the visible home log strip height
step 2: remove oversized handle feel
step 3: show one concise latest line only on home
step 4: keep full-screen audit only when explicitly opened

step 5: commit
```bash
git add index.html structa-cascade.js
git commit -m "feat: reduce home audit strip footprint"
```

### task 3.2: give the wheel exclusive control in full audit mode

objective: make wheel behavior deterministic.

files:
- modify: `structa-cascade.js`

step 1: when audit is open, wheel scrolls logs only
step 2: when audit is closed, wheel changes selected card only
step 3: when camera is open, wheel flips camera only
step 4: when know is open, wheel cycles insights only

step 5: commit
```bash
git add structa-cascade.js
git commit -m "feat: scope wheel behavior by active surface"
```

### task 3.3: move save-33 to hardware-first behavior

objective: stop giving save-33 a big visible button on home.

files:
- modify: `index.html`
- modify: `structa-cascade.js`
- modify: `js/rabbit-adapter.js`

step 1: remove the visible `save 33` pill from home
step 2: map long ptt in log mode to export latest 33 entries
step 3: optionally keep a tiny action in full audit only if needed

step 4: commit
```bash
git add index.html structa-cascade.js js/rabbit-adapter.js
git commit -m "feat: move save-33 toward hardware-first export"
```

---

## milestone 4: native back hardening

### task 4.1: stop relying on browser history as the primary back contract

objective: make back behavior explicit and device-native.

files:
- modify: `structa-cascade.js`
- modify: `js/camera-capture.js`
- modify: `js/voice-capture.js`

step 1: remove `history.pushState()` from camera and voice open paths
step 2: stop using browser popstate as a primary back strategy
step 3: create one adapter-level `handleNativeBack()` entry point
step 4: route it to:
- close camera -> home
- close voice -> home
- close know -> home
- close now detail -> home
- close log -> home

step 5: commit
```bash
git add structa-cascade.js js/camera-capture.js js/voice-capture.js
git commit -m "feat: remove browser-history back assumptions"
```

### task 4.2: bind verified rabbit back event name after probe confirmation

objective: wire the real native event, not guessed aliases.

files:
- modify: `structa-cascade.js`
- modify: `js/rabbit-runtime-probe.js`

step 1: use the observed event name from milestone 1
step 2: call only the explicit app-level back handler
step 3: verify device behavior does not close the app while inside an active surface

---

## milestone 5: show flow becomes hardware-first

### task 5.1: stop using overlay tap as the primary capture action

objective: make camera capture driven by hardware, not by touching the center of the screen.

files:
- modify: `js/camera-capture.js`

step 1: remove pointer-based capture as the primary path
step 2: keep touch only for debug fallback if needed
step 3: bind short ptt capture to the verified rabbit hardware event
step 4: bind wheel to camera facing change only
step 5: keep center glyph non-interactive

step 6: commit
```bash
git add js/camera-capture.js
git commit -m "feat: make show hardware-first"
```

### task 5.2: verify actual image capture payloads

objective: make sure the camera is not only opening but actually returning a usable asset.

files:
- modify: `js/rabbit-adapter.js`
- modify: `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md`

step 1: log exact camera return payload shape from rabbit
step 2: verify whether browser canvas capture is fallback-only
step 3: normalize native image asset shape before storing the capture bundle

---

## milestone 6: tell flow becomes hardware-first

### task 6.1: bind tell to verified ptt lifecycle

objective: make tell depend on the real device ptt lifecycle.

files:
- modify: `js/voice-capture.js`
- modify: `js/rabbit-adapter.js`

step 1: remove browser-like assumptions where possible from the primary path
step 2: use verified ptt start and ptt end events as the main control flow
step 3: keep browser media capture only as fallback mode
step 4: preserve silent transcript -> harness -> project update flow

step 5: commit
```bash
git add js/voice-capture.js js/rabbit-adapter.js
git commit -m "feat: make tell hardware-first"
```

---

## milestone 7: now and know become the real follow-up loop

### task 7.1: move project consumption into `now`

objective: make `now` the place where users catch up with a project.

files:
- modify: `structa-cascade.js`
- modify: `js/rabbit-adapter.js`

step 1: keep `now` closed on home as a power card only
step 2: when opened, show:
- what changed
- latest captures
- latest insights
- open items
- unresolved questions

step 3: keep this surface readable as a single focused mode, not a mini dashboard

### task 7.2: make `know` the reasoning surface

objective: separate insight generation from home clutter.

files:
- modify: `structa-cascade.js`

step 1: open `know` into its own detail mode
step 2: wheel cycles insight units there
step 3: one unit at a time, not a dense list

---

## milestone 8: update the docs from verified reality

### task 8.1: patch the launch brief with confirmed runtime names

objective: keep the docs aligned with actual rabbit observations.

files:
- modify: `STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md`
- modify: `STRUCTA_R1_NATIVE_IMPLEMENTATION_PLAN_V1.md`

step 1: replace assumptions with observed event names and payload examples
step 2: document fallbacks explicitly
step 3: note anything unsupported rather than pretending support exists

---

## verification checklist for the truth pass

- [ ] exact rabbit back event name confirmed
- [ ] exact ptt lifecycle confirmed
- [ ] exact wheel event contract confirmed
- [ ] actual camera capture payload confirmed
- [ ] home screen shows only powers, not mixed summaries
- [ ] top spacing is tight and intentional
- [ ] selected card owns the composition cleanly
- [ ] side cards no longer create text collisions
- [ ] home audit strip is tiny and discreet
- [ ] full audit scrolls with wheel only
- [ ] save-33 no longer dominates the home screen
- [ ] camera no longer captures by accidental center touch
- [ ] back always returns to home
- [ ] `now` is a practical catch-up surface
- [ ] `know` is a practical reasoning surface
- [ ] device-scoped project isolation remains intact

## recommended execution order

1. milestone 1 runtime probe
2. device test and event capture
3. milestone 4 native back hardening
4. milestone 5 show hardware-first
5. milestone 6 tell hardware-first
6. milestone 2 home composition reset
7. milestone 3 log minimization
8. milestone 7 now/know follow-up loop
9. milestone 8 doc patching

## note to future implementation

do not try to “polish through uncertainty” again. if the rabbit runtime event contract is not proven, probe it first and document it before redesigning behavior around it.
