# Structa Probe Device Test Checklist

Open the app with:

- `?debug=1#probe`

Example:

- `https://your-staging-url/?debug=1#probe`

The production diagnostic drawer stays hidden. This lab URL adds a 44×44 **proof** control in the top-right corner instead.

At launch, tap **proof**, then **check build**. Stop if it reports a missing, fallback, or mismatched server build.

## Test sequence

Do these slowly, one by one:

1. Open app in `?debug=1#probe`, tap **proof**, and run **check build**
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

After the sequence, open **proof**, advance the phase as directed by the full lab protocol, and tap **finish + send**. Keep every sequential email part from that session.

## What to send back

Minimum:

1. A photo of the Rabbit screen showing the **check build** result
2. A photo of the Rabbit screen after the full sequence
3. Every emailed proof part, plus a Replit console or shell screenshot if anything suspicious appears

Best evidence:

- One photo focused on the build check
- One short video focused on any failed SHOW / SHOW+TELL interaction
- The machine-readable emailed proof parts

## What the proof should capture

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

- If the **proof** control or build check is unavailable, stop and send that first photo.
- If a capture fails, still continue and take the after-test photo.
- Use **journal backup** only after the run if email transport fails; it deliberately writes one Rabbit Hole entry.
