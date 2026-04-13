# Structa V2 — Visual System & UX Design

## 1. Typography Scale

Brutalist. Confident. No tiny text. Every word earns its space.

| Level | Size | Weight | Spacing | Color | Use |
|-------|------|--------|---------|-------|-----|
| DISPLAY | 35px | Regular | 0.0em | card-text | App title (home), surface headers |
| HERO_ROLE | 13px | Regular | 0.01em | card-role | Card subtitle on home |
| TITLE | 17px | Regular | 0.0em | card-text | Decision text, question text, lane names |
| BODY | 14px | Regular | 0.0em | card-body | Content descriptions, insight bodies |
| LABEL | 12px | Regular | 0.02em | card-muted | Section headers, filter names, "since last time" |
| MICRO | 10px | Regular | 0.01em | card-muted | Footer stats, timestamps, result counts |

Font: PowerGrotesk-Regular for everything. No bold. No italic. Variation comes from size, opacity, and color.

Color tokens:
```
--card-text:    rgba(8,8,8,0.96)
--card-body:    rgba(8,8,8,0.88)
--card-role:    rgba(8,8,8,0.72)
--card-muted:   rgba(8,8,8,0.50)
--card-dim:     rgba(8,8,8,0.30)
--text-light:   rgba(244,239,228,0.96)
--text-light-m: rgba(244,239,228,0.72)
```

### Minimum readable size: 10px (footer stats only)
### Primary content minimum: 12px (nothing meaningful below this)

---

## 2. Color System

Each card owns its color. Full-screen fills when opened. Stack cards show their color as background.

| Card | Fill | Accent | Notification | Meaning |
|------|------|--------|-------------|---------|
| SHOW | #77d5ff | #5bc0eb | — | See. Capture. Evidence. |
| TELL | #92ff9d | #6bdf77 | — | Speak. Dictate. Voice. |
| KNOW | #f8c15d | #e0a830 | gold pulse | Understand. Process. Questions. |
| NOW | #ff8a65 | #e8673d | orange pulse | Act. Decide. Urgent. |

Neutral:
```
--dark:        rgba(8,8,8,0.88)     // overlays, buttons, dark text
--dark-soft:   rgba(8,8,8,0.12)     // subtle backgrounds, decision box
--light:       rgba(244,239,228,0.96) // text on dark
--light-m:     rgba(244,239,228,0.72) // secondary text on dark
--danger:      #ff4444               // blockers
--danger-soft: rgba(255,68,68,0.12)   // blocker box background
```

### Color rules
- Green and blue = input colors (you're giving something to the system)
- Gold = processing color (the system is working on your behalf)
- Orange = output/action color (the system needs something from you)
- Red = blocker (something is stuck)
- The home screen shows all four colors simultaneously in the card stack

---

## 3. Card System — Home Screen

### 3.1 Layout

Vertical stack. Hero card centered. Three stack cards behind, offset left and scaled down.

```
┌──────────────────────────┐  ← 240px wide
│       [back] 11:50  🔋   │  ← status bar (system, not ours)
├──────────────────────────┤
│                          │
│  ╔══════════════════╗    │
│  ║  [icon]          ║    │  ← hero card, scale 1.5, y=48
│  ║  show            ║    │
│  ║  capture image   ║    │
│  ╚══════════════════╝    │
│  ┌──┐ ┌──┐ ┌──┐          │  ← stack cards, scale 0.50/0.69/0.92
│  │  │ │  │ │  │          │
│  └──┘ └──┘ └──┘          │
│                          │
│  ─── log preview ──────  │  ← collapsed drawer
└──────────────────────────┘
    ↑ 292px viewport height
```

Hero card position: x=120, y=48, scale=1.5
Stack card 1: x=0, y=auto, scale=0.92
Stack card 2: x=40, y=auto, scale=0.69
Stack card 3: x=80, y=auto, scale=0.50

Card dimensions: 150×150px, rx=20 (rounded rect)

### 3.2 Hero Card

Full presence. Clear hierarchy.

```
╔════════════════════════╗
║  [icon 30×30]         ║  ← 18px from left, 16px from top
║  show                 ║  ← 17px, card-text
║  capture image        ║  ← 13px, card-role (the ONLY role text)
║                   [●] ║  ← notification dot (top-right, if applicable)
╚════════════════════════╝
```

- Icon: 30×30px, positioned at (18, 16)
- Title: 17px, positioned at (18, 68)
- Role: 13px, positioned at (18, 84)
- Notification dot: r=5, top-right corner, only on KNOW (gold) and NOW (orange)

### 3.3 Stack Cards

Minimal. Just icon + title. No role text.

```
┌──────────────────────┐
│  [icon]  know    [●] │  ← 24×24 icon, 13px title, optional dot
└──────────────────────┘
```

- Icon: 24×24px
- Title: 13px
- Notification dot: r=4, subtle opacity pulse

### 3.4 Notification Dots

Not badges with numbers. A soft pulsing dot. Subtle. Discreet.

```css
@keyframes dot-pulse {
  0%, 100% { opacity: 0.4; r: 4; }
  50%      { opacity: 0.9; r: 5; }
}

.dot-know { fill: #f8c15d; animation: dot-pulse 1.6s ease-in-out infinite; }
.dot-now  { fill: #ff8a65; animation: dot-pulse 1.6s ease-in-out infinite; }
.dot-urgent { fill: #ff4444; animation: dot-pulse 0.8s ease-in-out infinite; }
```

### 3.5 Spring-Jump Animation

When agent adds content to KNOW or NOW, the card on the home stack does a brief bounce.

```css
@keyframes spring-know {
  0%   { transform: var(--card-transform) scale(var(--card-scale)); }
  25%  { transform: var(--card-transform) scale(calc(var(--card-scale) * 1.06)) translateY(-2px); }
  55%  { transform: var(--card-transform) scale(calc(var(--card-scale) * 1.02)); }
  100% { transform: var(--card-transform) scale(var(--card-scale)); }
}

@keyframes spring-now {
  0%   { transform: var(--card-transform) scale(var(--card-scale)); }
  20%  { transform: var(--card-transform) scale(calc(var(--card-scale) * 1.08)) translateY(-3px); }
  45%  { transform: var(--card-transform) scale(calc(var(--card-scale) * 0.99)); }
  65%  { transform: var(--card-transform) scale(calc(var(--card-scale) * 1.04)) translateY(-1px); }
  100% { transform: var(--card-transform) scale(var(--card-scale)); }
}
```

Duration: KNOW = 0.5s, NOW = 0.7s, URGENT = 1.0s with rapid bounce.

---

## 4. Button System

### 4.1 Button Types

All buttons are squared. rx=6. Minimum height 36px. Minimum width 60px.

**PRIMARY** — solid dark, light text, strong presence
```
fill: rgba(8,8,8,0.88)
text: rgba(244,239,228,0.96)
font-size: 12px
height: 36px
rx: 6
hover: rgba(8,8,8,0.95)
active: rgba(8,8,8,1)
```

**SECONDARY** — light fill, dark text, subtle
```
fill: rgba(8,8,8,0.08)
text: rgba(8,8,8,0.72)
font-size: 12px
height: 36px
rx: 6
hover: rgba(8,8,8,0.14)
active: rgba(8,8,8,0.20)
```

**DANGER** — red fill, light text, for destructive/blocker actions
```
fill: rgba(255,68,68,0.15)
stroke: rgba(255,68,68,0.30)
text: rgba(255,68,68,0.96)
font-size: 12px
height: 36px
rx: 6
```

**INLINE** — no background, just text, for hints
```
fill: none
text: rgba(8,8,8,0.40)
font-size: 10px
```

### 4.2 Decision Buttons (3-Option Pattern)

The core interaction pattern for NOW card decisions and blockers.

```
┌──────────────────────────────────┐
│  pending decision (1/3)          │  ← LABEL 12px, card-muted
│                                  │
│  "we should use react for the    │  ← TITLE 17px, card-text
│   frontend"                      │
│                                  │
│  ┌──────────┐ ┌──────────┐      │
│  │ option a │ │ option b │      │  ← PRIMARY buttons, 12px text
│  │ react    │ │ vue      │      │     height 36px, fill remaining width
│  └──────────┘ └──────────┘      │
│  ┌──────────┐                   │
│  │ option c │                   │
│  │ neither  │                   │
│  └──────────┘                   │
│                                  │
│  scroll to browse · side to pick │  ← INLINE 10px
└──────────────────────────────────┘
```

Three buttons. Full width. Stacked vertically. Each with option label. Tap to select. Side button confirms. Back skips.

### 4.3 Blocker Variant

Same 3-button pattern but with red tinting:

```
┌──────────────────────────────────┐
│  ⚠ blocker detected             │  ← DANGER text, 12px
│                                  │
│  "missing api documentation      │  ← TITLE 17px
│   for the payment module"        │
│                                  │
│  ┌──────────────────────────┐   │
│  │ research the api docs    │   │  ← PRIMARY button
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ use a different provider │   │  ← PRIMARY button
│  └──────────────────────────┘   │
│  ┌──────────────────────────┐   │
│  │ skip for now             │   │  ← SECONDARY button
│  └──────────────────────────┘   │
│                                  │
│  side to resolve · back to skip │
└──────────────────────────────────┘
```

Box background: rgba(255,68,68,0.06). Warning triangle icon. Same button heights.

---

## 5. Surface Designs

### 5.1 SHOW (Camera Surface)

**Remove hint mode entirely.** Camera opens directly.

Full-screen black background. Camera feed fills the viewport. Minimal chrome overlay.

```
┌──────────────────────────┐
│ [← back]          [🔄]   │  ← thin top bar, dark semi-transparent
│                          │
│                          │
│       ┌──────┐           │
│       │  ┼   │           │  ← center crosshair (subtle, 30×30)
│       └──────┘           │
│                          │
│                          │
│                          │
│       ┌──────────┐      │
│       │  capture │      │  ← bottom center, PRIMARY button
│       └──────────┘      │     120×36px, "capture" text
└──────────────────────────┘
```

Interactions:
- Tap anywhere → capture
- PTT release → capture
- Scroll → flip camera
- Back → home
- No hint text. No "touch" overlay. No intermediate states.

When camera is priming (getUserMedia loading):
- Show black screen with centered loading indicator (subtle spinner, not "touch" text)
- Max 200ms, should be instant after first warm

### 5.2 TELL (Voice Surface)

Green overlay. Same as current but cleaner.

```
┌──────────────────────────┐
│                          │
│                          │  ← full-screen #92ff9d fill
│                          │
│        ┌──────┐          │
│        │  🎤  │          │  ← mic glyph, 60×60, white fill
│        └──────┘          │
│       listening          │  ← LABEL 12px, dark text
│                          │
│   ▌▌ ▌▌▌ ▌▌ ▌▌▌▌ ▌▌    │  ← waveform bars, white
│                          │
│                          │
│                          │
└──────────────────────────┘
```

No transcript area on the overlay (clutters the small screen). Transcript appears in the log after processing.

### 5.3 KNOW (Insights Surface)

Gold background. 4-lane browser.

```
┌──────────────────────────┐
│ [icon] know               │  ← DISPLAY 35px header
│                          │
│ ┌──────┐┌────────┐┌────┐│
│ │ asks ││signals ││loop││  ← lane tabs, SQUARED buttons
│ └──────┘└────────┘└────┘│     height 28px, font 12px
│   decided                │     (4th tab wraps to second row if needed)
│                          │
│ filter  ┌─────┐   3 res  │  ← LABEL 12px + PRIMARY filter chip + count
│          │latest│         │
│          └─────┘          │
│                          │
│ asks                     │  ← TITLE 17px, current lane name
│ questions waiting for    │  ← BODY 14px, lane summary
│ an answer                │
│                          │
│ ─────────────────────    │  ← divider line
│                          │
│ best match               │  ← LABEL 12px
│ should we use react or   │  ← BODY 14px, preview text
│ vue?                     │
│                          │
└──────────────────────────┘
```

**Detail view** (tap to open):

```
┌──────────────────────────┐
│ [icon] know               │
│                          │
│ should we use react or   │  ← TITLE 17px
│ vue?                apr13│  ← MICRO 10px date
│                          │
│ open ask                 │  ← LABEL 12px section header
│                          │
│ the frontend framework   │  ← BODY 14px, wrapped
│ choice affects the       │
│ entire architecture      │
│                          │
│ ┌──────────────────────┐ │
│ │ side → answer        │ │  ← PRIMARY button, 36px height
│ └──────────────────────┘ │  ← only shown for questions
│   speak your answer      │  ← INLINE 10px
│                          │
└──────────────────────────┘
```

### 5.4 NOW (Decisions/Project Surface)

Orange background. Project dashboard.

```
┌──────────────────────────┐
│ [icon] now               │  ← DISPLAY 35px header
│ rebuild the landing page │  ← LABEL 12px, project name
│                          │
│ since last time          │  ← LABEL 12px section header
│ reviewed 3 design        │  ← BODY 14px
│ options and chose the    │
│ minimal layout           │
│                          │
│ ┌──────────────────────┐ │
│ │ pending decision (1/3)│ │  ← LABEL 12px inside dark box
│ │                      │ │
│ │ should we use stripe │ │  ← TITLE 17px, decision text
│ │ or lemon squeezy for │ │
│ │ the payment system?  │ │
│ │                      │ │
│ │ ┌──────────────────┐ │ │
│ │ │ stripe           │ │ │  ← PRIMARY button 36px
│ │ └──────────────────┘ │ │
│ │ ┌──────────────────┐ │ │
│ │ │ lemon squeezy    │ │ │  ← PRIMARY button 36px
│ │ └──────────────────┘ │ │
│ │ ┌──────────────────┐ │ │
│ │ │ research both    │ │ │  ← SECONDARY button 36px
│ │ └──────────────────┘ │ │
│ │                      │ │
│ │ scroll · side · back │ │  ← INLINE 10px
│ └──────────────────────┘ │
│                          │
│ next move                │  ← LABEL 12px section header
│ finalize the payment     │  ← BODY 14px
│ integration specs        │
│                          │
│ 12 caps · 8 insights ·   │  ← MICRO 10px footer
│ 2 asks · 3 decided       │
└──────────────────────────┘
```

**No pending decisions** — compact layout:

```
┌──────────────────────────┐
│ [icon] now               │
│ rebuild the landing page │
│                          │
│ since last time          │
│ all caught up            │
│                          │
│ next move                │
│ capture the next update  │
│ with tell or show        │
│                          │
│ 12 caps · 8 insights ·   │
│ 2 asks · 3 decided       │
└──────────────────────────┘
```

---

## 6. Affordance Map

Complete matrix of every input in every state.

### HOME

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| Scroll↓ | Next card | Card slides, hero changes | Scroll↑ goes back |
| Scroll↑ | Prev card | Card slides, hero changes | Scroll↓ goes forward |
| Tap hero | Open card surface | Surface opens (color fill) | Back → home |
| Tap stack | Select card | Card becomes hero | Tap another or scroll |
| PTT down | Open capture (show/tell) | Immediate surface open | Back → home |
| PTT up | Execute capture | Camera shoots / voice stops | Auto → home after processing |
| Back | Close app | App exits | N/A (intentional) |

### CAMERA_OPEN

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| Tap | Capture | White flash (100ms) | Auto → home |
| PTT up | Capture | White flash | Auto → home |
| Scroll | Flip camera | Camera flips, brief "selfie" label | Scroll again to flip back |
| Back | Close camera → home | Camera closes | N/A |

### VOICE_OPEN

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| PTT down | (already listening) | No change | N/A |
| PTT up | Stop listening → process | Overlay fades, green border pulse | Auto → home |
| Back | Cancel → home | Overlay fades | N/A |

### KNOW_BROWSE

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| Scroll↓ | Next lane | Lane tabs highlight changes | Scroll↑ goes back |
| Scroll↑ | Prev lane | Lane tabs highlight changes | Scroll↓ goes forward |
| Long-press | Cycle filter | Filter chip changes | Long-press again to cycle |
| Tap | Open detail view | Item expands | Back → browse |
| Side | Open detail view | Item expands | Back → browse |
| Back | → home | Surface closes | N/A |

### KNOW_DETAIL

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| Scroll↓ | Next item | Content changes | Scroll↑ goes back |
| Scroll↑ | Prev item | Content changes | Scroll↓ goes forward |
| Tap | If question → open voice to answer | Green overlay opens | Back → detail |
| Side | If question → open voice to answer | Green overlay opens | Back → detail |
| Tap | If not question → back to browse | Collapses | N/A |
| Side | If not question → back to browse | Collapses | N/A |
| Back | → browse | Collapses | N/A |

### NOW_BROWSE

| Input | Action | Visual Feedback | Recovery |
|-------|--------|----------------|----------|
| Scroll↓ | Next decision/blocker | Content changes, counter updates | Scroll↑ goes back |
| Scroll↑ | Prev decision/blocker | Content changes | Scroll↓ goes forward |
| Tap option | Execute that option | Button fills briefly, item resolves | N/A |
| Side | Confirm first option | Same as tap first option | N/A |
| Back | Skip current item | "skipped" briefly shown | If more items, stay. If none, → home. |
| Back (2x) | → home | Surface closes | N/A |

---

## 7. Camera Flow — Complete Redesign

### Problem with current flow
1. Tap SHOW → hint mode ("hold to shoot") → user must PTT → PTT opens camera → user must tap to capture. Too many steps.
2. PTT on cold SHOW → "touch" overlay → user taps → camera opens. Confusing "touch" reference.
3. The hint mode was trying to solve getUserMedia latency but created more confusion.

### New flow — direct access

```
USER ACTION                    SYSTEM RESPONSE
───────────                    ───────────────
Tap SHOW card                  getUserMedia starts → camera opens immediately
PTT on SHOW card               getUserMedia starts → camera opens immediately
                               (stream may take 100-200ms to appear, black screen during this time)

Camera is open:
  Tap anywhere                  Capture → flash → process → home
  PTT release                  Capture → flash → process → home
  Scroll                       Flip camera (environment ↔ selfie)
  Back                         Close camera → home
```

No intermediate states. No hint text. No "touch" overlay. The user taps or presses and the camera is there.

### Implementation
- Remove all hint mode code from cascade
- Remove SHOW_HINT and TELL_HINT states
- On tap/PTT of SHOW: call getUserMedia immediately, show camera overlay
- On PTT release while camera is open: capture
- Show a brief loading state (dark screen, small spinner) if getUserMedia takes >100ms
- After first successful camera open in session, cache the stream reference for faster re-open

---

## 8. Spacing & Layout Grid

Base unit: 4px. All measurements are multiples of 4.

### Edge padding
- Horizontal: 14px from edge (card interior)
- Vertical: 16px from edge (surface interior)
- Status bar: 32px from top (leave room for Rabbit's system bar)

### Section spacing
- Between header and first section: 14px
- Between sections: 16px
- Between section label and content: 6px

### Card interior
- Icon position: (18, 16) from card origin
- Title: (18, 68)
- Role text: (18, 84)
- Decision box internal padding: 14px all sides
- Button gap (3-option stack): 8px between buttons

### Log drawer
- Handle height: 32px
- Preview text: 10px, single line, truncated
- Open drawer: takes bottom 60% of screen
- Log entry line height: 20px
- Log entry padding: 4px 14px

### Surface header
- Icon: 24×24px at (14, 14)
- Title text: 35px at (48, 46)
- Project name (NOW only): 12px at (14, 62)

---

## 9. Animation Specifications

### Spring-Jump (card notifications)
```css
/* Applied to the card SVG group, replaces the static transform */
@keyframes spring-know {
  0%   { transform: translate(var(--x), var(--y)) scale(var(--s)); }
  25%  { transform: translate(var(--x), calc(var(--y) - 2px)) scale(calc(var(--s) * 1.06)); }
  55%  { transform: translate(var(--x), var(--y)) scale(calc(var(--s) * 1.02)); }
  100% { transform: translate(var(--x), var(--y)) scale(var(--s)); }
}

@keyframes spring-now {
  0%   { transform: translate(var(--x), var(--y)) scale(var(--s)); }
  20%  { transform: translate(var(--x), calc(var(--y) - 3px)) scale(calc(var(--s) * 1.08)); }
  45%  { transform: translate(var(--x), var(--y)) scale(calc(var(--s) * 0.99)); }
  65%  { transform: translate(var(--x), calc(var(--y) - 1px)) scale(calc(var(--s) * 1.04)); }
  100% { transform: translate(var(--x), var(--y)) scale(var(--s)); }
}

@keyframes spring-urgent {
  0%   { transform: translate(var(--x), var(--y)) scale(var(--s)); }
  15%  { transform: translate(var(--x), calc(var(--y) - 4px)) scale(calc(var(--s) * 1.10)); }
  30%  { transform: translate(var(--x), var(--y)) scale(calc(var(--s) * 0.98)); }
  50%  { transform: translate(var(--x), calc(var(--y) - 2px)) scale(calc(var(--s) * 1.05)); }
  70%  { transform: translate(var(--x), var(--y)) scale(calc(var(--s) * 1.01)); }
  100% { transform: translate(var(--x), var(--y)) scale(var(--s)); }
}
```

### Notification Dot Pulse
```css
@keyframes dot-pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 0.9; }
}
/* Duration: 1.6s for normal, 0.8s for urgent */
```

### Surface Transition (open/close)
No fancy transitions. Instant color fill. The card's background color expands to fill the 240×292 viewport on a single frame. This is instant — no CSS transition, no animation. The speed IS the design.

### Camera Flash
```css
@keyframes capture-flash {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}
/* White overlay, 100ms duration, fades out */
```

### Voice Waveform
```css
@keyframes wave-bar {
  0%, 100% { height: 8px; }
  50%      { height: 20px; }
}
/* Each bar has a different animation-delay for natural motion */
/* Bars: 0s, 0.1s, 0.2s, 0.3s, 0.15s */
```

---

## 10. Key Design Decisions

### Why no hint mode
Hint mode was a workaround for getUserMedia latency. It added an intermediate state that confused users. The new approach: open camera directly, accept a brief black screen (100-200ms) while the stream initializes. On subsequent opens within the same session, the stream is already cached and the camera appears instantly.

### Why 3 options for decisions (not 2)
Binary approve/reject forces the user into a false dichotomy. Three options give the agent room to propose a nuanced choice (e.g., "option A", "option B", "research more"). It also matches the blocker flow where one option should always be a non-committal escape ("skip for now").

### Why squared buttons (not rounded pills)
Rounded pills feel soft and casual. Squared buttons with rx=6 feel industrial and intentional. They match the brutalist typography direction and the R1's hardware aesthetic (the device itself has sharp geometric edges).

### Why gold for KNOW
Green/blue are input colors (you're giving). Orange is an output color (the system needs you). Gold sits between — it's the processing color. The system is working, digesting, understanding. Questions and insights are in-process artifacts, not raw inputs and not action items.

### Why no text below 10px
On a 240×292 screen at typical viewing distance (~30cm), anything below 10px becomes illegible for many users. The previous design used 9px for section labels — barely readable. All labels bumped to 12px minimum.

### Why instant surface transitions
The R1 is a fast device. Animations between surfaces feel slow and phone-like. The card's color filling the screen instantly communicates "you're in this card's space now." The speed is the affordance.
