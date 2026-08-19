# MODEL SWAP NOTE — hy3:free re-review (Nous portal)

Date: 2026-08-19
Author: builder profile (Hermes Agent)

## Why this note exists

The original structa review ran with `nvidia/nemotron-3.5-lightning:free` because
`tencent/hy3:free` appeared unavailable on **OpenRouter** (404 + paid-slug 402).
The conductor verified that `tencent/hy3:free` IS available on the **Nous portal**
at zero price and requested a re-run with the exact same repo, commit, source
groups, and pass structure.

This re-run was executed. The hy3:free findings are now the **primary report**;
the nemotron run stands as the documented fallback (original files preserved).

## Model availability proof (Nous portal)

- Endpoint resolved via `resolve_nous_runtime_credentials()` from
  `hermes_cli.auth` (Hermes checkout `/Users/pedro/.hermes/hermes-agent`):
  - provider: `nous`
  - base_url: `https://inference-api.nousresearch.com/v1`
  - source: `invoke_jwt` (inference-scoped JWT)
- Catalog check `GET /models`: 370 models; `tencent/hy3:free` present with
  pricing `{prompt: 0, completion: 0, input_cache_read: 0}`, context 262144.
- Direct probe `POST /chat/completions` with `tencent/hy3:free`:
  - status 200, `finish_reason: stop`, content `PROBE_OK`.

## Parameter adaptation (documented deviation)

The requested parameters were `max_tokens 6000, temperature 0.3`. A full run with
exactly `max_tokens 6000` was executed first — all six passes returned status 200
but `content` was **null** on every pass (`finish_reason: length`, all 6000
completion tokens consumed by the `reasoning` field). hy3 is a reasoning-heavy
model on the Nous endpoint; the final formatted findings were never emitted.

Evidence of the max_tokens-6000 run is preserved:
`passN_hy3_raw_api_response_max6000.json` + `passN_hy3_reasoning.txt` (the
reasoning shows substantive analysis but no final content).

The review was therefore re-run with `max_tokens 32000` (temperature still 0.3,
identical prompts, identical 6 source groups, same model slug) so the model could
finish reasoning AND emit the structured findings. Every final pass returned
`finish_reason: stop` with real content. This is the only deviation; it was
necessary for a usable review and is fully evidenced.

## Transport note

Three passes initially hit `HTTP 502`/`524` (Cloudflare origin read timeout on
long non-streaming generations). Retries succeeded for passes 2-5; pass 1 was
re-run with `stream: true` (SSE) which also returns real content and is kept as
the pass-1 raw response. All six passes are `finish_reason: stop`.

## Files in this folder (hy3 primary)

- passN_hy3_<group>.md — extracted final findings (primary)
- passN_hy3_raw_api_response.json — raw API response (streamed for pass 1)
- passN_hy3_reasoning_full.txt — model reasoning chain
- passN_hy3_raw_api_response_max6000.json — exact-parameter run (null content, proof of adaptation)
- passN_hy3_reasoning.txt — reasoning from the max6000 run
- REPORT.md — consolidated report (hy3 findings primary, nemotron fallback noted)
- passN_<group>.md / passN_raw_api_response.json — original nemotron fallback (unchanged)

## Grounding

Every finding listed in REPORT.md under "Verified Findings" was re-checked against
the real source with grep after the model run; the verification lines are cited
in the report's Repro section.
