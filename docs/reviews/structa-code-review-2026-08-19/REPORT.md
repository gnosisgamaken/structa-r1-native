# Structa Code Review — Builder Report (hy3:free primary)

Date: 2026-08-19 (re-run with requested model)
Reviewed by: builder profile (Hermes Agent), model: **tencent/hy3:free** (via Nous portal)
Repo: https://github.com/gnosisgamaken/structa-r1-native.git
Local path: /Users/pedro/company/PlayGranada/Operations/structa-r1-native
Commit reviewed: e7d7c6ce94f7cbe06daa5a6e6ef28c7f62b1ab5d ("Add Figma plugin for generating UI surfaces")

## Model status (corrected)

The originally-requested model `tencent/hy3:free` **is available on the Nous
portal** at zero price (verified live: catalog entry with pricing 0/0 and a
direct inference probe returning finish_reason stop). The previous OpenRouter
substitute (`nvidia/nemotron-3.5-lightning:free`) is preserved as a fallback;
this report is the hy3:free re-run. See `MODEL_SWAP_NOTE.md` for the full
swap rationale, the exact-parameter (max_tokens 6000 → null content) evidence,
and the documented parameter adaptation (max_tokens 32000 so final findings are
emitted; temperature 0.3 unchanged; identical prompts and 6 source groups).

## Scope Reviewed (all executable source, ~872 KB)

- Pass 1: server.py (1411 lines) + index.html (689 lines) — backend + UI shell
- Pass 2: structa-cascade.js (5711 lines) — main state machine
- Pass 3: contracts.js, validation.js, orchestrator.js, storage-manager.js, heartbeat.js, context-router.js, audio-engine.js, icons.js, processing-queue.js
- Pass 4: rabbit-adapter.js (3713 lines), r1-llm.js (2688 lines) — device/LLM layer
- Pass 5: camera-capture.js, voice-capture.js, diagnostic-suite.js, triangle-engine.js, impact-chain-engine.js
- Pass 6: figma-plugin/code.js, figma-plugin/manifest.json, harness/run_harness.py, harness/structa_validator.py, harness/semantic_judge.py

Not reviewed: binary assets (PDFs, JPGs, zip), docs, harness scenario JSONs (test data).

## Verified Findings (hy3:free; manually cross-checked against source with grep)

### CRITICAL / SECURITY

1. **File-disclosure fallback in do_GET** — server.py:1332 `return super().do_GET()`.
   Any unhandled path falls through to `SimpleHTTPRequestHandler`'s default file
   server rooted at the working directory, so files like `server.py` and `.env`
   are retrievable (e.g. GET /server.py). Fix: remove the fallback (404) or
   restrict static serving to a vetted directory.

2. **Rate limiter TOCTOU + spoofable key** — server.py:160-172 `claims_extract_allowed()`.
   Bucket read→filter→check→append is not atomic under `ThreadingHTTPServer`
   (server.py:1409), and the key is a client-supplied `deviceId` (line 163) —
   a client can randomize it to bypass the 10/min cap entirely. Fix: server-trusted
   identifier + per-key lock/atomic counter.

3. **XSS surface in structa-cascade.js:3023-3025** — `scroller.innerHTML` string
   branch escapes via `escapeHtml` (2846), but the object branch uses raw
   `content?.html` with NO escaping. User-controlled memory content (voice
   transcripts, capture descriptions) could render as HTML/JS in the WebView.
   Fix: sanitize or use textContent-based rendering.

4. **Plaintext persistence of sensitive data** — rabbit-adapter.js `persist()`
   (2068+) writes the full memory blob (voice transcripts, image preview_data,
   AI analyses) to localStorage; storage-manager.js r1Save/idbSave/lsSave also
   persist base64/JSON plaintext. Fix: use `window.creationStorage.secure` for
   sensitive fields or encrypt.

5. **Broad exception handler leaks internals** — server.py:1403-1404 (and
   1294-1295 in asset read): `except Exception as err: send_json(500, ...str(err))`.
   Fix: log server-side, return a generic message.

6. **No auth on any endpoint** — all /v1/* POST endpoints accept unauthenticated
   JSON (server.py:1334+) while the server binds 0.0.0.0 (server.py:1409).
   Confirm LAN-trusted-only or add a token.

7. **Security-by-obscurity debug gate** — server.py:1350-1355: `/v1/chain/digest_preview`
   only checks `debug=1`. Not real protection.

### CORRECTNESS BUGS (new in hy3 run)

8. **SHOW_PRIMED camera-close bug** — structa-cascade.js:1671-1677. `transition()`
   (1180-1190) invokes exit handlers BEFORE updating `currentState`, but the
   SHOW_PRIMED exit handler checks `currentState !== STATES.CAMERA_OPEN` —
   always true during exit, so the camera closes even when transitioning TO
   CAMERA_OPEN. CAMERA_OPEN's handler (1686-1691) correctly uses
   `transitionTargetState`. Breaks the SHOW_PRIMED → CAMERA_OPEN flow.

9. **ReferenceError in impact-chain** — impact-chain-engine.js:452 dispatches
   `structa-impact` with `produced: producedCounts`, but `producedCounts` is only
   defined in `handleStepResult` scope (561), not in `applyProduced` (385+) —
   strict mode (line 11) → ReferenceError after memory writes, so every successful
   step is treated as rejected.

10. **Data loss: capture/journal overwritten by rebuildLegacyViews** —
    rabbit-adapter.js: updateProjectFromCapture (2936-2964) pushes to
    `project.captures` and writeJournalEntry (3030-3056) pushes to
    `open_questions`/`backlog`, but `touchProjectMemory` (2145-2155) calls
    `rebuildLegacyViews()` (1783+) which rebuilds those arrays from nodes only
    (pm.captures at 1833, pm.backlog at 1788, pm.open_questions at 1885) — no
    matching nodes are created, so the pushed items silently vanish.

11. **postJSON ok-flag overwrite** — js/orchestrator.js:16:
    `Object.assign({ ok: false, status }, data || {})` lets error-body JSON
    containing `ok: true` override the failure flag.

12. **Heartbeat reads non-existent fields** — js/heartbeat.js:58,64,72-73 reads
    `project.backlog/open_questions/captures/insights`, but `createProject`
    (contracts.js:201+) defines `nodes/claims/answers/focuses` — monitoring logic
    is dead.

13. **Queue persistence mismatch** — js/processing-queue.js:75 writes raw
    `snapshot` to `storage.plain.write`, but load (165-166) calls
    `hydrateFrom(result?.value)` expecting a wrapper — native hydration never
    restores queued jobs.

14. **Stale voice annotation reuse** — js/camera-capture.js:1065 reads
    `voiceStripTranscript` in `capture()`; `stopVoiceStrip()` (939-970) never
    clears it (only `close()` at 1188 does), so a silent photo after a voice
    capture reuses the old transcript as annotation.

### ERROR HANDLING

15. **Voice-capture fallback never reached on bridge failure** — voice-capture.js
    `startListening`: if `CreationVoiceHandler.postMessage('start')` throws, catch
    logs and returns; browser SpeechRecognition fallback is skipped.

16. **Malformed Content-Length crashes handler** — server.py:1269
    `int(self.headers.get("Content-Length", "0"))` raises ValueError on
    non-numeric input; read_json doesn't catch it.

17. **diagnostic-suite finally shadows original error** — js/diagnostic-suite.js:948-965:
    `.finally()` rethrows restore failures (line 964), overriding the original
    diagnostic error and masking the real cause.

18. **Persist errors silently swallowed** — processing-queue.js:73 `catch (_) {}`
    on JSON.stringify/localStorage — queue persistence loss is silent.

19. **figma loadFonts swallows errors** — figma-plugin/code.js:34-38 `catch(_) {}`
    for all font loads; `createText` (69+) will throw later on unloaded fonts and
    `figma.closePlugin()` never runs, hanging the plugin.

20. **harness lacks network/file error handling** — run_harness.py:129-137
    `_http_json` urlopen has no try/except (crashes whole batch on unreachable
    LLM server); detect_lmstudio_model (161-165) same; load_scenarios (39-43)
    `path.read_text()` has no existence check.

### CODE QUALITY

21. **Unbounded rate-limit dict** — `CLAIMS_EXTRACT_BUCKETS` (server.py:9) never
    prunes keys; memory grows with distinct deviceIds.

22. **Duplicate function** — js/r1-llm.js `evaluateMilestone` declared twice
    verbatim (dead code / copy-paste).

23. **Unbounded memory arrays** — rabbit-adapter.js: MAX_CLAIMS=9999 unused (31);
    postPayload fallback `memory.messages.push` (2140) has no limit (unlike
    pushLimited elsewhere).

24. **Validation masked by contract defaults** — js/validation.js validators call
    `contracts.createX(raw)` first, which default required fields, so
    `isNonEmptyString` checks always pass — cannot reject missing required input.

25. **Dead onboarding code** — structa-cascade.js:508-518: freshWorkspaceState/
    getOnboardingStep/onboardingActive hardcode false/'complete', making large
    onboarding blocks unreachable.

26. **Approx. line references in passes 3-6** are model-computed indications; real
    code locations verified for the top findings above (8,9,10,11,12,13,14 + all
    server/cascade claims).

### TESTING GAPS

27. No unit test files exist in repo. Rate-limiter concurrency, XSS paths,
    exception-leak behavior, R1-bridge-failure fallback, capture/journal
    overwrite, SHOW_PRIMED transition, impact-chain ReferenceError, queue
    round-trip, and validation no-op checks have no automated coverage.

## What Looks Good

- Path traversal guard on `/__structa_asset/` is correct (server.py:1283-1291:
  resolve + parents check + is_file).
- Consistent API envelope ({ok, llm, ui, meta}) and defensive None/dict handling.
- escapeHtml applied on the primary innerHTML string branch; buildKnowFrameMarkup
  escapes individual fields (structa-cascade.js:2914+).
- `pushLimited()` caps runtime arrays; sanitizeTraceValue() omits sensitive keys.
- Centralized state machine, Object.freeze on public APIs, render throttling via
  requestAnimationFrame.
- Storage manager multi-tier fallback (R1 / IndexedDB / localStorage) with
  capability detection.
- Harness framework provides scenario validation + semantic judge; Figma plugin is
  small, self-contained, no secrets.

## Rollback

Read-only review; no source changes were made. To revert any local state:
`git checkout -- .` (only pre-existing untracked files remain; no tracked files
were modified).

## Repro

- Repo: `git fetch origin && git pull origin main` → HEAD e7d7c6ce94f7cbe06daa5a6e6ef28c7f62b1ab5d (verified with `git rev-parse HEAD`).
- Credentials: `resolve_nous_runtime_credentials()` from `hermes_cli.auth` → base_url https://inference-api.nousresearch.com/v1, source invoke_jwt.
- Model availability: GET /models (tencent/hy3:free present, pricing 0/0) + POST chat/completions probe (200, stop, PROBE_OK). See probe output in MODEL_SWAP_NOTE.md.
- Review calls: 6 POSTs with model tencent/hy3:free, temperature 0.3, max_tokens 32000 (first run at max_tokens 6000 returned null content — evidence preserved). Pass 1 streamed (SSE) due to origin timeout; passes 2-6 non-streaming with retries.
- Raw responses: passN_hy3_raw_api_response.json (+ _max6000 variants, passN_hy3_reasoning*.txt).
- Grounding (grep-verified): file disclosure (server.py:1332 super().do_GET), rate limiter (9/160-172/1409), XSS (structa-cascade.js:3023-3025/2846), plaintext persist (rabbit-adapter.js:2068), exception leak (server.py:1294-1295/1403-1404), digest gate (1350-1355), SHOW_PRIMED exit (1671-1677 vs 1180-1190), producedCounts (impact-chain-engine.js:452 vs 561), rebuildLegacyViews overwrite (rabbit-adapter.js:2145-2155/1783-1890/2936-2964/3030-3056), postJSON (orchestrator.js:16), heartbeat fields (heartbeat.js:58-73 vs contracts.js:201+), queue mismatch (processing-queue.js:75/165-166), voice annotation (camera-capture.js:1065/939-970/1188), Content-Length (server.py:1269), finally shadow (diagnostic-suite.js:948-965), figma loadFonts (code.js:34-38), harness (run_harness.py:39-43/129-137/161-165), semantic_judge grounding (semantic_judge.py:58-61).

## Fallback

The original nemotron-3.5-lightning:free run remains intact in this folder
(passN_<group>.md + passN_raw_api_response.json) and its findings (rate-limiter
race, XSS, exception leak, no auth, voice fallback, etc.) are consistent with
the hy3:free results above.
