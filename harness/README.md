# Structa Local Text Harness

This is the fastest way to test Structa harness quality without UI.

## What it does

- loads scenario cards from JSON
- builds compact Structa prompts
- runs a provider (`mock`, `openai`, or `lmstudio`)
- validates slot compliance in strict + lenient mode
- scores semantic quality
- writes JSONL + markdown reports

## Files

- `run_harness.py` — batch runner
- `structa_validator.py` — strict / lenient slot validator
- `semantic_judge.py` — lightweight semantic quality scorer
- `scenarios/batch_v1.json` — first 12-scenario batch
- `scenarios/batch_v2_local_50.json` — richer 50-scenario local batch with voice/image/triangle/comment coverage
- `outputs/` — generated run reports

## Quick start

### Dry run

```bash
cd /Users/pedro/company/PlayGranada/Operations/structa-r1-native/harness
python3 run_harness.py --provider mock
```

### Real OpenAI run

```bash
cd /Users/pedro/company/PlayGranada/Operations/structa-r1-native/harness
export OPENAI_API_KEY=...
python3 run_harness.py --provider openai --model gpt-4.1-mini
```

### Real LM Studio local run

1. Open LM Studio
2. Load a local model
3. Start the local server on `127.0.0.1:1234`
4. Run:

```bash
cd /Users/pedro/company/PlayGranada/Operations/structa-r1-native/harness
python3 run_harness.py --provider lmstudio --model auto --scenarios scenarios/batch_v2_local_50.json
```

If you want a fixed model:

```bash
python3 run_harness.py --provider lmstudio --model "Qwen3.5-9B-Q4_K_M" --scenarios scenarios/batch_v2_local_50.json
```

## Recommended local model

First pick:
- `Qwen3.5-9B-Q4_K_M`

Why:
- good balance of speed and slot obedience
- better candidate for repeated 50-scenario structured testing than chatty models

Second comparison candidate:
- `Harmonic-Hermes-9B-Q8_0`

Use Harmonic-Hermes as a contrast run, not the baseline.

## Good next experiments

1. compare 3 prompt variants with the same 50 scenarios
2. tighten enum fields:
   - `SOURCE_TRACE`: `UNKNOWN | LOCAL_ONLY | EXPLICIT_ONLY`
   - `ACTION_STATE`: `proposed | staged | approved | executed | rolled_back`
3. add failure tags for:
   - generic compliance
   - hidden mutation risk
   - weak first-structure proposals
   - weak handoff cards
4. compare:
   - `Qwen3.5-9B-Q4_K_M`
   - `Harmonic-Hermes-9B-Q8_0`
   - `NVIDIA-Nemotron-3-Nano-4B-Q4_K_M` (speed sanity-check)

## Scenario shape

The local batch can now include:
- `voice_transcript`
- `image_descriptions`
- `asset_comments`
- `triangle.point_a`
- `triangle.point_b`
- `triangle.angle`

That means you can simulate:
- voice-only use
- image + voice context
- comment refinement on assets
- triangle synthesis / knowledge-building
- handoff / withdrawal after mixed inputs

## Why this matters

This runner tests the thing that matters first:

**does Structa produce good project outcomes under repeated usage?**

Not:
- whether the UI renders
- whether the Rabbit viewport feels right
- whether camera / PTT sequencing is polished

Those matter later.
This harness is the fastest route to prompt + validator truth.
