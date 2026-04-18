# voice doctrine

Structa speaks only at milestones.

## default

- silence is the default
- navigation, queueing, retries, and routine processing stay silent
- non-voice tones are preferred for brief accomplishment / blocker cues

## allowed milestone speech

- triangle synthesized → `signal captured`
- decision created → `decision ready`
- decision approved → `locked`
- first analyzed capture in a project → `frame ready`
- first project creation → `project live`

## tone

- lowercase
- declarative
- no hedging
- no questions
- no emoji

## fallback rule

If a moment is ambiguous, Structa should not speak.
