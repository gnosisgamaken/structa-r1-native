## Summary
The V2 rewrite successfully centralizes UI flow into a single state machine with strong caching and defensive external calls, but contains a critical state-exit bug that breaks camera priming, an unhandled exception risk in the capture flow, and large blocks of unreachable onboarding dead code that obscure logic.

## Critical Issues (Must Fix)
- [structa-cascade.js: stateExitHandlers[STATES.SHOW_PRIMED]] Issue: The exit handler checks `if (currentState !== STATES.CAMERA_OPEN)` to decide whether to close the camera, but `transition()` invokes exit handlers *before* updating `currentState`. Thus `currentState` is still `SHOW_PRIMED` during exit, causing the camera to always close—even when transitioning *to* `CAMERA_OPEN`. Why it matters: Breaks the SHOW_PRIMED → CAMERA_OPEN flow; the camera closes immediately after opening, leaving the UI in a broken state. Suggested fix: Use `transitionTargetState !== STATES.CAMERA_OPEN` (matching the pattern in `stateExitHandlers[STATES.CAMERA_OPEN]`).

## Security Issues
- [structa-cascade.js: drawKnowScrollFrame] Issue: When `content` is an object, `content.html` is assigned directly to `scroller.innerHTML` without sanitization. While `buildKnowFrameMarkup` currently escapes individual fields, this creates a fragile XSS surface if any future field or `meta` property is missed. Why it matters: User-controlled memory content (voice transcripts, capture descriptions) could execute HTML/JS in the WebView. Suggested fix: Sanitize `content.html` with a strict allowlist parser, or construct DOM nodes via `textContent` instead of raw `innerHTML`.
- [structa-cascade.js: image() / drawRasterFrame] Issue: `href` from `getCaptureImageHref()` is set directly on SVG `<image>` without scheme validation. Why it matters: If native memory returns a `javascript:` or `data:text/html` URI, it could lead to unexpected behavior or script execution in some WebView contexts. Suggested fix: Validate that `href` starts with `data:image`, `blob:`, or `http(s)://` before setting the attribute.

## Error Handling Issues
- [structa-cascade.js: stateEnterHandlers[STATES.CAMERA_CAPTURE]] Issue: `window.StructaCamera?.capture?.()` is called synchronously before the `setTimeout` that auto-transitions back to browse/home. If `capture()` throws, the subsequent `setTimeout` is never scheduled. Why it matters: The state machine becomes permanently stuck in `CAMERA_CAPTURE` with no recovery path. Suggested fix: Wrap `capture()` in a try/catch or schedule the transition timeout before invoking capture.
- [structa-cascade.js: drawKnowScrollFrame] Issue: Scroll restoration relies on `setTimeout(..., 0)` that closes over a local `scroller` element. If a re-render occurs before the timeout fires, the timeout sets `scrollTop` on a detached node, and the newly rendered node may not restore scroll. Why it matters: Scroll position in KNOW detail can jump or reset unexpectedly during rapid updates. Suggested fix: Restore scroll inside a `requestAnimationFrame` after confirming the element is connected, or manage scroll state explicitly in `renderNow`.

## Code Quality Issues
- [structa-cascade.js: onboarding stubs (onboardingActive, getOnboardingStep, freshWorkspaceState)] Issue: These functions hardcode return values (`false`, `'complete'`), making large blocks of onboarding/tutorial logic unreachable dead code. Why it matters: Increases cognitive load and bundle size; if onboarding is re-enabled, `selectIndex` and `handleScrollDirection` will bypass `onboardingAllowedCardIds()` and break. Suggested fix: Remove dead code or wire up real onboarding state from `native.getUIState()`.
- [structa-cascade.js: renderNow] Issue: The entire SVG is cleared and rebuilt every render (`while (svg.firstChild) svg.removeChild(svg.firstChild)`), re-attaching all event listeners and recreating `foreignObject` nodes. Why it matters: Inefficient for frequent renders and causes scroll/state churn. Suggested fix: Diff and update only changed nodes, or use a lightweight virtual DOM.
- [structa-cascade.js: stateExitHandlers inconsistency] Issue: `SHOW_PRIMED` exit handler uses `currentState` while `CAMERA_OPEN` uses `transitionTargetState`. Why it matters: Inconsistent patterns lead to the critical bug above and make the state machine hard to reason about. Suggested fix: Standardize on `transitionTargetState` for all exit handlers.

## Testing Gaps
- Onboarding flows (steps 1–4, tutorial skip, fallback options) are entirely untested because `onboardingActive()` is stubbed to `false`.
- Camera capture failure paths: `structa-capture-failed` listener and synchronous throw in `capture()` are not exercised.
- Rapid scrolling in `KNOW_DETAIL` before `knowBodyMaxScroll` is measured (item switching vs scroll ambiguity).
- Project switcher edge cases: 0 projects (fresh workspace), 1 project (archive logic), and `activateSelectedProject` with missing `project_id`.
- Voice processing timeout edge case: `VOICE_PROCESSING` auto-returns after 300ms; if `voiceReturnState` is invalid or stale, transition may go to wrong state.

## What Looks Good
- Defensive programming with optional chaining (`?.`) on all external `window.Structa*` APIs prevents crashes from missing plugins.
- Centralized state machine (`transition`, enter/exit handlers) cleanly replaces scattered booleans.
- `escapeHtml` is correctly applied to user text in `buildKnowFrameMarkup` and the string-path of `drawKnowScrollFrame`.
- Render throttling via `scheduleRender()` + `requestAnimationFrame` prevents layout thrash.
- Public API frozen with `Object.freeze` (`StructaUIRuntime`, `StructaPanel`) to avoid accidental mutation.
- Robust caching (`dataCacheVersion`, `cachedMemory`, etc.) minimizes expensive native bridge calls.