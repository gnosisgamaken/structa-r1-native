# structa queue audit

This audit captures every user-facing async orchestration path before the queued-processing refactor.

## current async entry points

| file | call | current trigger | current behavior | target tier |
| --- | --- | --- | --- | --- |
| `js/voice-capture.js` | `window.StructaLLM.processVoice()` | `stopListening()` after `hold ptt` release | transcript is stored immediately, then voice interpretation starts in the same feature path | `P1` |
| `js/voice-capture.js` | `window.StructaLLM.titleProject()` | onboarding answer / first meaningful voice note | project naming runs as a follow-up async request | `P2` |
| `js/camera-capture.js` | `window.StructaLLM.processImage()` | capture stored, then local drain loop | preview lands instantly, analysis is backgrounded by a local retry scheduler | `P1` |
| `js/triangle-engine.js` | `window.StructaOrchestrator.synthesizeTriangle(..., executePreparedLLM)` | triangle angle submitted | overlay waits on direct synthesis promise | `P0` |
| `js/impact-chain-engine.js` | `window.StructaOrchestrator.runChainStep(..., executePreparedLLM)` | autonomous beat / discovery / clarify / evaluate | chain calls run directly from beat callbacks | `P3` |
| `js/r1-llm.js` | `speakMilestone()` | milestone events | direct tts side-channel, already cooled down | bypass |

## current bottlenecks

- feature modules each schedule their own async work
- image analysis uses a local drain loop separate from voice and chain
- chain work only yields to `StructaLLM.pendingHighPriorityCount`, not to other feature queues
- log ops cannot show a true serialized work queue because there is no shared queue snapshot
- app restart can preserve pending capture state, but not one shared orchestrator queue

## refactor goal

Move all LLM / vision / synthesis feature work onto one persisted queue:

- instant layer:
  - capture / transcript / navigation / animation finish in one frame
  - memory gets the raw artifact immediately
- queued layer:
  - one serialized worker
  - persisted pending jobs
  - visible queue state
  - blocked jobs surface back into `now`

