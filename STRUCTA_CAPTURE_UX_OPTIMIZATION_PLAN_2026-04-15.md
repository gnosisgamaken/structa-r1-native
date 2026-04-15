# Structa Capture UX Optimization Plan

> For Hermes: implement only after this plan is approved. Do not change hardware interaction rules again without checking this plan and the R1 guide constraints.

## Goal
Make Structa feel natively integrated on Rabbit R1 by turning tell and show into explicit capture pages with clear hardware roles, immediate feedback, strong use of space, and game-like decision/review flows.

## Source constraints confirmed from ULTIMATE_R1_CREATIONS_GUIDE
- Viewport should be treated as 240×282 safe area.
- Minimum touch target: 44×44.
- sideClick = quick press action.
- longPressStart = hold start.
- longPressEnd = hold release.
- scrollUp / scrollDown = wheel navigation.
- Flutter also auto-scrolls 80px on wheel, so wheel handlers must be tightly scoped.
- Use longPressStart for voice recording / quick-add style actions.
- Camera requires secure context and should use conservative resolution if Rabbithole sync matters.
- Rabbithole-safe image resolution should stay at or below 640×480.
- PluginMessageHandler is for structured LLM/image payloads.
- Creation apps should expose clear fallbacks and not leak debug details into the main UI.

## What the screenshots and current build are telling us
1. Tell is behaving like a hidden overlay, not a proper surface.
2. Show is closer, but capture confirmation and gallery behavior are still not trustworthy.
3. Logs are developer-ish, cramped, and visually unrelated to the rest of the product.
4. NOW decision cards are semantically interesting but spatially weak and too small.
5. The whole app has strong visual identity but weak gameplay clarity.

## Product direction
Structa should feel like a small tactical game:
- home = launcher / deck select
- tell = voice run
- show = visual run
- know = retrieval board
- now = decision arena
- logs = minimal mission feed, not a debug terminal

## Canonical interaction model

### Home
Purpose:
- choose mode quickly
- understand one next action immediately

Hardware rules:
- scroll = move card focus
- sideClick = open focused card page
- longPressStart on focused tell = jump straight into tell capture-ready state
- longPressStart on focused show = jump straight into show page, not direct camera open
- back = exit app / native behavior

Why:
- This keeps home stable.
- No direct cold camera opening from PTT at home.
- Capture happens inside explicit capture pages.

---

### Tell page
Purpose:
- dedicated voice capture surface
- raw voice inputs live here as structured transcript history
- PTT behavior is obvious and repeatable

Layout:
- full-bleed tell color surface
- top: title + project subtitle
- main body: latest transcript card or empty state
- lower body: scrollable transcript rail / stacked message list
- bottom: one strong PTT action bar or hold hint
- no ugly debug logs on this page

Hardware rules:
- sideClick = enter active listen state if idle
- longPressStart = start listening immediately
- longPressEnd = stop listening and process
- scroll = move through previous voice entries / transcript history
- back = return home

Touch rules:
- tap big PTT control = arm/open tell page state
- hold on visible PTT zone = start voice capture
- tap transcript item = expand / reuse / send to know-now flow later

Key UX rule:
- Tell page should always show the last few voice inputs as clean human-readable entries, not raw logs.

---

### Show page
Purpose:
- dedicated visual capture surface
- gallery-first memory page
- camera is launched from inside show, never as a hidden side effect

Layout:
- full-bleed show color surface
- top: title + project subtitle
- primary action row: big “open camera” action
- main image area: latest capture, edge-to-edge, maximal size
- bottom gallery: 3 square thumbnails, full width, no ornamental borders, extending all the way down except for minimal safe spacing
- summary overlays should be subtle and only appear over active image

Hardware rules:
- sideClick on show page when idle = open camera
- sideClick in camera-open state = take picture
- longPressStart should NOT directly call getUserMedia from cold state
- longPressStart inside already-open camera state may be used as alternate shutter only if it feels clean after testing
- scroll in show page = move between gallery items
- scroll in camera-open state = flip facing mode
- back = close camera if open, else return home

Touch rules:
- tap open camera = launch camera
- tap preview when camera is open = take picture
- tap thumbnail = select that capture

Key UX rules:
- after capture, immediately return to show page with the new image visible in slot 1
- gallery should feel like a film strip / inventory, not framed cards
- capture feedback should be immediate: shutter feel, thumbnail insertion, latest image selected

---

### Camera activation rules
We should support two valid activation paths, but both must route through the same state machine.

Path A: Touch-first
- user taps open camera on show page
- this is the safest path for getUserMedia permission context
- once open, tap preview or sideClick captures

Path B: Hardware-first after surface entry
- user opens show page with sideClick or long press from home
- then sideClick opens camera from that page
- if stream is not yet primed, page should instruct “tap camera to enable lens” rather than silently failing

Do NOT do this:
- direct cold camera getUserMedia call from longPressStart on home and expect it to be reliable on R1

Why:
- the guide confirms hardware events, but real WebView permission behavior still makes touch acquisition safer
- we can still make hardware feel native by making sideClick the action once the user is in the correct page

---

### Voice activation rules
Use the R1-native hold model.

Preferred model:
- longPressStart = start voice capture
- longPressEnd = stop voice capture
- sideClick on tell page = explicit shortcut into ready/listen state

Why:
- this matches guide guidance that longPressStart is appropriate for recording / quick-add
- it feels truly native to the R1 side button

---

### Logs / mission feed
Replace current ugly debug strip with a productized mission feed.

Rules:
- home: collapsed single-line mission feed only
- capture pages: hide the feed entirely
- expanded logs: full-screen audit mode only when explicitly opened

Visible home feed entries should only include meaningful human-readable events:
- voice saved
- image stored
- insight extracted
- decision approved
- question answered

Never show:
- raw dimensions
- duplicate action names
- malformed parser text
- internal bridge labels

Design:
- same typography system as rest of app
- flatter, calmer, more intentional
- no debug-console vibe

---

### NOW page redesign
Goal:
- decision card should feel like a game encounter

Current problem:
- tiny buttons
- weak hierarchy
- poor space usage

New model:
- one large decision card occupying the majority of the page
- top: state / streak / urgency label
- middle: one big prompt
- bottom: 2 or 3 large action slabs, not tiny pills

Example action pattern:
- approve
- refine
- skip

If option triage is needed:
- wheel cycles options with obvious highlighted state
- sideClick confirms highlighted option
- touch also works on large slabs

Game feel elements:
- stronger selected-state contrast
- big readable action tiles
- explicit momentum/progress language
- maybe sound feedback later, but not required for first pass

---

## Concrete implementation sequence

### Phase 1 — interaction model hardening
1. Freeze current hardware mappings.
2. Refactor state machine so show and tell are first-class pages, not overlay side effects.
3. Make home long-press open the correct page, not directly cold-open hardware capture.
4. Ensure sideClick / scroll / longPress behavior is page-specific and documented.

### Phase 2 — tell page
1. Build tell browse page.
2. Add transcript history list.
3. Wire longPressStart / longPressEnd to voice capture only on tell page or focused tell from home.
4. Make transcript entries readable and persistent.

### Phase 3 — show page
1. Keep show page as canonical visual memory page.
2. Rebuild gallery to use 3 edge-to-edge square thumbnails across full width.
3. Make latest image hero area large and clean.
4. Ensure capture inserts image immediately and selects it.
5. Keep sideClick shutter inside camera-open state.

### Phase 4 — logs coherence
1. Replace raw log strings with human-readable mission feed entries.
2. Restyle collapsed feed to match app language.
3. Keep full audit mode separate.

### Phase 5 — now gamification
1. Redesign decision card as a dominant play surface.
2. Replace tiny bottom pills with large tiles.
3. Use scroll for option focus and sideClick for commit.
4. Preserve touch parity.

## Success criteria
- Tell feels like a proper voice page, not a disappearing-title bug.
- Show feels like a proper camera/gallery page.
- No direct cold PTT camera failure from home because camera launch is page-mediated.
- New captures appear instantly in gallery.
- Logs no longer look like a terminal.
- NOW decisions are legible and exciting.
- Every hardware action has one job per page.
- The app feels more like a game than a dashboard.

## Recommended default hardware mapping
- Home:
  - scroll = select card
  - sideClick = open selected page
  - longPressStart on tell/show = quick-open that page
- Tell page:
  - longPressStart = start record
  - longPressEnd = stop/send
  - scroll = browse entries
  - sideClick = ready/listen shortcut
- Show page:
  - sideClick = open camera
  - scroll = browse gallery
  - back = home
- Camera-open state:
  - sideClick = capture
  - tap preview = capture
  - scroll = flip camera
  - back = close camera to show page
- NOW page:
  - scroll = change option focus
  - sideClick = confirm focused choice

## Recommendation
Implement this in that exact order:
1. tell page
2. show page + camera reliability
3. logs coherence
4. now game redesign

That order gives us stable capture primitives first, then better workflows.
