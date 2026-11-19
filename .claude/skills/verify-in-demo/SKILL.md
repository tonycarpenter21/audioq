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
mkdir -p /tmp/audioq-pack   # npm pack does not create the folder
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
npm run validate
```

It runs every check and prints a summary: the installed audioq version, compiler and lint
strictness, formatting, lint (zero warnings), stylelint, types, unit tests, unused modules, the
build, and `npm run e2e` (it serves the build with HTTP Range support, like GitHub Pages, and
walks every tab in Chromium with assertions; Python's `http.server` lacks Range support, which
breaks seeking and sprites). Use `npm run validate -- --skip-e2e` for a quick pass. When you add a
feature to the demo, add a `check(...)` for it in `scripts/e2e/run.js`.

Any other `npm install` in the demo removes the `--no-save` tarball again (the version check
fails and says so): reinstall it after adding dependencies.

Demo conventions:

- Examples live in `src/MultiChannelExampleBlock/` (`exampleData.ts`, `v3Examples.ts`). Each
  declares `channel` (0, 1 or 'global') and `enabledWhen` ('always', 'hasAudio', 'idle',
  'playing', 'paused'); button text is free. The rules are in `src/ExampleTab/exampleOrganizer.ts`.
- Async button handlers return their promise; fire-and-forget calls are written `void call()`.
- A tab shows only the channels that have examples. Group related buttons into small tabs
  rather than growing one tab: shared buttons are named controls composed per tab (see
  `playlistControls` in `v3Examples.ts`).
- Developer tools (the audioq event log) live in the on-page debug console, not on a tab.
- Read channel state with the `useChannel` hook (createChannelStore), not polling.
- Settings a tab changes must be reset in `performFullCleanup` (src/App.tsx) or the tab
  component's cleanup.

## 4. Check the docs

```bash
cd ../audio-queue-docs
AUDIOQ_DIR=../audioq npm run validate
```

Examples compile against the built types, every page is in the sidebar, the tsconfig stays
strict, the site's own code type-checks, and the build fails on broken links and anchors.

## 5. Hand over for device QA

Tell the user what to try on a phone; iOS behaviour (autoplay, volume through Web Audio, lock
screen) cannot be tested in Chromium. Open questions are listed under "Needs real-device
testing" in TODO.md.
