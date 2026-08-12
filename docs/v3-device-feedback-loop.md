# STRUCTA physical-device feedback loop

This is the release path from a real Rabbit R1 back to a reproducible STRUCTA result. Browser, VM, and trace-harness checks remain useful, but none of them can prove the physical camera, PTT, wheel, speaker silence, Rabbit Hole behavior, WebView lifecycle, or creation storage.

Use synthetic project content in every lab run. A device proof can contain project identifiers and operational metadata even though it must never contain credentials, full prompts, image data, or transcripts.

## What each test lane can prove

| Lane | Proves | Does not prove |
|---|---|---|
| Repository tests | Reducers, schemas, correlation, project isolation, UI geometry | RabbitOS delivery or physical hardware |
| Boondit emulator | 240×282 rendering, wheel/Side event routing, mock callbacks | Camera, microphone, storage, speaker, Rabbit Hole, lifecycle |
| R1 Anywhere | Rabbit-backed text/vision responses and STRUCTA schema tolerance | STRUCTA's own WebView, callback, capture, voice, controls, or persistence |
| STRUCTA on R1 | The complete product contract | Nothing else may substitute for this release gate |

RabbitOS runs only one creation at a time. R1 Anywhere and STRUCTA therefore run as separate test passes, never simultaneously.

## Prepare one lab run

1. Charge the R1, connect it to stable Wi-Fi, and note the rabbitOS version.
2. Use a synthetic project such as `LAB — studio wayfinding concept`.
3. Install the separate lab URL, not the public tester build:

   `https://structa.replit.app/?debug=1#probe`

4. Record the UI build ID, deployed server SHA, tester, device, date, and session ID. Set `STRUCTA_BUILD_SHA` and `STRUCTA_BUILT_AT` in the deployment environment; `workspace` is only a development fallback and is not sufficient release identity.
5. Tap the 44×44 **proof** control in the top-right corner, then run **check build** before testing any feature.
6. Stop if the expected and deployed build identities do not match.

The lab build adds one 44×44 `proof` control in the top-right corner. Tap it, then tap `step · B00` to advance through the phases below. At the end, use `finish + send`. `journal backup` is an explicit post-test fallback only; it deliberately creates a Rabbit Hole entry after the silence check is complete.

The production log drawer remains intentionally hidden. The owner lab is operated entirely through the top-right **proof** panel; plain `#probe` is not the documented install route for this build.

## Pass A — Rabbit provider through R1 Anywhere

R1 Anywhere is a third-party community relay. It gives the paired R1 a separate `boondit_r1_…` key; it does not require sharing Rabbit credentials with STRUCTA or with Codex.

Its current client requests a Rabbit journal entry for all relayed chat-completion calls, including its image path. Use synthetic content, expect this lane to appear in Rabbit Hole, and never use it to judge STRUCTA's own zero-journal contract.

1. Install **R1 Anywhere** from the Boondit store and keep it open in the foreground.
2. On a phone or computer, sign in to Boondit, open **Settings → R1A**, and choose **Pair R1A**.
3. On the R1, scan that pairing QR from R1 Anywhere.
4. Put the relay base URL and key in local environment variables only. Never paste the key into chat, screenshots, Git, Discord, or a test report.
5. Run `npm run --silent smoke:r1a -- --dry-run` first, then follow `docs/r1a-serial-smoke.md` for the live command.
6. Permit exactly one in-flight request. Wait up to 90 seconds, then leave at least 15 seconds between completed requests. Never retry an ambiguous timeout.
7. Run the built-in three text/schema cases, then optionally one synthetic image case. Review that report before repeating or expanding the corpus. Stop on a correlation mismatch, authentication failure, rate limit, or disconnected session.
8. Keep the R1 foregrounded and plugged in. R1 Anywhere already sends a 30-second connection ping; do not generate artificial completion traffic as a keepalive.
9. Revoke or rotate the relay key in Boondit Settings after the run. Device-side **Disconnect & Unlink** alone is not proof of server-side revocation.

Treat all R1 Anywhere pacing as conservative lab policy, not a published Rabbit quota. Its current client holds only one mutable pending request, so concurrency can misattribute a late response.

## Pass B — STRUCTA on the physical R1

Run these phases in order. Set the active device-lab step before each phase when the lab controller is available.

| Step ID | Phase | Required actions | Pass condition |
|---|---|---|---|
| `B00` | Build truth | Cold launch, open **proof**, run **check build** | Correct UI/assets/server; no boot error |
| `B01` | Hardware | Touch; 10 wheel detents each way; Side; PTT; shake; system Back last | One intended action per input; system Back exits; relaunch resumes without mutation |
| `B02` | Voice | Known phrase; empty release; cancel; answer question; custom decision | One transcript to the correct project; empty input creates nothing |
| `B03` | Camera | Direct SHOW touch; hardware cue; rear/front; flip; in-app cancel; capture; SHOW+TELL; host exit/relaunch | An intentional SHOW touch opens the lens immediately; hardware-only entry waits for the next touch; cancel returns SHOW; originals survive relaunch |
| `B04` | Vision | Run the 20-capture matrix in `v3-r1-release-lab.md` | At least 18 valid; zero speech, journal writes, mismatches, or lost originals |
| `B05` | Product | TELL → SHOW → KNOW → NOW; approve; reverse; review uncertainty | Clear map; stable human-gated decisions; batched uncertainty works |
| `B06` | Recovery | Offline; force-close; denied camera; timeout; malformed/wrong ID; project switch | Graceful degradation, correct project binding, queue recovery |
| `B07` | Export | Finish lab session; export proof; export project corpus | Proof and corpus reopen and validate |

For the visual relay, any unsolicited speech, Rabbit Hole entry, cross-project/cross-capture callback, or lost original is an automatic blocker even if 18 of 20 captures otherwise pass.

### B03 exact camera sequence

RabbitOS does not deliver system Back to this web creation. Back exits STRUCTA; that is the verified host contract, not a failed in-app cancel. Camera permission also requires a direct touch. A touch whose clear intent is to enter SHOW or open its lens should open the preview in that same gesture. Side or empty-SHOW PTT cannot grant camera access; they leave SHOW visible with only a subtle touch cue, and the next intentional SHOW touch opens the lens. User activation is per gesture, not a permission that an earlier arbitrary touch can bank for later.

1. Set the proof step to `B03`, close the proof panel, and enter SHOW.
2. On empty SHOW, tap the empty capture area once. The rear preview must appear directly, without a full-page activation card or a second tap.
3. Tap the visible top `cancel` button. It must close the lens, return to SHOW, and store no capture.
4. On empty SHOW, press Side once. SHOW must stay usable and show no more than a subtle `touch to open lens` cue. Tap an appropriate part of SHOW once; the rear preview must open on that touch.
5. Use Wheel to flip rear/front and back. Confirm both previews, then capture one plain frame with Side or by tapping the preview.
6. Confirm the original appears in SHOW immediately, while its reading may still say that it is processing.
7. Reopen with one intentional SHOW touch. Hold PTT, say `this sketch shows the studio entrance circulation`, then release. It must capture one SHOW+TELL frame and return to SHOW.
8. Confirm the second original appears immediately and the spoken context stays attached to that frame. Wait until both B03 captures show either a project reading or an explicit degraded state. The device must not speak and STRUCTA must not create a Rabbit Hole entry.
9. Only after both captures have settled, press RabbitOS Back. STRUCTA should exit. Relaunch and confirm the project and both originals persist.

The proof requires one camera-open event whose last relevant physical input was direct touch, plus one open→close interval containing no stored capture. A repeated full-page activation interstitial, a second required touch after an intentional SHOW touch, or a system-Back exit cannot satisfy this contract.

### B04 exact silent-vision sequence

Finish all of `B03`, including its pending analyses and relaunch check, before advancing the proof panel once to `B04`. Use plain image captures in this phase; SHOW+TELL was already proved in `B03`. Keep exactly one analysis in flight. Note the latest Rabbit Hole entry and count before the first capture.

Prepare these 20 synthetic targets and run them in order:

- `S1–S7` sketches/diagrams: bold hand sketch; annotated plan; flow diagram; low-contrast pencil; rotated page; dense notes; deliberately ambiguous sketch.
- `P1–P7` spaces: room overview; doorway/circulation; exterior; low light; reflective surface; partial obstruction; deliberately unresolvable scale.
- `M1–M6` materials/objects: material close-up; object assembly; damaged condition; multiple objects; fine texture; deliberately ambiguous material.

For each target:

1. Open the lens from the visible camera affordance (or the empty SHOW body) with one intentional touch, frame the target, and capture once with Side or a preview tap.
2. Confirm its original appears in SHOW immediately. If no original was stored, retry; a failed shutter is not one of the 20.
3. Wait until that capture changes from processing to either a project reading or an explicit unavailable/degraded state before opening the lens again. Never start the next target while the current one is still processing.
4. Record only `ID · matched / degraded / wrong · clipped yes/no · silent yes/no`. `Matched` includes an appropriately uncertain/insufficient reading of an ambiguous target; `degraded` means analysis explicitly became unavailable; `wrong` means unrelated, confidently false, or attached to another frame. Mark clipped separately so the known reading-layout defect does not become a vision failure unless it prevents judging the result. A shutter or feedback tone is allowed; spoken words are not. Use a photo only for a wrong, duplicated, unjudgeably clipped, or visibly broken result.

Check Rabbit Hole after captures 5, 10, 15, and 20. After `M6`, use Wheel to browse all 20 originals. Exit with RabbitOS Back, relaunch, and confirm all 20 remain attached to the same project. Then inspect Rabbit Hole for the full test window.

Stop immediately and preserve the current proof if the device speaks, Rabbit Hole gains an automatic entry, an original disappears, a result lands on the wrong capture/project, a result is duplicated, or the app exits unexpectedly. An explicit unavailable result may continue as degraded; stop after the third degraded result because the 18/20 threshold can no longer pass. If processing neither resolves nor degrades within 90 seconds, stop rather than creating another request.

Report the 20 compact outcome lines, whether all originals survived relaunch, whether the device remained silent, whether Rabbit Hole remained unchanged, and a photo of any anomaly. If clipping prevents judging a reading, label it `unjudgeable` in addition to `clipped yes`. Stop after `B04`; review the evidence before starting `B05`.

The machine proof can establish that STRUCTA never requested speaker output or an automatic journal entry through the intercepted bridge. It cannot hear the device or inspect Rabbit Hole itself. The tester's direct observation and the Rabbit Hole screenshot are therefore separate required evidence; a green validator result alone is not the physical release verdict.

## What to attach here

For a passing run:

- every sequential `STRUCTA proof ... [part/total]` email from **finish + send**, saved as plain-text files or pasted into separate text attachments;
- the sanitized `STRUCTA_DEVICE_PROOF.json` too if the device exposes a usable download, but do not treat the WebView's download request as confirmed delivery;
- the exported `.structa.json` from the synthetic project;
- one Rabbit Hole screenshot covering the test window and showing no automatic vision entries;
- rabbitOS version and the visible STRUCTA build ID.

For a failure, add only:

- a 10–30 second video or two photos showing the exact failure;
- the step ID and expected versus actual behavior;
- the proof bundle from the same session.

Keep all emailed parts from the same session together; the validator reassembles them, verifies their checksum, and rejects missing or duplicated parts. Validate either the JSON or all text parts with:

`npm run validate:device-proof -- <proof.json-or-part-files...>`

Use **journal backup** only after the test if email transport fails. It deliberately creates a Rabbit Hole entry and contains a compact human digest, not the validator-compatible full proof.

Do not paste relay keys, Rabbit credentials, real client material, raw image base64, or private transcripts. With the proof's session ID, sequence numbers, request IDs, build identity, and sanitized event neighborhood, Codex can reproduce the failing path, patch it, and ask for only the failed phase plus `B00` to be rerun.

## When the Discord pilot may begin

Invite outside testers only after one owner-run device proof passes `B00`–`B03`, one complete 20-capture visual run passes `B04`, and the proof export itself passes `B07`. The public tutorial comes after those gates so it teaches proven behavior rather than masking unknown runtime failures.
