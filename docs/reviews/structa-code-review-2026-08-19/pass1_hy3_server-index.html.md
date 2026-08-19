## Summary
The server provides a useful LLM prompt-orchestration layer with solid input normalization, but it has a critical file-disclosure fallback and a broken image-analysis contract. Security and error-handling gaps (spoofable rate limiting, verbose errors, unhandled header parsing) should be addressed before production use.

## Critical Issues (Must Fix)
- [server.py:1216] Issue: `do_GET` falls back to `super().do_GET()` (SimpleHTTPRequestHandler default) for any path not explicitly handled. This serves arbitrary files from the current working directory (e.g., `server.py`, `.env`), causing source-code and secret disclosure. Fix: remove the fallback (return 404) or restrict static serving to a vetted directory with directory listing disabled.
- [server.py:94-97 and server.py:428-434] Issue: `build_image_prompt` instructs the LLM to return free-text sentences and `-` bullets, but `image_normalize` uses `parse_labeled_lines` expecting `FACTS:`, `SIGNAL:`, `NEXT:` labels. The mismatch means structured image fields are never populated and it always falls back to `"frame saved"`. Fix: align the prompt with the labeled format (or rewrite normalize to parse the bullet format).

## Security Issues
- [server.py:163] Issue: `claims_extract_allowed` derives the rate-limit key from a client-supplied `deviceId` (`meta.deviceId` or `input.deviceId`). A client can bypass the 10/min limit by randomizing this field each request. Additionally, the global `CLAIMS_EXTRACT_BUCKETS` is mutated without a lock, allowing race conditions under `ThreadingHTTPServer`. Fix: use a server-trusted identifier and add a lock or atomic counter.
- [server.py:1153-1158] Issue: `end_headers` sets `Cache-Control`, `Pragma`, `Expires`, and `X-Content-Type-Options` but omits `X-Frame-Options` and `Content-Security-Policy`. This leaves the UI vulnerable to clickjacking/framing. Fix: add `X-Frame-Options: DENY` and a minimal CSP.
- [server.py:1196 and server.py:1279] Issue: Raw exception strings (`str(err)`) are returned to clients in 500 responses (and asset read errors). This can leak internal paths or library details. Fix: log the error server-side and return a generic message.

## Error Handling Issues
- [server.py:1172] Issue: `int(self.headers.get("Content-Length", "0") or "0")` raises `ValueError` if the header is non-numeric. `read_json` does not catch this, so a malformed request crashes the handler. Fix: wrap in try/except and treat invalid length as a 400 error.
- [server.py:1278-1279] Issue: The broad `except Exception as err` in `do_POST` returns the raw error and does not log it server-side. This hampers debugging and monitoring. Fix: log the traceback (e.g., via `self.log_message` or `logging`) and return a generic 500.

## Code Quality Issues
- [server.py:160-172] Issue: `CLAIMS_EXTRACT_BUCKETS` grows unbounded because keys are never purged when a device goes idle; also the read-modify-write is not thread-safe. Fix: add a lock and periodic cleanup of stale keys.
- [server.py:1272-1276] Issue: Handler dispatch switches between `prepare` and `normalize` based solely on `payload.get("rawResponse") is not None`. This implicit contract is fragile—a stray `rawResponse` in a prepare call triggers normalize. Fix: use distinct endpoints or an explicit `action` field.
- [server.py:474-475] Issue: Inconsistent indentation (6 spaces instead of 4) for the `if not target_id:` block in `normalize_chain_focus`. Not a bug but hurts readability.
- [index.html: inline script near end] Issue: The page uses `document.write` to inject all JS assets during load. This is blocking and brittle if any script fails. Prefer `createElement('script')` with `defer`/`async` or a bundled approach.

## Testing Gaps
- No automated tests for any pure functions (`compact`, `build_image_prompt`, `extract_json_block`, `normalize_chain_focus`, etc.).
- Image flow mismatch (prompt vs. normalize) indicates missing integration tests for `/v1/image/analyze`.
- Rate-limiting logic is untested for concurrency, spoofed keys, and memory growth.
- Path-traversal protection in `/__structa_asset/` is not covered by tests.
- `extract_json_block` fallback parsing (code fences, embedded JSON) has no edge-case tests.
- Malformed HTTP requests (invalid `Content-Length`, missing headers) are not tested.

## What Looks Good
- Defensive payload parsing: widespread `isinstance(..., dict)` and `or {}` defaults prevent many `TypeError`s.
- `compact()` centralizes length capping and whitespace normalization, reducing oversized prompts and injection surface.
- Path-traversal defense in `do_GET` for `/__structa_asset/` correctly uses `resolve()` and parent checks.
- `validate_chain_response_shape` and `validate_triangle_response_shape` enforce evidence citation, improving output integrity.
- Global security headers (`nosniff`, `no-cache`) are applied on every response.
- Clear separation of "prepare" (prompt build) and "normalize" (response parse) aids maintainability.