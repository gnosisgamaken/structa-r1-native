# Structa Deployment Readiness Audit

Date: 2026-04-12

## Sync status
- Repo is synced with GitHub origin/main.
- Replit config is aligned with the current static-site workflow:
  - `python3 -m http.server 5000`
  - `deploymentTarget = "static"`
  - `publicDir = "."`
- The app has no JS syntax errors in the current files.

## What the app currently is
Structa is a static, browser-native instrument panel for Rabbit R1-style interaction.

Core pieces:
- 2x2 primary node panel
- hidden contract/validator depth
- capture tray for voice + camera
- log drawer for audit + capture entry point
- strict routing/validation layer in JS

## Usability definition for this build
The app should feel like a calm, premium control surface.

User goals:
1. Understand the current state at a glance.
2. Capture voice or camera input with minimal friction.
3. Route intent through a small set of explicit verbs.
4. Keep approvals visible for mutating/export actions.
5. Reveal deeper state only when needed.

Usability rules:
- The main 2x2 panel must stay visually dominant.
- Capture actions must be reachable in one tap.
- Mutating verbs must remain approval-gated.
- Hidden depth must stay hidden by default.
- The log drawer should stay quiet, legible, and easy to toggle.
- No browser-app chrome feel.
- No debug artifacts in the final deployment build.

## Current audit findings
### Good
- Strong visual identity.
- Clear four-node structure.
- Capture tray is usable and readable.
- Log drawer is more premium than before.
- Validation/router/capture pipeline is already in place.

### Needs attention before deployment
- Verify there are no leftover debug overlays or annotation artifacts in the final deployed environment.
- Confirm the CTA hierarchy still reads clearly on the target device size.
- Test the drawer toggle and capture tray on touch hardware, not just desktop browser.
- Check that the hidden nodes remain discoverable but not noisy.
- Confirm camera/voice fallbacks behave gracefully when hardware is missing.

## Deployment readiness checklist
- [ ] Test in a clean browser profile
- [ ] Test on the actual target device size
- [ ] Validate voice and camera permissions flows
- [ ] Confirm log drawer and capture tray interactions
- [ ] Confirm no console errors after basic interaction flows
- [ ] Confirm static deployment serves `index.html` correctly
- [ ] Confirm GitHub and Replit stay in sync after the next change

## Recommendation
The codebase is structurally ready for deployment as a static app, but it still benefits from one more pass of touch-device QA and final visual trimming before calling it finished.
