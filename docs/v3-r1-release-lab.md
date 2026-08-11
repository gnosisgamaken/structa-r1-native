# STRUCTA V3 R1 release lab

Run this on physical Rabbit R1 hardware before calling the silent visual relay production-ready. Browser diagnostics are necessary but cannot prove speaker, journal, callback, camera, or memory behavior on the device.

## Build identity

- UI build: `ui-20260811-structa-v3`
- Vision schema: `structa.vision.v1`
- Device / OS:
- Tester / date:

## Twenty-capture matrix

| Set | Captures | Required examples |
|---|---:|---|
| Sketches and diagrams | 7 | Hand sketch, annotated plan, flow diagram, low-contrast pencil, rotated page, dense notes, deliberately ambiguous sketch |
| Spaces | 7 | Room overview, doorway/circulation, exterior, low light, reflective surface, partial obstruction, deliberately unresolvable scale |
| Materials and objects | 6 | Material close-up, object assembly, damaged condition, multiple objects, fine texture, deliberately ambiguous material |

For every capture record:

- Capture appears in SHOW before analysis completes.
- Original remains available after Back, force close, and offline transition.
- No Rabbit speech.
- No Rabbit Hole journal entry.
- Response contains the exact outstanding `vision_id` and valid schema.
- Response is attached to the correct capture and project.
- Observation, interpretation, implication, and uncertainty remain distinct.
- Sketch is not treated as accepted fact; external reference is not treated as project evidence.
- Timeout, invalid JSON, and mismatch remain degraded/non-blocking.

## Fault injections

1. Switch projects while one image is analyzing. The result must stay with its originating project or be rejected as stale.
2. Capture three images quickly. Each callback must match one request; no first-text-wins behavior.
3. Disable connectivity after capture. The image must remain usable and the queue must recover without user intervention.
4. Return prose before JSON and unrelated bridge text. Only the matching validated envelope may resolve the request.
5. Force `status: insufficient`. STRUCTA must queue uncertainty and withhold dependent decisions without blocking other branches.
6. Resolve one uncertainty by each action: confirm, correct, dismiss. Back must resolve none.

## Release threshold

- At least 18 of 20 captures return a valid, correctly matched silent envelope.
- Zero unsolicited speech.
- Zero journal entries.
- Zero cross-capture or cross-project matches.
- Zero lost originals.
- All six fault injections pass.

Any speech, journal write, mismatched callback, or lost original is an automatic release blocker regardless of the aggregate score.
