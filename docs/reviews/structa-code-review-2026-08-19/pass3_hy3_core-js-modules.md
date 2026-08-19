## Summary
The codebase is well-modularized with clear separation of contracts, validation, orchestration, and storage, but contains several correctness bugs—including improper HTTP error handling, a project-schema mismatch in the heartbeat, and a queue persistence mismatch—that should be fixed before production. Validation is also weakened by contract defaults that mask missing required fields.

## Critical Issues (Must Fix)
- [js/orchestrator.js:16] Issue: In `postJSON`, `Object.assign({ ok: false, status: response.status }, data || {})` lets properties from `data` overwrite the `ok: false` flag. If a server error response (e.g., 500) returns JSON containing `ok: true`, the caller will treat the failed request as successful. Why it matters: This breaks error detection and can cause the app to process error payloads as valid LLM/prep responses. Suggested fix: Use `Object.assign({}, data, { ok: false, status: response.status })` so the error flag is enforced.

- [js/heartbeat.js:47,53,59,61,62] Issue: `beat()` reads `project.backlog`, `project.open_questions`, `project.captures`, and `project.insights`, but `createProject` in contracts.js defines no such fields (it uses `nodes`, `claims`, `answers`, `focuses`, etc.). Why it matters: The stale-task filter, question count, and LLM context string are always empty, making the heartbeat’s monitoring logic dead code. Suggested fix: Map to the actual contract shape (e.g., filter `project.nodes` by type, or use `project.focuses`) or update the contract if a different shape is intended.

- [js/processing-queue.js:63 (persist), js/processing-queue.js:139 (load)] Issue: `persist()` calls `window.StructaNative.storage.plain.write(STORAGE_KEY, snapshot)` with the raw snapshot object, but `load()` later calls `hydrateFrom(result?.value)`, expecting a `{value: ...}` wrapper. Why it matters: Native storage hydration never restores queued jobs (falls back to localStorage only), causing potential loss of pending/blocked jobs after a reload. Suggested fix: Write `{value: snapshot}` or change `load()` to call `hydrateFrom(result)`.

## Security Issues
- [js/storage-manager.js:45 (r1Save), js/storage-manager.js (idbSave/lsSave)] Issue: Voice transcripts, image assets, and full project state are persisted in plaintext to R1 storage, IndexedDB, and localStorage (base64 or JSON) without encryption. Why it matters: On a shared or compromised device, sensitive user-generated content is directly readable. Suggested fix: Encrypt payloads before writing (e.g., using Web Crypto) or document the risk if the environment guarantees isolated secure storage.

## Error Handling Issues
- [js/processing-queue.js (cancel function)] Issue: `cancel()` sets `inFlight.error = 'cancelled'` for an in-flight job but does not clear `activeTimer` or call `finalizeActive()`. The job’s handler continues, the timeout still fires, and `maybeProcess()` runs again on settlement. Why it matters: Cancellation is ineffective for running jobs, and the queue may emit misleading “blocked/cancelled” events while the job still completes. Suggested fix: On cancel of `inFlight`, clear the timer, mark a local `settled` flag, and call `finalizeActive()`.

## Code Quality Issues
- [js/validation.js (validateEnvelope, validateCaptureBundle, validateJournalEntry, validateNode, validateProject)] Issue: These validators call `contracts.createX(raw)` and then check `isNonEmptyString` on fields like `project_code`, `entry_id`, `name`, `title`, and `approval_mode`—but the contract functions default all of those fields, so the checks always pass. Why it matters: The validation layer cannot reject empty/missing required input; it only validates optional fields. Suggested fix: Validate the raw `input` object before defaults are applied, or remove defaults for required fields.

- [js/contracts.js (createJournalEntry, createNode, createClaim, createAnswerNode)] Issue: User text (`title`, `body`, `text`) is forced to lowercase via `.toLowerCase()` before storage. Why it matters: Original casing is destroyed, which may be unexpected for user content and can harm readability or downstream matching. Suggested fix: Preserve original case and normalize only when needed for comparison.

- [js/contracts.js (legalStateTransition)] Issue: `plateau`, `resolved`, `dismissed`, `blocked`, and `superseded` are defined as terminal (only self-transitions allowed). Why it matters: If the product intends to allow reactivation (e.g., `plateau` → `active`), this will incorrectly reject valid LLM-proposed transitions. Suggested fix: Confirm intended state machine; if reactivation is allowed, add the permitted transitions.

- [js/context-router.js (allVerbs)] Issue: `allVerbs` is built by spreading `contracts.allowedVerbs` plus `coreVerbs` and `extendedVerbs`, but `contracts.allowedVerbs` already contains both lists, causing duplication. Why it matters: Harmless but indicates dead/misleading code. Suggested fix: Use `contracts.allowedVerbs` directly.

## Testing Gaps
- No tests for `postJSON` error path where a non-OK HTTP response includes `{"ok": true}` in its JSON body (would expose the overwrite bug).
- No tests for `heartbeat.js` using a contract-compliant project object (would reveal the missing `backlog`/`open_questions` fields).
- No tests for `processing-queue.js` native-storage round-trip (would catch the `result?.value` mismatch).
- No tests for `cancel()` called on an in-flight job (would show the job still completes).
- No tests for validation functions with completely empty input (would reveal the no-op required-field checks).
- No tests for `validateChainOutput`/`validateTriangleOutput` with orphaned, inactive, or weak evidence references.
- No tests for rapid `makeEntryId` calls with the same kind within the same second (counter/uniqueness edge case).

## What Looks Good
- Strong modular separation: contracts, validation, orchestration, storage, audio, and queue are isolated via IIFEs and frozen `window` namespaces.
- `Object.freeze` is used consistently for constant enums and public APIs, preventing accidental mutation.
- Storage manager implements multi-tier fallback with capability detection (R1, IndexedDB, localStorage) and emergency snapshots.
- Processing queue includes priority ordering, timeouts, persistence, and event emission with safe `try/catch` guards.
- Audio engine is slot-driven with procedural fallbacks and per-feedback suppression, avoiding UI sound spam.
- Context router uses synonym maps and canonicalization for flexible verb/target inference without external dependencies.