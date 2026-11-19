---
name: verify-in-demo
description: Try an unpublished audioq build in the demo app and docs site, and run their checks (demo type-check, build and Chromium e2e walkthrough; docs example type-check and build). Use after library changes, before asking for device QA.
---

# Verifying audioq in the demo and docs

The demo (`../audio-queue-demo`) and docs (`../audio-queue-docs`) are separate repositories.
Until a version is published, test the library through a packed tarball.

## 1. Pack the library

```bash
npm run validate:all
npm pack --pack-destination /tmp/audioq-pack
```

## 2. Install it in the demo, without changing package.json

```bash
cd ../audio-queue-demo
npm install --no-save /tmp/audioq-pack/audioq-3.0.0.tgz
```

`--no-save` keeps package.json and the lockfile pointing at the published version. Re-run this
after every library change (it is a copy, not a link).

## 3. Check the demo

```bash
npm run typecheck
npm run lint
npm run e2e
```

`npm run e2e` builds the demo, serves it with HTTP Range support (like GitHub Pages; Python's
`http.server` lacks Range support, which breaks seeking and sprites) and walks every tab in
Chromium with assertions. It needs Playwright and Chromium. When you add a feature to the
demo, add a `check(...)` for it in `scripts/e2e/run.js`.

Demo conventions:

- Examples live in `src/MultiChannelExampleBlock/` (`exampleData.ts`, `v3Examples.ts`). A
  button's channel and its enabled state come from its text: include "(Channel 0)" or
  "(Channel 1)", or "All Sounds"/"All Channels" for the global row. Avoid the words "pause",
  "resume" and "toggle" unless the button does that.
- Read channel state with the `useChannel` hook (createChannelStore), not polling.
- Settings a tab changes must be reset in `performFullCleanup` (src/App.tsx) or the tab
  component's cleanup.

## 4. Check the docs

```bash
cd ../audio-queue-docs
AUDIOQ_DIR=../audioq npm run check   # examples compile against the built types; sidebar complete
npm run build                        # broken links and anchors fail the build
```

## 5. Hand over for device QA

Tell the user what to try on a phone; iOS behaviour (autoplay, volume through Web Audio, lock
screen) cannot be tested in Chromium. Open questions are listed under "Needs real-device
testing" in TODO.md.
