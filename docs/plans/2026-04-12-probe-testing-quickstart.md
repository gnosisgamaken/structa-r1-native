# probe testing quickstart

use this to test faster on replit and send back only the evidence that matters.

## goal

we need the real rabbit runtime event names and payloads.
not guesses.
not whether the ui "feels the same".
we need the exact event trace from the device.

## fastest way to run probe mode

open the app with:
- `?debug=1#probe`

example:
- normal app url: `https://...replit.dev`
- probe url: `https://...replit.dev/?debug=1#probe`

the combined route enables the owner proof recorder. the production diagnostic drawer remains hidden.

## what probe mode should show

on boot, a 44×44 `proof` control should appear at the top-right. tap it, then tap `check build`.

if the control is missing or the build check reports a fallback/mismatch, stop there and send a screenshot.

## exact test sequence on rabbit

do these one at a time, slowly:

1. open app in `?debug=1#probe`, tap `proof`, and run `check build`
2. press system back once
3. scroll wheel up once
4. scroll wheel down once
5. click side button once
6. hold ptt start
7. release ptt end
8. open show
9. try camera capture once
10. try front/back switch once

## what to capture for me

### minimum useful evidence
send me these three things:

1. a photo of the rabbit screen showing the build check
2. a screenshot of the replit console or shell showing the requests and any runtime output
3. every sequential proof email after tapping `finish + send`

## best evidence

best case, send me two photos:
- photo 1: the `check build` result
- photo 2: app after you have done the full hardware sequence

and one replit console screenshot.

## what text i need to read in the logs

i need the visible lines that mention things like:
- `window backbutton`
- `window scrollup`
- `window scrolldown`
- `window longpressstart`
- `window longpressend`
- `window sideclick`
- `bridge-out PluginMessageHandler.postMessage`
- anything with `ptt`
- anything with `camera`

## if the proof is not enough

use replit browser devtools if available, or the browser console panel if replit preview exposes it.

if not, do this simpler fallback:
- take a device photo of the failed screen
- take a replit console screenshot
- send both

## how we move faster

do not try to describe the behavior in long prose first.
just send:
- one device photo
- one post-test device photo
- one replit console/shell screenshot

then i will map the real hardware contract and patch the app from the emailed machine-readable proof.

## if you want an even faster loop

send me after each mini-test only:
- `back`
- photo

then:
- `wheel up`
- photo

then:
- `ptt`
- photo

that is slower for you but much faster for debugging certainty. use `journal backup` only after the run if email transport fails, because it deliberately creates a rabbit hole entry.
