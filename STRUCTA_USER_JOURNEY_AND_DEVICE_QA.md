# Structa User Journey and Device QA Sheet

Date: 2026-04-12

## 1) End-to-end user journey

### A. Starting a project
1. Open Structa on the device.
2. Land on the home canvas: four primary nodes, hidden depth below.
3. Name or confirm the project context.
4. Establish the project code / working frame.
5. Decide the immediate intent:
   - build
   - patch
   - delete
   - solve
   - consolidate
   - decide
   - research
   - withdraw
6. Capture the first context item, usually by voice or camera.
7. Structa normalizes that capture into structured intent.
8. The app routes it to the right target surface:
   - context
   - capture
   - journal
   - export
   - approval
9. If the action is mutating or external, it pauses for approval.
10. The result is stored in the audit trail and becomes part of the project memory.

### B. Day-to-day use
1. Open Structa and check the home canvas.
2. Read the current project state at a glance.
3. Tap a node to inspect it.
4. Tap again to trigger its default action.
5. Use swipe or scroll to move between nodes without leaving the home state.
6. Use hold on CORE or MEMORY to reveal deeper layers when needed.
7. Use PTT voice capture for fast intent entry.
8. Use camera capture for visual context, evidence, or selfie capture.
9. Review the audit drawer when you need trace, history, or a recent capture.
10. Journal the important result if it should persist.
11. Export or withdraw only after approval.
12. Return to home and keep working with the same calm state machine.

### C. What “good” feels like
- The home screen stays calm and readable.
- The next action is obvious.
- Voice and camera feel like native device actions, not web widgets.
- Mutations are clearly gated.
- The audit trail exists, but it does not dominate the screen.
- The app helps you stay in context instead of turning into chat.

## 2) Device test sheet

Use this on the target device itself.

### Test 0 — launch and visual sanity
Goal: confirm the app launches cleanly.

Steps:
1. Open Structa from the start state.
2. Wait for the main canvas to load.
3. Check the screen for clipping, broken layout, or browser chrome feel.
4. Verify there are four visible primary nodes.
5. Verify the log drawer is collapsed by default.

Expected:
- No console-visible errors.
- No missing assets.
- No obvious overflow or layout breakage.
- Main panel feels premium and native.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 1 — node selection and trigger
Goal: confirm the home canvas behaves like a device instrument panel.

Steps:
1. Tap a node once.
2. Confirm it becomes selected.
3. Tap it again.
4. Confirm the default action runs.
5. Use left/right swipe or scroll to change focus.

Expected:
- Selection is obvious.
- Trigger feels immediate.
- Focus changes without jarring motion.
- No accidental navigation to browser-like UI.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 2 — hidden depth reveal
Goal: confirm the deeper layer is discoverable but quiet.

Steps:
1. Hold CORE.
2. Hold MEMORY.
3. Confirm the hidden nodes or deeper layer appears.
4. Collapse it again.

Expected:
- Hidden depth appears only on intentional hold.
- Reveal is quick and not flashy.
- Home state remains understandable after collapse.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 3 — audit drawer behavior
Goal: confirm the log drawer is usable on touch hardware.

Steps:
1. Swipe up on the drawer handle.
2. Confirm it opens.
3. Tap the handle again.
4. Confirm toggle behavior.
5. Swipe down to close.
6. Confirm the item count and labels remain readable.

Expected:
- Drawer opens and closes reliably.
- Handle is easy to hit.
- Drawer does not feel noisy or oversized.
- It stays secondary to the main canvas.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 4 — voice / PTT capture
Goal: confirm structured voice capture works.

Steps:
1. Press and hold the PTT control.
2. Speak a short project instruction.
3. Release.
4. Confirm the transcription or normalized intent appears.
5. Confirm the capture is routed into the correct context.

Example prompt:
- "Patch the project summary and keep the change approval-gated."

Expected:
- Capture starts and stops cleanly.
- Transcription is not raw noise.
- Intent is structured.
- Silent mode remains the default.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 5 — camera capture
Goal: confirm camera is first-class and useful.

Steps:
1. Open camera capture.
2. Switch front/back camera.
3. Flip to selfie mode if available.
4. Take a photo.
5. Confirm the image is stored with the response/bundle.
6. Confirm the capture can be described or summarized.

Expected:
- Camera opens without hesitation.
- Front/back switch works.
- Selfie flow is obvious.
- Image bundle stores with metadata.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 6 — journal persistence
Goal: confirm important context can be written and kept.

Steps:
1. Trigger a journal action.
2. Add a short structured note.
3. Save it.
4. Re-open the relevant trace or history.
5. Confirm the entry is still there.

Expected:
- Journal entry saves successfully.
- It is linked to the project context.
- It is readable later.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 7 — approval-gated mutation
Goal: confirm changes do not happen without approval.

Steps:
1. Attempt a mutating action such as build, patch, delete, export, or withdraw.
2. Check whether the app asks for approval.
3. Approve the action.
4. Confirm the action completes.
5. Repeat once with no approval and confirm it does not proceed.

Expected:
- Mutations are blocked until approved.
- Approval prompt is clear.
- No silent external action happens.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 8 — export / withdrawal flow
Goal: confirm external handoff is safe.

Steps:
1. Choose an export or withdraw action.
2. Preview the bundle.
3. Confirm the approval step appears.
4. Send only after approval.
5. Verify the audit trail records the export.

Expected:
- External send is explicit.
- Preview is accurate.
- No surprise send.
- Trace is preserved.

Pass / fail / notes:
- [ ] Pass
- Notes:

### Test 9 — recovery and stability
Goal: confirm the app recovers from normal interruptions.

Steps:
1. Open drawer, then close it.
2. Start voice capture, then cancel it.
3. Open camera, then back out.
4. Return to home.
5. Reload the app.

Expected:
- State recovers cleanly.
- No stuck overlays.
- No broken controls after cancel.
- Home state remains stable after reload.

Pass / fail / notes:
- [ ] Pass
- Notes:

## 3) Final device verdict

Use one sentence only:
- Ready / needs one more pass / blocked by specific issue

Issue summary:

Next fix:
