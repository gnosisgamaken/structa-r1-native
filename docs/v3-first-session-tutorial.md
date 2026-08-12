# STRUCTA V3 first-session tutorial

Status: specified, intentionally not enabled until the owner device run passes `B00`–`B04` and `B07` in `v3-device-feedback-loop.md`.

The tutorial is a guided real project, not a slide carousel or fake demo. It should take 60–90 seconds, remain skippable, and be replayable from project settings. Each step uses the production interaction that it teaches.

## Promise

At the end, the user has a small but genuine project map, one classified reference, and one explicit human-approved decision. The closing screen shows what changed, what still needs approval, and the next highest-leverage move.

## Flow

1. **TELL · frame it**
   - Prompt: `Hold PTT. Describe what you want to make in one sentence.`
   - Success: a non-empty transcript creates an outcome and initial project frame.
   - Empty release creates nothing and keeps the prompt visible.

2. **KNOW · see the map**
   - Reveal only the newly created branches and highlight their status spine.
   - Prompt: `This is your project map. Wheel to inspect; Side returns.`
   - Success: the user focuses at least one branch.

3. **SHOW · add a reference**
   - Prompt: `Tap the camera control, then capture a sketch, space, material, object, or reference.`
   - Side may focus or prime the empty-SHOW camera control, but the tutorial waits for a direct touch before requesting the lens.
   - After save-first capture, ask for the truth role only when classification is uncertain: existing condition, working artifact, or external inspiration.
   - Success: the original is stored before analysis and the reference is linked to a branch.

4. **NOW · make one decision**
   - Present the highest-leverage decision produced from the real map.
   - Prompt: `Choose an option, or hold PTT for your own answer.`
   - Success: only an explicit user action locks the decision; leaving without choosing changes nothing.

5. **Receipt**
   - Show exactly three lines: `changed`, `needs you`, and `next`.
   - Offer `continue project` as the primary action and `replay tutorial` only from settings.

## Interaction rules

- Never explain all four surfaces before the user touches one.
- Never insert tutorial-only project facts or model output.
- Do not speak automatically or create Rabbit Hole entries.
- Preserve the user's original words, image, decisions, and event history.
- If vision or the model is unavailable, complete the tutorial with the saved capture and a visible pending-analysis state.
- If the user already has a project map, teach against that project instead of creating another one.

## Proof before enabling

- Ten first-time users complete the flow without facilitator intervention.
- At least eight reach a correctable map and understand that NOW requires human approval.
- Median completion time is under 90 seconds.
- Empty PTT, in-app camera cancel, offline capture, and delayed vision responses do not trap the tutorial.
- RabbitOS system Back exits the creation. Relaunch resumes the tutorial and preserves every completed step; the tutorial never claims to intercept Back.
- The same release build passes the physical device proof and 20-capture visual matrix.

## Minimal analytics

Keep tutorial analytics local until the user explicitly exports a proof. Record only step IDs, completion/skip state, elapsed milliseconds, and failure codes—never transcripts, image data, prompts, or project copy.
