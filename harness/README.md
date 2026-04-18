# Structa Local Text Harness

This is the fastest way to test Structa harness quality without UI.

## What it does

- loads scenario cards from JSON
- builds compact Structa prompts
- runs a provider (`mock` or `openai`)
- validates slot compliance in strict + lenient mode
- scores semantic quality
- writes JSONL + markdown reports

## Files

- `run_harness.py` — batch runner
- `structa_validator.py` — strict / lenient slot validator
- `semantic_judge.py` — lightweight semantic quality scorer
- `scenarios/batch_v1.json` — first 12-scenario batch
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

## Good next experiments

1. duplicate `batch_v1.json` into larger batches
2. compare 3 prompt variants with the same scenarios
3. tighten enum fields:
   - `SOURCE_TRACE`: `UNKNOWN | LOCAL_ONLY | EXPLICIT_ONLY`
   - `ACTION_STATE`: `proposed | staged | approved | executed | rolled_back`
4. add failure tags for:
   - generic compliance
   - hidden mutation risk
   - weak first-structure proposals
   - weak handoff cards

## Why this matters

This runner tests the thing that matters first:

**does Structa produce good project outcomes under repeated usage?**

Not:
- whether the UI renders
- whether the Rabbit viewport feels right
- whether camera / PTT sequencing is polished

Those matter later.
This harness is the fastest route to prompt + validator truth.