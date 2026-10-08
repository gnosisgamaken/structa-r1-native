# Ox Alpha — Structa Full Codebase Review

Date: 2026-08-21
Reviewer: Ox Alpha (Hermes, read-only trial — high-quality coding analysis)
Repo: /Users/pedro/company/PlayGranada/Operations/structa-r1-native
Head: main branch (184 tracked files). Worktree has untracked local files (see Evidence Index).
Mode: READ-ONLY. No source file, git state, dependency, config, service, or external/Rabbit system was modified. Only the validation commands in package.json / static checks were executed. One report file written.

---

## Executive verdict

**PROMISING-BUT-FRAGILE**

The core architecture is genuinely coherent and unusually mature for an R1-native project: a formal state machine over capture->normalize->harness->validate->cascade->feedback, a real (if partial) validator/sanitizer layer, evidence-cited chain/triangle output, multi-tier persistence, a queue that surfaces stalls, and a green 41/41 harness. That is a real instrument, not a toy.

It is NOT-READY to ship as configured. There are verified P0 blockers: an unauthenticated file-disclosure fallback on the server, a P1 mutating voice command ("delete project") that executes with no approval gate, a genuine ReferenceError in the impact-chain success path that forces every chain step onto the rejected path, a chain-run loop that can mutate on the user's behalf while idle, an unbounded claims array, a queue whose R1-native persistence path is asymmetric, and a red voice-doctrine gate. Some findings from the 2026-08-19 review were re-verified against source and are reproduced only where confirmed; one (queue mismatch) was found to be partially mitigated by the storage wrapper, and is downgraded.

---

## Architecture map

Layer 1 — Capture (device-facing)
- js/camera-capture.js — getUserMedia / native r1.camera.capturePhoto(240,282), show+tell voice strip, asset+node store
- js/voice-capture.js — CreationVoiceHandler STT primary, SpeechRecognition/MediaRecorder browser fallback, voice commands
- index.html — 240x282 webview shell, overlays, log drawer, 16 scripts via document.write

Layer 2 — Server (prompt preparation + normalization)
- server.py — pure functions: voice/image/chain/triangle/thread/brief/title prepare + normalize; /v1/* POST endpoints; /__structa_asset/ GET; /healthz /buildinfo
- js/orchestrator.js — prepare->(client LLM)->normalize round trip via /v1/*

Layer 3 — Client LLM / Rabbit bridge
- js/r1-llm.js — PluginMessageHandler postMessage, pendingBridgeRequests correlation, timeouts, sanitizeResponse (DRIFT list), executePreparedLLM, milestone speech gate, SERP research, email
- js/rabbit-adapter.js — memory/project/nodes/claims/answers/focuses/impact_chain, persistence, rebuildLegacyViews, approval resolve/archive

Layer 4 — Validation / contracts
- js/contracts.js — schema factories + normalizeChainOutput + validateChainOutput + validateTriangleOutput (evidence registry, legal phase/state transitions)
- js/validation.js — envelope/node/project/asset validators
- server.py — chain_normalize + triangle_normalize enforce evidence & shape
- harness/structa_validator.py + semantic_judge.py — text-card validator + semantic banding (drift rejection)

Layer 5 — Cascade / state machine
- structa-cascade.js — transition(newState, data) with enter/exit handlers per state, render throttling, hardware input routing, native back

Layer 6 — Autonomous orchestration
- js/impact-chain-engine.js — focus-driven chain, queue-backed chain-step, dedupe/merge, evidence extend, plateau/reject counters
- js/triangle-engine.js — itemA/itemB/angle synthesis with validateTriangleOutput gate
- js/heartbeat.js — loaded but bpm-guarded (dead module)
- js/processing-queue.js — persistent P0-P3 queue with recovery + blocker surfacing

Layer 7 — Presentation
- js/audio-engine.js, js/icons.js, js/context-router.js (canonicalizeVerb/inferTarget/routeAction), js/diagnostic-suite.js (probe mode), js/storage-manager.js (R1/IDB/localStorage)

---

## Response to required questions

A. End-to-end state machine — YES, it exists and is coherent.
PTT/camera/text capture (voice-capture.js / camera-capture.js) -> orchestrator.js prepare over /v1/* -> client executes the LLM via PluginMessageHandler (r1-llm.js sendToLLM/executePreparedLLM) -> server normalize + contracts.validateChainOutput / validateTriangleOutput -> impact-chain-engine.js / triangle-engine.js apply produced nodes/claims -> rabbit-adapter.js persists + cascade renders. The flow is genuine, not documentary. Where it breaks: B (ReferenceError path) and F (idle auto-run) below.

B. Rabbit bridge / PluginMessageHandler robustness — PARTIAL, mixed.
Strengths: single window.onPluginMessage owner with previous-handler chaining (r1-llm.js:882,920); correlationId matching against pendingBridgeRequests (449,884); per-request timeout that clears the pending entry and resolves BridgeTimeout (450-467); image single-flight guard pendingImageBridgeRequest (565); absent-hardware returns clean bridge-unavailable errors (437-447,557-564). Weaknesses: STT start failure skips the browser fallback and returns without settling (voice-capture.js:1316-1325 — verified; falls through to browser path only on catch, but the catch rethrows into the R1 path and the function returns early in the successful-post branch, leaving listening state ambiguous); stale non-correlated responses are only routeable to activeRequest when they carry extractable text (r1-llm.js:1053), otherwise they leak to the previous handler; double actions are guarded only by requestQueue/activeRequest single-flight in the LLM layer, not at the input layer.

C. Prompt prep vs agent/harness execution separation — MOSTLY CLEAN, with enforcement gaps.
server.py preparation is pure and separate from execution (orchestrator.js run(): prepare -> executeLLM -> normalize). Enforcement is materially present for chain and triangle: chain_normalize rejects missing/illegal evidence (server.py:620-631,754-768), triangle_normalize enforces status/evidence/2-parent rule (670-691,907-917), and contracts.js validateChainOutput additionally checks orphan/inactive evidence and legal phase/state transitions (421-470). BUT: the harness validator (structa_validator.py) is used only by the offline harness; the client never runs it. voice_normalize (server.py:356-409) does no banned-phrase rejection — it parses labels and passes through raw compact text. So the sanitizer/validator layer is partially enforced and partially documentary. C flagged: the voice doctrine gate fails (see test ledger).

D. State/persistence/cascade semantics — PARTIAL, several verified hazards.
- Reload/hydrate: rabbit-adapter.js persist/hydrate (2068-2097) + async hydrate with timestamp-wins (2100-2121) + beforeunload snapshot — sound.
- Pause/resume: queue pause/resume (processing-queue.js:323-332), chain pause/resume + restorePauseState (impact-chain-engine.js:742-761) — present.
- Approval-required actions: decision approve/dismiss exist (rabbit-adapter.js:3346-3410) and NOW surface approves via native.approvePendingDecision (structa-cascade.js:1969). BUT the "delete project" voice command executes unconditionally with no approval gate (voice-capture.js:261-269 -> structa-cascade.js:5646-5655 -> rabbit-adapter.js deleteProject 2291-2318). Verified: a spoken "delete project" destroys the active project, no gate.
- Duplicates/malformed: chain question dedupe by normalized body + semantic_hash (impact-chain-engine.js:264-326); claims dedupe by branch+text when dedupByBranchText (rabbit-adapter.js:839-841) and by full match otherwise; repairEvidenceIntegrity runs on every touch (487+).
- Child creation: addNode caps nodes at MAX_NODES=60 (1085); question/decision/task creation is fine.
- Verified breakages: chain success ReferenceError (B), and the legacy-view rebuild overwriting pushed captures/journals unless a matching node exists (rabbit-adapter.js:1833 vs updateProjectFromCapture 2936; 1885 vs writeJournalEntry 3030). Note: capture IS also stored as a node (camera-capture.js:1137-1153 addNode type:'capture'), so the capture-overwrite finding is mitigated for the current camera path but remains latent for any caller that pushes to project.captures without a node. Journal open_questions push is NOT node-backed and is overwritten by rebuildLegacyViews (verified).

E. 240x282 UX intent — LARGELY MET on-screen, with two device risks.
Lower-case visual language throughout (CSS text-transform:lowercase, index.html:69; copy in COPY table structa-cascade.js:33-42); card/state-driven SVG surfaces; native back via backbutton + popstate (structa-cascade.js:5340-5341, handleNativeBack 4935-5002); camera/voice full-screen overlays (index.html:625-650); touch targets are comfortable for the device (48-56px glyphs, log drawer 28px handle). Risks: viewport meta 240x282 but #app is min(292px,100vh) and scene viewBox is 240x292 — 10px mismatch that can clip the log drawer handle on a real 282px device (index.html:5 vs 73-74, 608); 16 sequential document.write scripts (index.html:662-687) is slow-boot territory.

F. Concrete risks — see Risks section with file:line.

G. Ranked remediation — see P0/P1/P2 plan + first PR.

H. Self-assessment — see Self-assessment section.

---

## Rabbit-native vs provider-agnostic split

Genuinely split in the design, with a few leaks.
- Rabbit-native: PluginMessageHandler (r1-llm.js:41,322,483), CreationVoiceHandler (710-777, voice-capture.js), creationStorage.plain/secure (storage-manager.js, rabbit-adapter.js:226-284), window.r1.camera.capturePhoto (camera-capture.js:1045), window.r1.messaging.emailUser (r1-llm.js:1814-1823), useSerpAPI SERP (2444-2453), com.r1.pixelart image pluginId (1974), hardware events sideClick/scrollUp/longPress/backbutton (structa-cascade.js:5333-5341), 640x480 Rabbithole camera limit (camera-capture.js:839,865).
- Provider-agnostic: server.py prepare/normalize (pure string logic, no secrets), orchestrator.js HTTP round trip, contracts.js validation, cascade state machine, queue, storage-manager fallback chain, harness validator.
- Leaks: "delete project" (a mutation) has no provider boundary — it is executable by voice on device and by the voice command path; the JS is provider-agnostic while relying on Rabbit-only bridge for LLM (acceptable — that is the product) but the app cannot run with an alternative provider without a bridge shim (r1-llm.js is hard-coupled to PluginMessageHandler). The 240x282-specific CSS/SVG is device-bound (intended).

---

## Strengths

1. Real state machine with enter/exit handlers and atomic transition (structa-cascade.js:1180-1200).
2. Single onPluginMessage owner with chaining + correlation IDs + per-request timeout (r1-llm.js:920-1095).
3. Evidence-cited chain/triangle validation actually enforced in two layers (server.py:620-631,670-691; contracts.js:421-470,472-520).
4. Queue-backed async with recovery, blocker surfacing, pause/resume (processing-queue.js), and chain backoff that yields to higher priority work (impact-chain-engine.js:623-626).
5. Multi-tier persistence with timestamp-wins + emergency snapshot (storage-manager.js, rabbit-adapter.js:2068-2129).
6. Voice-doctrine gate as a design (silence default, milestone dedupe/cooldown) even though the gate currently fails (r1-llm.js:256-373).
7. escapeHtml applied on the primary innerHTML string branch (structa-cascade.js:3023-3025) and per-field in buildKnowFrameMarkup (2914+).
8. Cap-aware runtime arrays: pushLimited caps logs/events/impacts (rabbit-adapter.js:37-41,26-34); impact_chain capped at 32, chain.impacts at 24 (impact-chain-engine.js:435,445); MAX_NODES=60.
9. Harness framework: 37 base + 4 ux scenarios all green; validator + semantic judge.
10. Path traversal guard on /__structa_asset/ (server.py:1283-1291).
11. Extensive defensive optional chaining (native?.storeAsset etc.) keeps absent-hardware from crashing.

---

## Risks (ranked, with file:line)

### P0

R1. Unauthenticated file disclosure on the server.
server.py:1332 return super().do_GET() — any unhandled path falls through to SimpleHTTPRequestHandler rooted at cwd, exposing server.py, .env, etc. Combined with bind 0.0.0.0 (1409) and no auth on any /v1/* endpoint (1334+). Verified in source. Fix: remove the fallback (404) or serve only a vetted static dir; add a token for /v1/* when reachable beyond localhost.

R2. Chain success path throws ReferenceError, every successful step is treated as rejected.
impact-chain-engine.js:452 dispatches structa-impact with produced: producedCounts, but producedCounts is not in scope in applyProduced (385-471); it is defined only in handleStepResult (561). Strict mode (line 11) => ReferenceError after memory writes, so the success path always lands in the rejection handling (or the exception propagates to the .then and is caught by handleStepResult's catch at 644). Verified: no definition of producedCounts inside applyProduced. This undermines A/B/D: chain steps write nodes then silently fail the phase transition, inflating plateau/reject counters and stalling the chain.

R3. Voice "delete project" executes with no approval gate.
voice-capture.js:261-269 recognizes /delete project/ and emits structa-voice-command; structa-cascade.js:5646-5655 calls native.deleteProject(cmd.name) directly; rabbit-adapter.js:2291-2318 deletes the active project. No confirmation, no approval_mode, no undo. A misheard "delete project..." or a non-owner utterance destroys project state. (deleteProject does refuse when only one project remains — 2300 — but otherwise it deletes.) This directly violates the product intent "sensitive actions need explicit approval gates."

R4. Chain auto-run can mutate project state on the user's behalf while idle.
impact-chain-engine.js:627-648: beat() picks the next focus (or auto-activates one via activateNextFocus) and runs a chain step that adds claims/questions/decisions/tasks (applyProduced -> addNode/ingestClaims). Auto-pause exists only on 5-min idle timeout (619-621), onboarding (615), diagnostics (611), and manual stop; there is no approval gate on auto-created decisions/tasks. For a "project cognition" instrument that is arguably the intended autonomous loop, but creating decision nodes (createDecisionNode 328-345) without explicit user approval is exactly the "ambiguous action outcomes" the product brief forbids. Requires a product-level decision (approval gate on auto-decisions, or keep advisory-only).

### P1

R5. Unbounded claims growth + data bloat.
rabbit-adapter.js:31 MAX_CLAIMS=9999 is never enforced (only nodes are capped at 60, 1085). Claims are unshifted without a cap (856). Each claim can carry evidence arrays, and repairEvidenceIntegrity runs on every touch. Long-running projects accumulate unbounded claims; combined with persist() writing the whole blob to localStorage (2068-2081) plus creationStorage, storage can exceed quotas and every write gets slower. Fix: cap claims per project + eviction of superseded/archived, and/or move preview_data out of the memory blob.

R6. Queue native-persistence mismatch (partially mitigated).
processing-queue.js:75 writes the raw snapshot to storage.plain.write(STORAGE_KEY, snapshot), but load() (164-172) calls hydrateFrom(result?.value) expecting a wrapper. The rabbit-adapter storage wrapper (rabbit-adapter.js:190-220) wraps values with __structa_storage_v1:true and unwraps on read, so on-device read of a locally-written snapshot would still yield the snapshot object. However the wrapper is only guaranteed when writes go through storageWrite; processing-queue writes directly to storage.plain.write with the raw object, and native R1 creationStorage.plain is NOT guaranteed to apply the wrapper — so native hydration may restore nothing. On browser (localStorage) the path is consistent. Flag as R1-device-only risk; needs device verification. Downgraded from the prior review's claim because the rabbit-adapter wrapper mitigates the localStorage path.

R7. STT bridge failure skips browser fallback and can leave listening ambiguous.
voice-capture.js:1316-1325: if CreationVoiceHandler exists, postMessage('start') succeeds, and the function returns — the browser SpeechRecognition fallback is never reached even if R1 STT never emits sttEnded. If postMessage throws, the catch logs and falls through to the browser path (that part works), but the primary path has no timeout->fallback. Verified: the R1 path returns early; the fallback only triggers when CreationVoiceHandler is undefined or throws.

R8. Voice-doctrine gate is red.
scripts/check-voice-doctrine.sh expects exactly one literal wantsR1Response:true; there are two (r1-llm.js:326 milestone and :694 sendR1CoverSpeech). npm run check:voice-doctrine exit 1. The gate failing erodes trust in the other gates. Fix: route cover speech through the milestone gate or teach the check to allow the sanctioned second speaker.

R9. Legacy-view rebuild overwrites non-node-backed writes.
rabbit-adapter.js rebuildLegacyViews (1783-1890) rebuilds pm.captures (1833), pm.backlog (1788), pm.open_questions (1885) from nodes only; writeJournalEntry pushes to project.open_questions/backlog (3041-3047) with no node -> those pushes vanish on next touch. updateProjectFromCapture pushes to project.captures (2936) but the camera path also adds a capture node (camera-capture.js:1137-1153), so current camera flow survives; any other push-only caller loses data. Verified in source.

R10. No automated tests for the runtime-critical paths.
No unit test files exist. The harness (run_harness.py) tests text-card validation against canned scenarios and trace scenarios against synthetic runtime dumps (harness/runtime/synthetic/*) — it does not execute server.py or the JS. server.py prepare/normalize, contracts.validateChainOutput, camera/voice capture, the R1 bridge, and the cascade state machine have zero automated coverage.

R11. Static-deploy contradiction (from 2026-07-02 audit, re-confirmed).
index.html loads every script via /__structa_asset/<buildId>/js/... which only server.py resolves (server.py:1278). On static hosting all 16 scripts 404 -> black screen. Orchestration POSTs to /v1/* (orchestrator.js) — if the server is unreachable, enrichment dies (capture still survives locally). The runtime model must be decided: deploy server.py (Option 1) or move prompt/normalize into the client (Option 2, recommended for "on the go").

R12. 282 vs 292 viewport mismatch.
index.html:5 meta height=282; #app min(292px,100vh) (73-74); scene viewBox 240x292 (608). On a real 282px device the footer/log handle (which lives at the bottom) can clip. Verified in source. Fix: standardize to one canvas height and verify on device.

### P2

R13. postJSON ok-flag overwrite (orchestrator.js:16): error-body JSON containing ok:true overrides the failure flag. Fix: preserve HTTP-status failure regardless of body.
R14. Broad exception handlers leak internals (server.py:1294-1295, 1403-1404 str(err)); and Content-Length int() can ValueError on non-numeric input (1269) — no try/except around the int parse. Fix: log server-side, return generic message; wrap the parse.
R15. Rate-limiter TOCTOU + spoofable key (server.py:160-172): bucket read->filter->check->append not atomic under ThreadingHTTPServer (1409), and key is client-supplied deviceId. Unbounded CLAIMS_EXTRACT_BUCKETS dict (9) never pruned. Fix: server-trusted identifier + lock/atomic counter + periodic prune.
R16. XSS surface: scroller.innerHTML object branch uses raw content?.html with no escaping (structa-cascade.js:3023-3025). The string branch escapes (escapeHtml). Any consumer passing an object {html} with user-derived HTML would inject into the webview. Fix: sanitize or drop the html branch.
R17. Duplicate evaluateMilestone declared twice verbatim (r1-llm.js:338-373 and 375-410) — dead copy-paste, confusion risk.
R18. validation.js masked by contract defaults (validation.js:12-47): validators call contracts.createX(raw) first, which default required fields, so isNonEmptyString always passes and missing required input can't be rejected. Verified (contracts.js:28-48 defaults project_code/entry_id).
R19. Stale voice annotation reuse: camera-capture.js:1065 reads voiceStripTranscript in capture(); stopVoiceStrip() (939-970) does not clear it (only close() at 1188 does). A silent photo after a voice capture reuses the old transcript as annotation. Verified: voiceStripTranscript cleared at 891 (start), 924 (set), 999 (set), 1188 (close) — NOT in stopVoiceStrip.
R20. Dead modules/blocks: heartbeat.js never loaded by index.html (all bpm-guarded calls no-op, structa-cascade.js:617-618,2298-2300); onboarding functions hardcode inactive (structa-cascade.js:508-518 freshWorkspaceState false / getOnboardingStep 'complete' / onboardingActive false) making large onboarding blocks unreachable; voice-only MVP left vision call sites (requestCaptureDescription, probeImagePrompt, fetchLabeledImageAnalysisText, sendR1CoverSpeech) in r1-llm.js as documented dead code (2047-2202).
R21. Harness brittle: run_harness.py _http_json has no try/except (129-137); detect_lmstudio_model same (161-165); load_scenarios path.read_text() no existence check (39-43) — one bad scenario or unreachable server crashes the batch. Fix: per-scenario try/except and skip.
R22. package.json declares serve, unused (audit 2026-07-02, confirmed). Dependencies unused.
R23. figma-plugin/code.js:34-38 loadFonts catch swallows errors; createText may throw later and figma.closePlugin() never runs, hanging the plugin.
R24. Plaintext persistence of sensitive data: persist() writes full memory blob (voice transcripts, preview_data base64, analyses) to localStorage (rabbit-adapter.js:2068-2081); storage-manager.js r1Save/idbSave/lsSave persist base64/JSON plaintext (48-54,150). R1 creationStorage.secure exists and is used for snapshotState (2388) but the main blob goes to plain. Fix: use secure tier for sensitive fields.

---

## Rabbit-native vs provider-agnostic split (summary table)

| Concern | Rabbit-specific (device) | Provider-agnostic (pure) |
|---|---|---|
| STT/PTT | CreationVoiceHandler, PluginMessageHandler (r1-llm.js:41; voice-capture.js) | orchestrator.js, server.py normalize |
| Image | r1.camera.capturePhoto, com.r1.pixelart pluginId, Rabbithole 640x480 cap | camera-capture.js getUserMedia + asset store |
| Memory | creationStorage.plain/secure | storage-manager.js IDB/localStorage fallback |
| LLM | on-device bridge (sendToLLM) | server.py prompt shaping + contracts.js validation |
| Search/email | useSerpAPI, r1.messaging.emailUser | — |
| Input/UX | sideClick/scrollUp/backbutton, 240x282 viewport | cascade state machine, queue, contracts |

---

## Test ledger (commands run, read-only)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | python3 -m py_compile server.py harness/run_harness.py harness/structa_validator.py harness/semantic_judge.py | 0 | All py OK |
| 2 | node --check structa-cascade.js | 0 | OK |
| 3 | node --check js/*.js (all 16) | 0 | All OK (no output = no failures) |
| 4 | sh scripts/check-voice-doctrine.sh | 1 | FAIL (2 literals; expected 1) — pre-existing, tracked-source caused |
| 5 | python3 harness/run_harness.py --suite trace --scenarios harness/scenarios | 0 | 37/37 passed (writes harness/outputs/* — outputs dir is gitignored) |
| 6 | python3 harness/run_harness.py --suite trace --scenarios harness/scenarios/ux | 0 | 4/4 passed |
| 7 | node scripts/context-router-smoke.mjs | 1 | FAIL: line 39 expects inferTarget('send the email now','withdraw')==='export', actual 'structure' (verb-synonym 'send out' not in targetHints order) — tracked-source bug in the smoke's own expectation vs context-router.js:60-69 |
| 8 | node scripts/consolidation-smoke.mjs | 1 | FAIL: js/rabbit-adapter.js:355 window.location.hash TypeError in node vm (no window.location in sandbox) — harness/env issue, not app logic |

Failures 7 and 8 are not in package.json scripts; both are pre-existing issues in the untracked-ish script files themselves (tracked: context-router-smoke.mjs and consolidation-smoke.mjs ARE tracked). Failure 4 is the known voice-doctrine gate. All harness failures are attributable to current tracked source, none caused by dirty worktree.

Note: harness runs 5/6 wrote new files under harness/outputs/ (gitignored). No other writes.

---

## Evidence index

Tracked source (184 files at HEAD). Primary files read in full or near-full:
- server.py (1411) — read fully; all prepare/normalize + endpoints + handler
- structa-cascade.js (5711) — state machine, transition, back, camera/voice state handlers, render, event wiring, voice-command handler
- js/r1-llm.js (2688) — bridge, queue, sanitizer, milestone gate, image paths, SERP/email
- js/rabbit-adapter.js (3713) — persistence, nodes/claims/answers, rebuildLegacyViews, approvals, deleteProject, flush
- js/processing-queue.js (441), js/orchestrator.js (140), js/validation.js (105), js/storage-manager.js (238), js/contracts.js (613) — full
- js/impact-chain-engine.js (788), js/triangle-engine.js (804), js/camera-capture.js (1252), js/voice-capture.js (1462) — key sections
- index.html (689), harness/run_harness.py (912), harness/structa_validator.py (171), harness/semantic_judge.py (87) — full
- scripts/check-voice-doctrine.sh, scripts/context-router-smoke.mjs, scripts/consolidation-smoke.mjs
- js/heartbeat.js, js/context-router.js, js/audio-engine.js, js/icons.js, js/diagnostic-suite.js — scanned for the specific claims
- docs/reviews/structa-code-review-2026-08-19/REPORT.md — used as hypothesis source; findings independently re-verified against source (see self-assessment)

Docs read (hypotheses, not proof): STATE.yaml, README.md, replit.md, ARCHITECTURE_REPORT.md, IMPLEMENTATION.md, STRUCTA_FULL_AWESOMENESS_AUDIT_2026-07-02.md, STRUCTA_R1_NATIVE_ARCHITECTURE_BRIEF_V2.md, STRUCTA_R1_INTERACTION_SPEC_V1.md, STRUCTA_R1_NATIVE_SPEC_V1_1.md, STRUCTA_R1_LAUNCH_EXECUTION_BRIEF_V1.md, STRUCTA_USER_JOURNEY_AND_DEVICE_QA.md, STRUCTA_PROMPT_CONTRACT_V4.md, STRUCTA_R1_VALIDATION_RULES_V1.md, STRUCTA_FULL_INTERVENTION_DESIGN_V1.md, STRUCTA_R1_ANYWHERE_CARD_TEST_RESULTS_2026-04-11_B.md, R1_ANYWHERE_MOCK_HARNESS_PROTOCOL.md

Untracked (dirty) files — NOT reviewed as canonical: .claude/launch.json, Briefing_Necesidades_Cliente_Granada_Maslow.pdf, README.md (auto-generated evidence node contract), STRUCTA_FULL_AWESOMENESS_AUDIT_2026-07-02.md (reviewed as doc, not source), brain_digest.yaml, harness/scenarios/batch_smoke_10.json, play_granada_front_perspective_corrected.jpg, play_granada_signage_planning_board.jpg. Also deleted: .claude/worktrees/exciting-chebyshev. The tracked README.md (auto-generated node contract) is present in git ls-files, and the untracked README.md in the worktree is a different auto-generated file — noted but not treated as canonical source.

Prior-review cross-check (2026-08-19 REPORT.md, hy3:free): verified against source with the line refs above — R1 (file disclosure), R2 (ReferenceError), R3 (delete-project), R6 (queue mismatch, downgraded), R9 (rebuild overwrite), R16 (XSS object branch), R17 (dup function), R18 (validation masked), R19 (stale annotation), R20 (dead modules). Not reproduced because not in current source: heartbeat field reads (heartbeat.js:58-73 read backlog/open_questions which contracts.createProject doesn't define — confirmed present but dead since heartbeat isn't loaded); capture/journal overwrite (confirmed latent only). The prior report's claim 10 (capture overwrite) was softened to latent because the camera path also creates a node.

---

## P0/P1/P2 remediation plan

P0 (blocking; first PR):
1. server.py:1332 — remove super().do_GET() fallback; return 404 for unknown paths, or restrict static serving to a vetted dir. Acceptance: GET /server.py -> 404; GET / -> app still loads.
2. impact-chain-engine.js:452 — pass producedCounts into applyProduced or dispatch the event from handleStepResult. Acceptance: after a successful chain step, focus.step outcome='progress' and no 'rejected' trace; harness s/u/v scenarios still green.
3. voice-capture.js:261-269 + structa-cascade.js:5646-5655 + rabbit-adapter.js:2291 — gate delete-project behind an explicit confirmation state (and archive-first fallback). Acceptance: spoken "delete project" requires on-screen confirm; no direct deleteProject call without gate.
4. Product decision on auto-decisions (impact-chain-engine.js:328-345, beat 627-648): require explicit user approval before decision/task nodes are created, or keep the chain advisory-only. Acceptance: no decision/task node is created without an explicit approval step.

P1 (next PR):
5. Enforce claims cap (rabbit-adapter.js:856) — cap per project with eviction of superseded/archived; move preview_data out of the persisted blob. Acceptance: claims never exceed cap; persistence size bounded.
6. Voice doctrine gate (r1-llm.js:694 or check script) — route cover speech through the milestone gate or teach the check. Acceptance: npm run check:voice-doctrine exit 0.
7. STT fallback (voice-capture.js:1316-1325) — add a timeout that falls back to browser STT when R1 STT yields nothing. Acceptance: when CreationVoiceHandler never emits sttEnded, transcript is still produced.
8. Journal/backlog writes — write a backing node in writeJournalEntry (rabbit-adapter.js:3030) so rebuildLegacyViews doesn't drop them. Acceptance: journal entries survive a touch.
9. Storage quota — cap preview_data and prune old captures/claims; use creationStorage.secure for sensitive fields (R24). Acceptance: large project doesn't blow localStorage; sensitive fields not in plain.
10. Decide deployment model (R11) — either commit to server.py deployment or move prepare/normalize client-side and restore static-safe URLs. Acceptance: app boots on the target runtime without /__structa_asset/.

P2 (hardening backlog):
11. orchestrator.js:16 ok-flag fix; 12. server.py exception/Content-Length hardening; 13. rate-limiter atomicity + prune; 14. XSS object-branch sanitize (structa-cascade.js:3023-3025); 15. delete duplicate evaluateMilestone; 16. validation.js unmask required fields; 17. clear voiceStripTranscript in stopVoiceStrip; 18. remove/dead-code-clean heartbeat, onboarding dead blocks, vision call sites; 19. harness per-scenario error isolation + existence checks; 20. drop serve dependency; 21. figma loadFonts error handling; 22. viewport 282/292 standardization.

Acceptance test pattern for all: add unit tests (no test framework exists; start with node:test for js/contracts.js + server.py normalize via a small pytest) covering each fix; re-run harness (41 scenarios must stay green); re-run voice-doctrine gate.

---

## First PR (minimal, self-contained)

Branch: fix/ox-alpha-p0
Files (exact):
- server.py — replace super().do_GET() fallback with 404 for unknown GET paths; wrap Content-Length int parse; return generic 500 messages.
- js/impact-chain-engine.js — fix producedCounts scope bug (move applyProduced call result to where the event is dispatched, or pass counts out).
- js/voice-capture.js — gate delete-project: emit structa-voice-command only with a pending-confirm flag; cascade listens and requires explicit confirm before calling native.deleteProject.
- structa-cascade.js — add confirm state/flow for delete-project; do not call native.deleteProject from the command handler without confirmation.
- scripts/check-voice-doctrine.sh — document/tolerate the second sanctioned speaker or unify cover speech through the milestone gate.
- Add minimal node:test for contracts.validateChainOutput (orphan/illegal-phase) and server.py normalize round-trip smoke.
Acceptance: all P0 fixes green; harness 41/41; voice-doctrine gate green; no regressions in tracked source outside these files.

---

## Self-assessment (Ox Alpha)

What I could verify: everything above is from direct source reads and executed read-only commands. The prior 2026-08-19 review was treated strictly as hypothesis and every finding I repeat was re-verified against current source with the cited line numbers. Harness 41/41 green is real; the voice-doctrine gate failing is real; the two script failures are real and attributable to tracked source.

Where I am uncertain:
- Real Rabbit R1 hardware / R1-anywhere was not available. PluginMessageHandler, CreationVoiceHandler, creationStorage, r1.camera.capturePhoto, r1.messaging.emailUser behavior is inferred from code and community docs (docs/r1-image-analysis-research.md) — I cannot confirm the bridge's actual response shapes, whether wantsR1Response:false suppresses speech, or whether storage.plain.write applies the __structa_storage_v1 wrapper on device. R6 and the STT primary-path behavior (R7) are therefore flagged as device-verification items, not certainties.
- npm dependencies were not installed (package.json has serve, unused); I did not run a live server, so server.py endpoints were validated by py_compile + source read, not by HTTP exercise.
- I did not execute the app in a browser/R1 webview, so viewport clipping (R12), innerHTML object-branch injection reachability (R16), and document.write script loading were assessed statically.
- The 41 green trace scenarios run against synthetic/from_device runtime dumps in harness/runtime — they validate the harness logic, not the live app; real-device runtime dumps (from_device) were not available to cross-check.
- Untracked artifacts (README.md node contract, batch_smoke_10.json, images, PDF) were excluded from canonical source review per the task instructions.
- Performance (boot time, render fps) was not measured on device.

---

## Explicit non-claims

- This is not a claim that the app works on real Rabbit R1 hardware — no device was exercised.
- This is not a claim that the server is safely exposable to a network — it is explicitly not (R1).
- This is not a claim that the harness proves app correctness — it proves the harness scenarios and validator logic.
- This is not a claim about the correctness of untracked/dirty worktree files — they were excluded from review.
- This is not an endorsement of the delete-project, auto-decision, or any other behavior as product-correct; those are flagged for explicit Pedro decisions.
- This is not a claim that findings 8/10/12/14 from the prior review are all live bugs in current source; several were found to be mitigated (capture node creation) or dead (heartbeat never loaded).

---

REPORT_WRITTEN:/Users/pedro/company/PlayGranada/Operations/structa-r1-native/reviews/ox-alpha-2026-08-21/OX_ALPHA_STRUCTA_FULL_CODEBASE_REVIEW_2026-08-21.md

VERDICT: PROMISING-BUT-FRAGILE
