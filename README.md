# STRUCTA for Rabbit R1

STRUCTA turns conversations, references, and field captures into a living, decision-ready project corpus.

It is a 240×282 Rabbit-native project instrument for creative professionals. SHOW captures references, TELL captures thinking, KNOW exposes the project map, and NOW presents one highest-leverage intervention. Reversible structure and source-backed research may advance quietly; consequential decisions remain human-gated.

## V3 release candidate

This branch implements:

- a deterministic creative-core ledger and six-branch project map;
- declarative creative, digital-product, campaign, and spatial lenses;
- stable-ID decisions with two to four options, explicit reversal, and spoken custom answers;
- a silent Rabbit vision relay with exact request matching, truth roles, and batched uncertainty review;
- project-bound asynchronous voice, vision, research, and impact-chain writes;
- provenance-aware Rabbit research where unsourced synthesis remains a withheld hypothesis;
- versioned Markdown and `.structa.json` handoff exports;
- polished SHOW, TELL, KNOW, and NOW surfaces with hardware and direct-touch interaction, including a one-touch R1 camera handoff without an activation interstitial.

The canonical product contract is [STRUCTA_V3_PRODUCT_SPEC.md](STRUCTA_V3_PRODUCT_SPEC.md).

## Run

Requirements: Python 3 and Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:5000`. The browser runtime is useful for diagnostics; it does not prove Rabbit speaker, journal, camera, or callback behavior.

## Verify

```bash
npm test
```

The suite covers the project reducer, local orchestration, strict vision protocol, Rabbit bridge correlation, cross-project isolation, research provenance, durable decisions, fixed-viewport UI geometry, scenario traces, and voice doctrine.

## Architecture

- `js/project-engine.js` — creative-core ledger, selectors, gates, uncertainty review, decisions, and exports
- `js/domain-packs.js` — declarative build, campaign, and spatial reasoning lenses
- `js/vision-protocol.js` — strict `structa.vision.v1` envelope and callback collector
- `js/rabbit-adapter.js` — local project registry, persistence, and stable project-bound mutations
- `js/r1-llm.js` — queued Rabbit LLM, vision, and research bridge
- `js/camera-capture.js` / `js/voice-capture.js` — save-first capture pipelines
- `structa-cascade.js` — 240×282 state machine, rendering, and hardware interaction

## Release proof

V3 is a release candidate until both protocols pass:

- [Product pilot](docs/v3-product-pilot.md) — nine real projects and blind handoff testing
- [Physical R1 lab](docs/v3-r1-release-lab.md) — twenty captures, six fault injections, zero speech/journal/cross-request failures

Before public distribution, confirm that the PowerGrotesk license covers app embedding and repository distribution, or replace the bundled font with a distribution-safe alternative.

## License

Copyright © 2026 PlayGranada. All rights reserved; see [LICENSE](LICENSE).
