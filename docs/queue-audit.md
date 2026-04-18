# structa queue audit

This audit reflects the current post-refactor state.

## queued async entry points

| file | call | trigger | tier | instant write before queue |
| --- | --- | --- | --- | --- |
| `js/voice-capture.js` | `/v1/voice/interpret` via `voice-interpret` job | `hold ptt` release on normal voice input | `P1` | yes — transcript stored as voice entry first |
| `js/voice-capture.js` | `/v1/project/title` via `project-title` job | onboarding answer / first naming pass | `P2` | yes — project exists immediately, title follows |
| `js/voice-capture.js` | `/v1/thread/refine` via `thread-refine` job | content comment appended | `P2` | yes — raw comment appended to thread first |
| `js/camera-capture.js` | `/v1/image/analyze` via `image-analyze` job | capture stored / queue drain | `P1` | yes — frame + preview stored first |
| `js/triangle-engine.js` | `/v1/triangle/synthesize` via `triangle-synthesize` job | triangle angle release | `P0` | yes — overlay state updates first |
| `js/impact-chain-engine.js` | `/v1/chain/step` via `chain-step` job | autonomous beat | `P3` | yes — chain state advances without blocking gesture paths |
| `js/r1-llm.js` | `speakMilestone()` | milestone events | bypass | n/a |

## gesture-path result

There are no intentional synchronous LLM / vision calls on these user gesture paths:

- `sideClick`
- `double-side`
- `longPressStart`
- `longPressEnd`
- `scrollUp`
- `scrollDown`
- `devicemotion`
- `visibilitychange`

Every one of those paths now favors:

1. immediate UI feedback
2. immediate local memory write when applicable
3. queued async enrichment after the frame returns

## persistence / recovery

- queue state persists to `structa.queue.v1`
- pending jobs restore on boot
- stale `inFlight` jobs become `blocked`
- blocked jobs surface into `now` as retry / skip blockers

## known limits

- device verification is still required for final publish confidence
- queue persistence is local-first; there is no server-side retry ledger
