## Summary
The Figma plugin code is well-structured for UI generation but silently swallows font-loading errors which will cause runtime crashes, while the Python harness lacks network and file I/O error handling, making batch runs fragile. Overall, the codebase demonstrates good domain separation but needs defensive programming around external dependencies.

## Critical Issues (Must Fix)
- [figma-plugin/code.js:34-38] Issue: `loadFonts()` catches and ignores all font loading errors (`catch(_) {}`). Why it matters: Figma's `createText()` throws if the font isn't loaded; since errors are swallowed, the plugin will crash later in `text()` (line 69+) with an unhandled rejection, and `figma.closePlugin()` (end of `main`) never executes, leaving the user with a hanging plugin. Suggested fix: Remove the silent catches, or properly await/handle font loading and ensure `figma.closePlugin()` is called in a `finally` block or that missing fonts are handled before text creation.

- [harness/run_harness.py:50] Issue: `_http_json` calls `urllib.request.urlopen` without try/except. Why it matters: If the LLM server (OpenAI or LM Studio) is unreachable, the script throws an unhandled `URLError`, crashing the entire batch run without reporting partial results. Suggested fix: Wrap in try/except for `urllib.error.URLError` and either retry, skip the scenario, or exit gracefully with a clear message.

## Security Issues
None found.

## Error Handling Issues
- [harness/run_harness.py:179] Issue: `detect_lmstudio_model` uses `urlopen` without timeout/error handling around the request. Why it matters: If LM Studio isn't running, the harness crashes before processing any scenario with an unhelpful stack trace. Suggested fix: Add try/except for connection errors and provide a clear "LM Studio not running" message.
- [harness/run_harness.py:502] Issue: `main` calls `load_scenarios(pathlib.Path(args.scenarios))` which uses `read_text()` without checking file existence. Why it matters: A typo in `--scenarios` path causes an unhelpful `FileNotFoundError`. Suggested fix: Check `path.exists()` and print a user-friendly CLI error before attempting to read.
- [harness/run_harness.py:407] Issue: `load_runtime_dump` calls `json.loads(candidate.read_text())` without try/except. Why it matters: A corrupted runtime dump will crash the trace suite instead of marking the scenario as invalid/missing. Suggested fix: Wrap JSON parsing in try/except and return `({}, None)` on parse error.

## Code Quality Issues
- [figma-plugin/code.js:82] Issue: `annotationBox` creates `const bg = rect(parent, 0, y, W, 1, BLACK, 0);` which is a transparent, unused rectangle. Why it matters: Dead code adds confusion and creates unnecessary nodes in the Figma document. Suggested fix: Remove the `bg` line entirely.
- [figma-plugin/code.js:100-105 & 108] Issue: In `buildHome`, the `cards` array defines `y` and `role` properties, but the rendering loop computes `cy` mathematically (line 114) and never uses `role` or `y`. Why it matters: Misleading data structures make maintenance harder (future devs may think `y` positions the card). Suggested fix: Remove unused `y` and `role` fields from the array or actually use them in the layout.
- [harness/semantic_judge.py:62-65] Issue: `judge_semantics` grounding score awards +1 for containing "UNKNOWN" and +1 for *not* containing banned words (which is almost always true). Why it matters: This inflates grounding scores to near-max for nearly all valid outputs, making the metric meaningless for distinguishing grounded vs ungrounded responses. Suggested fix: Revise grounding logic to check for actual source citations or confidence levels rather than just absence of banned words.
- [figma-plugin/code.js:71 vs 82/540] Issue: `text()` helper hardcodes font style selection by size (`size >= 20 ? 'Bold' : ...`), but `annotationBox` (line 82+) and `main` (label creation) manually set `fontName` with different logic. Why it matters: Inconsistent font selection could lead to unloaded font errors or visual inconsistencies. Suggested fix: Centralize font style resolution in a helper used everywhere.

## Testing Gaps
- No unit tests for `structa_validator.py` parsing edge cases (e.g., labels with colons in values, wrapped vs. direct formats with extra whitespace).
- No tests for `semantic_judge.py` scoring boundaries (e.g., empty string, exactly 28 words, all weak words).
- `run_harness.py` complex merge/match logic (`merged_capture_list`, `match_expect_claims`, `trace_match_value`) has no test coverage; regressions in dictionary merging or subset matching would go unnoticed.
- Figma plugin has no mock-based smoke test to verify that `loadFonts` failure doesn't crash `main`.

## What Looks Good
- `structa_validator.py` uses a clean `ValidationResult` dataclass and cleanly separates strict vs. lenient validation modes.
- `run_harness.py` provides a well-structured CLI with `argparse` and outputs both machine-readable JSON/JSONL and human-readable Markdown.
- `figma-plugin/code.js` uses consistent, small helper functions (`rect`, `circle`, `text`, `makeFrame`) to keep UI surface code DRY and readable.
- The plugin's use of `clipsContent = true` and proper parent/child node appending follows Figma best practices for frame management.