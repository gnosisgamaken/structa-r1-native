# R1 Anywhere serial smoke probe

`scripts/r1a-serial-smoke.mjs` is a cautious provider/schema probe. It sends three synthetic text cases, plus an optional local-image case, to an OpenAI-compatible chat-completions endpoint.

It can answer a narrow question: can the configured provider return correctly correlated, STRUCTA-shaped JSON? It cannot prove that the STRUCTA creation works on an R1. A passing report says nothing about the physical controls, camera handoff, Rabbit Hole behavior, device speech, or 240x282 rendering.

The current R1 Anywhere device client requests journal entries for relayed chat-completion calls, including its image path. Use synthetic material and expect test traffic in Rabbit Hole; this probe cannot validate STRUCTA's separate silent/no-journal policy.

## Safety contract

- The default and pinned provider base is `https://creations.boondit.site/api/r1a/v1`. Other providers require an explicit HTTPS URL and `--allow-custom-endpoint`; HTTP is always rejected.
- Relay configuration is read only from `R1A_BASE_URL`, `R1A_API_KEY`, and `R1A_MODEL`. The base URL defaults to the pinned Boondit route. If `R1A_MODEL` is omitted, the runner makes one authenticated `GET /models` preflight and proceeds only when exactly one usable model is advertised.
- The key and endpoint are never included in the report or logs.
- The runner's HTTP requests are strictly serial and are not retried. R1 Anywhere's separate Socket.IO client can reconnect; its third-party delivery semantics are outside this runner's control.
- The default gap is fifteen seconds after a completed request. `--gap-ms` may increase, but not reduce, it. With strict serialization, even the optional four-case run stays at or below four dispatches per minute before request latency is counted. This is a conservative STRUCTA lab policy, not a published Boondit or Rabbit quota and not a guarantee against throttling or disconnection.
- No other program may use the same relay key during the run. The current device client holds one mutable pending request, so concurrent traffic can misattribute a late response.
- Every request has a unique case ID and request ID that the response must echo exactly.
- Authentication, throttling, session, correlation, timeout, network, and other HTTP failures stop the run.
- The timeout for each request is 90 seconds.
- Unless `--out` is present, the final report is written to stdout. Use npm's `--silent` flag if stdout needs to remain machine-readable JSON.

Do not paste Rabbit credentials or the separate Boondit relay key into an issue, Discord, a test report, or an AI chat. Use the relay key shown by Boondit Settings after pairing; do not extract or repurpose Rabbit device credentials. Configure the relay key in the local shell only, and clear it when testing is complete.

## Offline check

No credentials or network access are needed:

```sh
npm run --silent smoke:r1a -- --dry-run
node --test tests/r1a-serial-smoke.test.mjs
```

The dry run prints a sanitized dispatch plan. The focused test uses an in-process mock provider to verify serial execution, pacing, redaction, authentication stop, and correlation stop.

## Live text probe

The production base URL is pinned by default. It is shown explicitly below so the route is easy to verify. Enter the separate Boondit relay key without putting it in shell history:

```sh
export R1A_BASE_URL='https://creations.boondit.site/api/r1a/v1'
read -rsp 'R1A API key: ' R1A_API_KEY
export R1A_API_KEY
printf '\n'
npm run --silent smoke:r1a -- --out ./r1a-smoke-report.json
unset R1A_API_KEY R1A_BASE_URL R1A_MODEL
```

When `R1A_MODEL` is unset, the runner securely queries the authenticated `/models` route without printing the key or model-list response. If the provider advertises more than one model, set `R1A_MODEL` to the exact model ID shown by Boondit Settings or returned by that authenticated route. Do not assume that a response label is a valid request model.

For a non-Boondit compatibility provider, set its HTTPS versioned base, set its exact model ID, and add `--allow-custom-endpoint` to the npm command. The flag is a deliberate acknowledgement that the relay key will be sent to a different origin; use a credential issued by that provider, never the Boondit relay key.

Nothing is printed to stdout when `--out` succeeds. The report contains timestamps, per-case latency and HTTP status, the raw assistant text, JSON parse status, schema/correlation validation, and any safe stop code. It does not contain request headers, the key, the endpoint, or provider error bodies.

## Optional experimental image probe

Run and review a passing text-only probe first. The image run repeats the three text cases, then sends one JPEG or PNG of at most 1 MiB as a standard data-URL `image_url` content part:

```sh
npm run --silent smoke:r1a -- \
  --image ./private-reference.png \
  --gap-ms 20000 \
  --out ./r1a-image-smoke-report.json
```

The image bytes are not stored in the report, but they are transmitted through Boondit to the paired R1. Use only a non-sensitive synthetic test image. Boondit's public device client proves that it can receive an `imageBase64` relay payload, but its public listing does not document the server's accepted OpenAI image input or media limits. A failure here may be an R1 Anywhere adapter limitation rather than a Rabbit vision or STRUCTA failure. This experimental lane is not a STRUCTA release gate.

## Reading the result

- Exit `0`: every dispatched case parsed and validated.
- Exit `1`: a response failed schema validation or the run hit a stop condition.
- Exit `2`: local arguments, configuration, image input, or output handling failed.

Treat any `authentication_error`, `rate_limit_error`, `session_error`, or `correlation_error` as a hard stop. Do not rerun immediately or add automatic retries; inspect the account/session state first.
