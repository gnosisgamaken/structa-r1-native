## Summary
The adapter provides a robust offline‑first project memory with good tracing and storage health checks, but it contains a critical data‑loss bug where captures and journal entries are overwritten by legacy view rebuilds, and it persists sensitive user data in plaintext localStorage.

## Critical Issues (Must Fix)
- [File: js/rabbit-adapter.js:1050] `updateProjectFromCapture` (invoked by `storeCaptureBundle`): pushes a capture into `project.captures` inside `touchProjectMemory`, but `touchProjectMemory` immediately calls `rebuildLegacyViews()` which rebuilds `pm.captures` solely from nodes of type `'capture'`. Because no such node is created, the capture vanishes from project memory after the rebuild. Fix: create a `'capture'` node via `addNode` instead of manually pushing to the legacy array, or rebuild legacy views before the mutator push.
- [File: js/rabbit-adapter.js:1150] `writeJournalEntry`: its mutator pushes to `project.open_questions` and `project.backlog`, but `rebuildLegacyViews()` overwrites both arrays from nodes. Journal‑derived questions/backlog items are silently lost. Fix: create corresponding `question`/`task` nodes, or update legacy arrays after `rebuildLegacyViews` (or skip rebuild for those fields).

## Security Issues
- [File: js/rabbit-adapter.js:730] `persist()`: writes the entire `memory` blob (including voice transcripts, image `preview_data`, AI analyses) as plaintext JSON to `window.localStorage` via `setItem(cacheKey, JSON.stringify(blob))`. Why matters: localStorage is accessible to any XSS payload, exposing private user content and potentially large base64 image data. Suggested fix: store sensitive fields only in `window.creationStorage.secure` (already used for snapshots) or encrypt before localStorage write; avoid persisting raw image data in plaintext.

## Error Handling Issues
- [File: js/rabbit-adapter.js:760] `hydrateAsync()`: after `await window.StructaStorage.load()`, it does `Object.assign(memory, data.memory)` when `storedTime > localTime` without validating that `data.memory` contains required arrays (`projects`, `uiState`, etc.). A malformed snapshot could cause downstream crashes in `ensureProjectRegistry`. Suggested fix: shape‑check and default missing keys before assign, or wrap in stricter validation.
- [File: js/r1-llm.js:430] `bridgeSend` / `window.onPluginMessage`: `extractResponseText(data)` is called directly in the message handler without a try/catch. A malformed `data` object could throw and break the bridge listener. Suggested fix: wrap `extractResponseText` and `extractCorrelationId` in try/catch and trace failures.

## Code Quality Issues
- [File: js/r1-llm.js:250] `evaluateMilestone`: the function is declared twice verbatim in the same scope (dead code / copy‑paste). Why matters: maintenance confusion and larger bundle. Suggested fix: delete the duplicate definition.
- [File: js/rabbit-adapter.js:30] `MAX_CLAIMS = 9999` is defined but never used; `addClaimsToProject` unshifts into `project.claims` without any cap, causing unbounded memory growth. Suggested fix: slice claims to a limit or use the constant.
- [File: js/rabbit-adapter.js:780] `postPayload()`: when `PluginMessageHandler` is unavailable, it does `memory.messages.push(payload)` with no limit (unlike other arrays that use `pushLimited`). Why matters: `memory.messages` grows forever. Suggested fix: use `pushLimited(memory.messages, payload, MAX_MEMORY_ITEMS)`.
- [File: js/rabbit-adapter.js:420] `ensureProjectRegistry()`: called on every `touchProjectMemory`, and for each project it runs `repairEvidenceIntegrity` and `validateEvidenceIntegrity` with `silent:false`, emitting trace events. Why matters: severe performance degradation and trace spam on every mutation. Suggested fix: only run repairs/migrations during initial hydrate or explicit upgrade, not on every touch.
- [File: js/rabbit-adapter.js:600] `rebuildLegacyViews()`: called after every mutation and performs heavy array mapping; combined with the above, causes O(n) work per operation. Lower priority but should be revisited for throttle/batch updates.

## Testing Gaps
- No tests for v2→v3 migration or `schema_version` bump logic in `ensureProjectRegistry`.
- No tests covering the capture/journal legacy overwrite bug (`storeCaptureBundle`/`writeJournalEntry` vs `rebuildLegacyViews`).
- No unit tests for `decodeStorageValue`/`encodeStorageValue` round‑trip with Unicode, emoji, and corrupted base64.
- No tests that would have caught the duplicate `evaluateMilestone` function.
- No tests for voice‑call suppression metrics (`recordVoiceCall` violations).
- Edge cases for `restoreSnapshot`/`restoreLastFlushSnapshot` with partial or missing memory keys are untested.

## What Looks Good
- `pushLimited()` helper consistently caps runtime events, logs, trace, and probe arrays.
- `sanitizeTraceValue()` explicitly omits sensitive keys (`imageBase64`, `data`, `blob`, `prompt`) to prevent secret leakage in traces.
- `withOperationPolicy()` stack in r1-llm.js cleanly manages speech/quiet modes.
- `withTimeout()` utility ensures bridge requests never hang indefinitely.
- `Object.freeze()` used on exported APIs (`StructaNative`, `StructaLLM`) to prevent accidental mutation.
- `probeStorageHealth()` actively validates plain/secure storage tiers with varied payloads (emoji, 32kb blob).
- `repairEvidenceIntegrity()` and `validateEvidenceIntegrity()` provide self‑healing for orphaned claim references.