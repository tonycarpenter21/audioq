---
name: add-public-api
description: Checklist for adding or changing a public function, method, option or type in audioq, so code, tests, generated wrappers, the API snapshot, README, CHANGELOG, docs site and demo stay in step. Use whenever the public API changes.
---

# Adding to audioq's public API

Work through these in order. `npm run validate:all` enforces most of them, but knowing them up
front avoids a round of fixes.

## 1. Decide where it lives

- **A method on `AudioQueue`** (src/audio-queue.ts) when it needs queue internals or every app
  needs it. It ships in every bundle: check `bundle-size` (the `queueAudio`-only budget is the
  one most users pay).
- **A standalone, tree-shakable function** in its own module when it is optional
  (`defineSprite`, `connectMediaSession`, `createChannelStore`, `preloadAudio`). Signature:
  `(…args, queue: AudioQueue = getDefaultAudioQueue())`, queue last. If the engine must
  cooperate, keep the engine side to a lookup in a tiny shared module (see src/memory.ts).

## 2. Write it

- JSDoc on every public symbol: description, `@param`, `@returns`, an `@example` for functions
  (gate `jsdoc-public-api`).
- New public types go in src/types.ts (or the module) and are exported from src/index.ts.
  Optional fields are `?: T | undefined` (consumers may use `exactOptionalPropertyTypes`).
- Object literals looked up with runtime strings must be a `Map` or typed `Record<string, T>`:
  the build renames identifier-like keys (gate `mangle-safety`).
- Runtime warnings go through `this.config.logger?.warn('audioq: …')`, never `console`.

## 3. Regenerate and record

```bash
npm run generate     # top-level wrappers in src/default-queue.ts (AudioQueue methods only)
npm run api:update   # api/public-api.json snapshot
```

## 4. Test

- Behaviour tests in the module's paired test file (`__tests__/<module>.test.ts`, gate
  `test-file-pairing`), using the fakes in `__tests__/helpers/fake-audio.ts` (FakeAudio,
  `installFakeFetch`, `installObjectUrls`, `installFakeAudioContext`).
- New `AudioQueue` methods: also call the generated wrapper in the "explicitly exercises every
  generated wrapper once" test in `__tests__/default-queue.test.ts` (gate
  `exported-symbols-tested`).
- New exports from index: mention them in `__tests__/index.test.ts`.
- Every suite also runs against the built package. Only white-box tests of renamed internals may
  opt out, with `@dist-skip <reason>` in the file header.

## 5. Document

- README.md: a section or line with a compiling example (gates `readme-api-coverage`,
  `readme-examples-compile`).
- CHANGELOG.md: a bullet under the unreleased version.
- MIGRATION.md if v2 users are affected.
- Docs site (`../audio-queue-docs`): the API reference page, `quick-reference.md`, and
  `types-interfaces.md` for new types. Function shapes go in ` ```ts signature ` blocks; every
  other ` ```ts ` block must compile. New pages go in `sidebars.ts`. Check with
  `AUDIOQ_DIR=../audioq npm run check` and `npm run build` in the docs repo.
- TODO.md: move the item to "Done".

## 6. Show it in the demo

Use the `verify-in-demo` skill: add a control to the demo, then run its e2e walkthrough.

## 7. Validate and commit

```bash
npm run validate:all
```

All gates must pass before committing (the pre-commit hook runs `npm run validate`).
