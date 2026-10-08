# Structa Full-Awesomeness Audit — 2026-07-02

Goal: bring Structa to its intended state — the first professional tool native to the Rabbit R1.
A project and context building instrument for professionals on the go. Looks great, works great, fully native.

Method: full code pass (22,306 lines JS + server), live run of all surfaces at 240x292,
trace harness execution, voice-doctrine gate, and line-by-line comparison against the
R1 Creations SDK guide (community best practices).

---

## Verdict

The foundation is unusually strong for an R1 creation: green harness (37/37), a formal
state machine, queue-backed capture, multi-tier storage that matches community best
practice exactly, and a coherent Bauhaus-calm design system across every surface.

But the app is currently in a **voice-only MVP posture** (April 23 refocus stripped
~1,200 lines from the shell). The differentiating feature — SHOW+TELL simultaneous
capture — is parked. One quality gate is failing. One signature feature (heartbeat) is
silently dead. And there is a deployment architecture contradiction that would break
the app entirely if shipped as configured.

---

## A. Broken right now (fix first)

### A1. Voice-doctrine gate is failing (exit 1)
`scripts/check-voice-doctrine.sh` expects exactly one literal `wantsR1Response: true`.
There are two:
- `js/r1-llm.js:326` — the legitimate milestone speech gate
- `js/r1-llm.js:694` — `sendR1CoverSpeech()`, added during the image-fetch probing
  spree (used at r1-llm.js:1680 and :2138, both in the parked image chain)

`npm run check:voice-doctrine` is red on main. Either route cover speech through the
single milestone gate, or teach the check that the cover path is a sanctioned second
speaker. A red gate erodes trust in all the other gates.

### A2. Heartbeat feature is silently dead
`js/heartbeat.js` defines `window.StructaHeartbeat`, and `structa-cascade.js` calls
`maybeStartHeartbeat()` in five places — but **`index.html` never loads
`js/heartbeat.js`**. Every call is guarded (`if (window.StructaHeartbeat...)`), so
nothing crashes; the audible pulse + visual micro-movement (a signature "alive
instrument" feature from the April plan) simply never runs. One script tag fixes it —
or delete the module if the voice-only MVP intentionally dropped it.

### A3. Working-tree clutter
Untracked at repo root: `harness/scenarios/batch_smoke_10.json` (a scenario that
should be committed), plus `Briefing_Necesidades_Cliente_Granada_Maslow.pdf` and two
signage JPGs that belong in `attached_assets/` or outside the repo.

### A4. Unused dependency
`package.json` declares `serve` — nothing uses it (the server is `server.py`). Remove.

---

## B. The deployment contradiction (highest risk)

The last deployment audit (2026-04-12) records Replit configured as a **static site**
(`python3 -m http.server`, `deploymentTarget = "static"`). Since then the app became
server-dependent in two hard ways:

1. **Asset loading**: `index.html` loads every script through
   `/__structa_asset/<buildId>/js/...` — a route that only `server.py` resolves
   (server.py:1278). On static hosting, all 16 scripts 404 and the app is a black screen.
2. **Orchestration**: `js/orchestrator.js` POSTs to `/v1/voice/interpret`,
   `/v1/project/brief`, `/v1/triangle/synthesize`, etc. for prompt shaping and
   response parsing. LLM inference itself is on-device (bridge), but if the server is
   unreachable, enrichment fails. Capture survives (local-first write is correct), but
   interpretation dies.

Decide the runtime model and make it true:

- **Option 1 (fast)**: deploy `server.py` (Replit deployment target = autoscale/VM,
  `npm start`). Accept the network dependency; the queue already surfaces stalls as
  blockers.
- **Option 2 (truly native, recommended for the product ambition)**: move prompt
  shaping and response parsing into the client (they are pure string logic — no
  secrets, no heavy compute), keep `server.py` for dev/harness only, and restore
  static-safe script URLs. Then Structa works on the device with zero
  infrastructure — genuinely "on the go," airplane-mode capture included.

---

## C. Native-fit against the SDK guide

### C1. Viewport: 282 vs 292
The guide is explicit: 282px is the safe effective height. `index.html` meta declares
`height=282`, but `#app` is `min(292px, 100vh)` and every SVG scene is drawn on a
240x292 viewBox (footers at y=282). On a real 282px device viewport this either scales
the scene down ~3.4% (letterboxing sides) or clips the bottom strip — the log drawer
handle lives exactly there. Standardize on one canvas height and verify on device.

### C2. Boot performance
16 separate scripts injected via `document.write` (parser-blocking, strictly
sequential) totaling ~22k unminified lines. On the R1 webview this is slow-boot
territory. Also always shipped:
- `js/diagnostic-suite.js` — 2,419 lines, only useful in probe/debug mode
- `js/camera-capture.js` — 1,252 lines for a feature that is off this release

Recommendation: a 20-line build script (concat + esbuild minify, no framework, no
churn to the no-build dev loop) producing one bundle; lazy-load diagnostics only when
probe mode is on. Target: boot in well under a second on device.

### C3. R1 capabilities present and correct
- Multi-tier storage (creationStorage → IndexedDB → localStorage, timestamp-wins,
  emergency snapshot) — textbook, matches the guide's production pattern.
- Single `window.onPluginMessage` owner with previous-handler chaining — correct;
  avoids the classic multi-handler clobbering bug.
- Hardware events fully wired: sideClick, longPressStart/End, scrollUp/Down with
  dedupe against Flutter's native 80px auto-scroll, shake via devicemotion.
- Camera capture at 240x282 — within the 640x480 Rabbithole sync limit.

### C4. R1 capabilities unused (planned, still missing)
From the April 25-intervention plan, still absent:
- **SERP research** in the impact chain (`useSerpAPI` — free web research on device)
- **Email export** ("email it to me" — zero-config delivery to the user's Rabbithole
  address; the natural professional export path)
- **Onboarding** — new-project memory now defaults `onboarded: true` (April 23);
  fine for you, but the "first professional tool" pitch needs the single-PTT
  onboarding (name/type/role extraction) restored for real users.

---

## D. Product gap: SHOW is the differentiator and it is off

**Correction (2026-07-02, post-review with Pedro):** the previous version of this
section read the git history wrong. The 42 image/vision commits were not a contract
that got "won" — they were a systematic, professional-grade attempt to get the R1
image+LLM bridge to return analysis text, and it failed. The team tried the documented
`imageBase64 + useLLM + wantsR1Response` pattern, spoofed Magic Camera's
`pluginId: 'com.r1.pixelart'`, tried both raw-base64 and data-URL image formats, tried
resizing/normalizing to different aspect ratios, and when the direct callback still
wouldn't reliably fire, built an indirect workaround (`fetchLabeledImageAnalysisText`)
that posts the image with `wantsJournalEntry: true` and then makes a *second* LLM call
asking it to recall its own journal entry by tag, polling with retry/delay chains
(`followupDelayMs: 10000`, up to 3 attempts). Even that workaround was still being
hardened right up to the pivot commit ("Simplify tagged image note retrieval"). Confirmed
by Pedro: image analysis on Rabbit does not reliably return text through the creation
bridge — this is a platform reliability wall, not a Structa bug, and the voice-only
pivot was the correct call, not a retreat.

One unfinished lead: `docs/r1-image-analysis-research.md` started reverse-engineering
Magic Kamera's actual JS bundle (which reportedly does get vision working) but stops
after step 1, before ever inspecting the payload. Low priority given 42 commits of
prior probing already covered the obvious variants, but worth 30 minutes if curiosity
strikes.

**Direction decided with Pedro: capture-only SHOW.** Do not chase auto-description.
Bring back the camera surface and the SHOW+TELL voice annotation strip (CSS and strip
markup already exist in index.html), but the value loop is: user points camera at
something, holds PTT, says what it is/why it matters — that transcript is captured via
the STT path (which works reliably) and stored as the artifact's context. No
image-to-text bridge call, no dependency on the broken vision return path. Auto-description
becomes a "revisit if/when R1 firmware improves the bridge" backlog item, not a blocker.

Path back, in order:
1. Re-enable `CAMERA_OPEN` — single-frame capture, stored immediately (queue-first,
   as already doctrine)
2. SHOW+TELL voice strip — PTT during camera capture opens the voice annotation strip,
   transcript attaches to the capture
3. KNOW/NOW surfacing of image+transcript pairs (no auto-derived claims from vision;
   claims can still be extracted from the *voice transcript* via the existing
   `extractClaimsFromText` path, which is text-only and already reliable)
4. Strip out the now-dead vision-analysis call sites (`requestCaptureDescription`,
   `probeImagePrompt`, `fetchLabeledImageAnalysisText`, the `sendR1CoverSpeech` cover-text
   path used only during image fetch) rather than leaving them as unreachable dead code

The harness already has scenarios for the capture side (`s4_capture_burst`,
`v4_triangle_orphan_evidence`); the vision-specific ones (`x5_claim_extraction_timeout`
if it depends on image analysis) should be checked and likely retired or rewritten
against the transcript-only path.

---

## E. What is already excellent (do not touch)

- The design system: PowerGrotesk, four-color card identity, calm motion doctrine,
  lowercase voice. It looks like an instrument, not a webpage. All six surfaces render
  coherently at 240x292.
- Voice doctrine as an enforced gate (when green) — silence-by-default with milestone
  dedupe, cooldown, and per-project memory is a genuinely mature design.
- The trace harness + semantic judge — 37 scenarios, all green. No other R1 creation
  has this.
- Queue-backed capture: gesture returns instantly, enrichment is async, stalls become
  visible blockers. This is exactly the replit.md doctrine, implemented.

---

## Execution plan

### Phase 0 — Repair the base (hours)
1. Fix voice-doctrine gate (unify speech behind one gate) — A1
2. Load or delete `js/heartbeat.js` — A2
3. Commit `batch_smoke_10.json`; move PDFs/JPGs out of root — A3
4. Drop `serve` from package.json — A4

### Phase 1 — Device truth (1–2 days)
5. Decide server model (Option 1 vs 2 in section B) and make deployment match
6. Resolve 282/292; verify footer/drawer on real hardware — C1
7. Bundle build step + lazy diagnostics — C2

### Phase 2 — The product returns (days)
8. Re-enable SHOW as capture-only (no vision-to-text call) — see section D
9. SHOW+TELL voice annotation strip, transcript as the artifact's context
10. Remove dead vision-analysis code paths (requestCaptureDescription, probeImagePrompt,
    fetchLabeledImageAnalysisText, image-only sendR1CoverSpeech usage)
11. Restore single-PTT onboarding for new users

### Phase 3 — Awesomeness (the April plan, resequenced)
12. SERP research in the impact chain + voice command
13. Email export on demand ("email me the project snapshot")
14. Project fork / knowledge transfer
15. Discovery mode question cadence + heartbeat BPM polish

Ship after every phase. Phase 0 is committable today.
