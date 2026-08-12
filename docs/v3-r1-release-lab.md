# STRUCTA V3 R1 release lab

Run this on physical Rabbit R1 hardware before calling the silent visual relay production-ready. Browser diagnostics are necessary but cannot prove speaker, journal, callback, camera, or memory behavior on the device.

R1 Anywhere may be used first to exercise Rabbit-backed prompts and schemas, but RabbitOS runs only one creation at a time, so it cannot validate STRUCTA's own callback, camera, voice, controls, persistence, or silence contract. Physical STRUCTA remains the release gate. See `v3-device-feedback-loop.md`.

## Build identity

- UI build: `ui-20260812-structa-v3.8`
- Vision schema: `structa.vision.v1`
- Device / OS:
- Tester / date:
- Device-proof session ID:
- rabbitOS version:
- Deployed server SHA:

Fresh v3.8 proof sessions remain active for twelve hours so one careful B00–B07 owner run can finish without silently rolling into a replacement session. An older two-hour proof remains recoverable and exportable, but it cannot pass the release validator if its recorded finish occurred after its own `expires_at`.

## Twenty-capture matrix

| Set | Captures | Required examples |
|---|---:|---|
| Sketches and diagrams | 7 | Hand sketch, annotated plan, flow diagram, low-contrast pencil, rotated page, dense notes, deliberately ambiguous sketch |
| Spaces | 7 | Room overview, doorway/circulation, exterior, low light, reflective surface, partial obstruction, deliberately unresolvable scale |
| Materials and objects | 6 | Material close-up, object assembly, damaged condition, multiple objects, fine texture, deliberately ambiguous material |

For every capture record:

- Capture appears in SHOW before analysis completes.
- Original remains available after RabbitOS Back exit/relaunch, force close, and offline transition.
- No Rabbit speech.
- No Rabbit Hole journal entry.
- Response contains the exact outstanding `vision_id` and valid schema.
- Response is attached to the correct capture and project.
- Observation, interpretation, implication, and uncertainty remain distinct.
- Sketch is not treated as accepted fact; external reference is not treated as project evidence.
- Timeout, invalid JSON, and rejected wrong-ID responses remain transport-degraded/non-blocking; a result that actually attaches to the wrong capture/project is a release blocker.

## Camera entry and cancel contract

- A touch whose clear intent is to enter SHOW or open its lens must open the preview in that same gesture; it must not show a full-page activation card or require a second tap.
- Side or empty-SHOW PTT cannot satisfy R1 WebView activation. They visibly arm the normal SHOW camera area/control; one touch on that highlighted target opens the preview. Unrelated SHOW touches remain normal browsing input.
- With the preview open, tap the visible top `cancel` button. It must return to SHOW without storing a frame.
- RabbitOS system Back exits the whole creation and is not an in-app cancel. Test it only after saving an original, then relaunch and verify persistence.
- The B03 proof is incomplete without both a same-gesture touch-activated camera-open event and an open→in-app-close interval containing no capture.
- B03 must prove both comment paths: PTT on a selected stored frame, and PTT while the live preview is open. In each case the exact trimmed transcript must appear on that SHOW frame and as one linked TELL note, survive relaunch, and remain unchanged when visual analysis completes.

## Twenty-capture run order

Open [`b04-target-pack.html`](b04-target-pack.html) on a laptop/tablet (or print it) for the original S1–S7 targets and practical household P1–P7/M1–M6 shot list. Advance the proof panel to `B04` only after `B03` and its pending analyses are complete. Note the latest Rabbit Hole entry and count, then capture `S1–S7`, `P1–P7`, and `M1–M6` in the table above. Use a plain capture, wait for its reading or explicit unavailable/degraded state, record the two-axis outcome, and only then open the lens for the next target. Exactly 20 stored captures belong in this phase; a shutter failure that stores no original may be retried.

Record each result as `ID · transport valid/degraded · semantic matched/non-match · clipped yes/no · silent yes/no`:

- Transport is **valid** only when STRUCTA accepts a `structa.vision.v1` envelope with the exact outstanding `vision_id`. Both `observed` and `insufficient` are valid schema statuses. `Visual signal insufficient` therefore proves an accepted transport envelope; it does not mean transport was unavailable.
- Transport is **degraded** when analysis explicitly becomes unavailable because no acceptable envelope resolved the request, such as a timeout, malformed response, or rejected ID. A result attached to another frame/project is a correlation blocker rather than an ordinary degraded outcome.
- Semantics are **matched** only when the reading is accurate and useful for that prepared target. On deliberately ambiguous controls `S7`, `P7`, and `M6`, a valid `insufficient` response may count as matched only when it appropriately preserves the intended ambiguity and makes no unsupported confident claim.
- Semantics are a **non-match** for an unrelated, confidently false, or unjudgeable reading. A valid `insufficient` response on any clear target—`S1–S6`, `P1–P6`, or `M1–M5`—is a semantic non-match even though transport succeeded. Every transport-degraded result is also a semantic non-match for the product score.

A shutter or feedback tone is allowed, but spoken words are not. Check Rabbit Hole after captures 5, 10, 15, and 20.

After the twentieth result, browse all 20 originals, exit with RabbitOS Back, relaunch, and confirm every original remains in the same project. Check Rabbit Hole for the full test window. Report all two-axis target outcomes, plus persistence and Rabbit Hole status. Clipping is a separate UI defect, but an unjudgeably clipped reading is a semantic non-match.

Stop immediately on speech, an automatic journal entry, a lost original, cross-capture/project attachment, a duplicated result, or an unexpected app exit. An explicit unavailable result may continue as transport-degraded. Stop when three targets are semantic non-matches, including targets whose transport degraded; the manual 18/20 usefulness threshold is then mathematically impossible. Stop if one capture remains processing without resolving or degrading for 90 seconds, because issuing another request would make correlation evidence ambiguous.

## Fault injections

1. Switch projects while one image is analyzing. The result must stay with its originating project or be rejected as stale.
2. Capture three images quickly. Each callback must match one request; no first-text-wins behavior.
3. Disable connectivity after capture. The image must remain usable and the queue must recover without user intervention.
4. Return prose before JSON and unrelated bridge text. Only the matching validated envelope may resolve the request.
5. Force `status: insufficient`. STRUCTA must queue uncertainty and withhold dependent decisions without blocking other branches.
6. Resolve one uncertainty by each action: confirm, correct, dismiss. Then use RabbitOS Back on a fourth item, relaunch, and confirm it remains unresolved.

## Release threshold

- At least 18 of 20 captures return a valid, exactly correlated envelope.
- At least 18 of 20 displayed readings are independently judged semantic matches against the prepared targets; a green machine proof does not supply this score.
- Zero unsolicited speech.
- Zero journal entries.
- Zero cross-capture or cross-project matches.
- Zero lost originals.
- All six fault injections pass.

Any speech, journal write, mismatched callback, or lost original is an automatic release blocker regardless of the aggregate score.

The sanitized proof verifies transport flags, exact correlation/schema acceptance, and attachment only. It cannot see the prepared target, judge semantic usefulness, hear the speaker, or inspect Rabbit Hole. The 20 manual semantic judgments, direct tester observation, and Rabbit Hole screenshot are required in addition to a green proof validator result.

After the run, attach the sanitized device proof, synthetic `.structa.json`, and a Rabbit Hole screenshot covering the test window. Real project content and any R1 Anywhere key must not appear in the bundle.
