# Structa Feedback Asset Slots

These are the canonical slot names for future uploaded UI sounds and icon replacements.

## Sound slots

- `nav-scroll`
- `nav-touch`
- `capture`
- `resolve`
- `blocked`
- `voice-open`
- `approve`
- `decision`
- `debug-bpm-up`
- `debug-bpm-down`
- `heartbeat-observe`
- `heartbeat-clarify`
- `heartbeat-research`
- `heartbeat-evaluate`
- `heartbeat-decision`
- `heartbeat-cooldown`

Current source of truth:

- runtime manifest: [js/audio-engine.js](/Users/pedro/company/PlayGranada/Operations/structa-r1-native/js/audio-engine.js)
- feedback adapter: `window.StructaFeedback.fire(kind)`

## Icon slots

- `brand-app`
- `brand-mark`
- `card-show`
- `card-tell`
- `card-know`
- `card-now`
- `touch-hint`

Current source of truth:

- runtime registry: [js/icons.js](/Users/pedro/company/PlayGranada/Operations/structa-r1-native/js/icons.js)

## Replacement doctrine

- Keep slot names stable.
- Replace assets by slot, not by callsite.
- Keep UI cues short, mono, and low-latency.
- Prefer one canonical brand family for both install and in-app identity.
