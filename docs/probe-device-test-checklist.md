# Structa Probe Device Test Checklist

Open the app with:

- `#probe`

Example:

- `https://your-staging-url/#probe`

Expected first visible log lines:

- `probe started`
- `probe mode active`
- `window viewport ...`
- `window screen ...`

## Test sequence

Do these slowly, one by one:

1. Open app in `#probe`
2. Press system back once
3. Scroll wheel up once
4. Scroll wheel down once
5. Click side button once
6. Hold PTT once
7. Release PTT
8. Open `show`
9. Capture one rear-camera image
10. Hold PTT during camera once for SHOW+TELL
11. Switch front/back camera once
12. Open `tell` and record one short voice note
13. Open `know`
14. Open `now`
15. Approve or skip one blocker if available

## What to send back

Minimum:

1. A photo of the Rabbit screen right after boot in `#probe`
2. A photo of the Rabbit screen after the full sequence
3. A Replit console or shell screenshot if anything suspicious appears

Best evidence:

- One photo focused on probe boot logs
- One photo focused on SHOW / SHOW+TELL logs
- One photo focused on blocker / NOW logs

## What I want to read in the logs

- `window backbutton`
- `window scrollup`
- `window scrolldown`
- `window sideclick`
- `window longpressstart`
- `window longpressend`
- `bridge-out pluginmessagehandler.postmessage`
- `bridge-in onpluginmessage ...`
- `camera`
- `visual note ready`
- `show+tell`
- `decision ready`
- `blocker`

## Notes

- If `probe started` does not appear, stop and send that first photo.
- If a capture fails, still continue and take the after-test photo.
- If logs scroll too fast, take multiple photos instead of trying to summarize.
