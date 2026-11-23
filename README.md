# audioq

Queue audio files on independent channels in the browser: play them in order, pause and resume
with fades, duck background audio under a voice-over, and react to events. Playlists, audio
sprites, captions, crossfades, preloading, lock-screen controls and visualizer data are built in,
and it handles autoplay blocking and iOS quirks for you. Zero dependencies, about 10 KB gzipped,
TypeScript types included.

- 🎵 [Demo](https://tonycarpenter21.github.io/audio-queue-demo/queue-management)
- 📚 [Docs](https://tonycarpenter21.github.io/audio-queue-docs/) (also as
  [llms.txt](https://tonycarpenter21.github.io/audio-queue-docs/llms.txt) for AI assistants)
- 📦 [npm](https://www.npmjs.com/package/audioq)
- Upgrading from 2.x? See [MIGRATION.md](MIGRATION.md).

```bash
npm install audioq
```

## Quick start

```ts
import { queueAudio, onAudioComplete } from 'audioq';

await queueAudio('/sfx/hello.mp3'); // plays now
await queueAudio('/sfx/world.mp3'); // plays after hello.mp3

onAudioComplete(0, (info) => console.log(`${info.fileName} finished (${info.reason})`));
```

Each **channel** (0-63) has its own queue, volume, pause state and events, so sound effects, music
and voice can play at the same time without interrupting each other. Channel 0 is the default.

```ts
await queueAudio('/music/theme.mp3', 1, { loop: true, volume: 0.4 }); // music on channel 1
await queueAudio('/sfx/coin.mp3', 2); // effects on channel 2
```

## Two ways to use it

The top-level functions (`queueAudio`, `pauseChannel`, ...) share one default queue, created the
first time you use it. For more than one independent player, custom settings, or isolated tests,
create your own queues with `createAudioQueue`. Every top-level function is also a method on the
`AudioQueue` it returns.

```ts
const sfx = createAudioQueue({ defaultMaxQueueSize: 5, dropOldestWhenFull: true });
await sfx.queueAudio('/sfx/laser.mp3');

const same = getDefaultAudioQueue(); // the queue behind the top-level functions
same.setQueueConfig({ loadTimeoutMs: 10000 });
```

Importing audioq has no side effects, so it is safe in server-side rendering (Next.js, Nuxt,
SvelteKit). Audio only starts when you call `queueAudio` in the browser.

## Queueing

`queueAudio(source, channel?, options?)` accepts relative and absolute URLs, `blob:` URLs,
`data:` URIs, and `Blob`/`File` objects (object URLs are created and revoked for you). It
resolves as soon as the item is queued and returns a handle:

```ts
const item = await queueAudio('/voice/intro.mp3');
const didStart = await item.started; // true once playback starts, false if it never does
const outcome = await item.finished; // 'ended' | 'stopped' | 'error' | 'removed' | 'skipped'
console.log(item.id, item.src, item.channelNumber, didStart, outcome);
```

Options (`AudioQueueOptions`):

| Option         | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| `addToFront`   | Play right after the current item instead of at the end.                         |
| `interrupt`    | Stop the current item and clear the channel, then play this one now.             |
| `dedupeMs`     | Ignore the call if the same source was queued on the channel this recently.      |
| `metadata`     | Your data (`title`, `artist`, `artwork`, ids...), returned with every event.     |
| `loop`         | Repeat until stopped.                                                            |
| `volume`       | Item volume (0-1), multiplied with the channel and global volume.                |
| `playbackRate` | Item speed (0.25-4, pitch preserved), multiplied with the channel speed.         |
| `startAt`      | Start this many milliseconds into the file (resume where the listener left off). |
| `maxQueueSize` | Queue limit for this call only.                                                  |
| `crossOrigin`  | `'anonymous'` or `'use-credentials'` for CORS-enabled files (see iOS).           |

```ts
await queueAudioPriority('/sfx/alert.mp3'); // same as { addToFront: true }
await stopCurrentAudioInChannel(); // skip to the next item
await stopAllAudioInChannel(1); // stop channel 1 and clear its queue
await stopAllAudio(); // stop everything
await destroyChannel(2); // stop channel 2 and forget its listeners and settings
await destroyAllChannels(); // reset the queue completely
```

### Queue limits

```ts
setQueueConfig({ defaultMaxQueueSize: 20 }); // every channel
setChannelQueueLimit(2, 3); // channel 2 only
setQueueConfig({ dropOldestWhenFull: true }); // drop the oldest waiting item instead of throwing
console.log(getQueueConfig().defaultMaxQueueSize);
```

When a channel is full, `queueAudio` rejects, unless `dropOldestWhenFull` is set. The playing item
is never dropped.

### Rearranging a queue

Index 0 is the playing item. Waiting items start at index 1.

```ts
await reorderQueue(3, 1); // move item 3 so it plays next
await swapQueueItems(1, 2);
await removeQueuedItem(2);
await clearQueueAfterCurrent(); // let the current item finish, drop the rest
console.log(getQueueLength(), getQueueItemInfo(1)?.fileName);
```

These return `{ success, error?, updatedQueue? }` instead of throwing.

### Recipes

Notification sounds that may fire in bursts: play each one at most once per second.

```ts
await queueAudio('/sfx/message.mp3', 3, { dedupeMs: 1000 });
```

Voice assistants and text-to-speech: queue each generated clip as it arrives, and cut the speech
off when the user starts talking.

```ts
const speak = async (text: string): Promise<void> => {
  const clip = await (await fetch(`/api/tts?text=${encodeURIComponent(text)}`)).blob();
  await queueAudio(clip, 1, { metadata: { text } });
};
await speak('Hello!');
await queueAudio('/sfx/listening.mp3', 1, { interrupt: true }); // barge-in
```

Podcasts and audiobooks: resume where the listener stopped, at their preferred speed.

```ts
await queueAudio('/episodes/42.mp3', 0, { startAt: 754000, metadata: { title: 'Episode 42' } });
setPlaybackRate(0, 1.5);
seekBy(0, -15000); // back 15 seconds
seekTo(0, 60000); // jump to 1:00
```

Sleep timer and scheduled playback need no API: use a timer.

```ts
setTimeout(() => void pauseAllWithFade(FadeType.Gentle, 3000), 30 * 60 * 1000);
setTimeout(() => void queueAudio('/sfx/reminder.mp3'), 5 * 60 * 1000);
```

## Playlists

```ts
setRepeatMode(0, 'all'); // 'off' | 'one' | 'all'
console.log(getRepeatMode(0));
await shuffleQueue(0); // shuffle the waiting items; the current one keeps playing
setChannelGap(0, 1500); // 1.5 seconds of silence between items
console.log(getChannelGap(0), getPlaybackRate(0), PLAYBACK_RATE_RANGE);

for (const entry of getHistory(0)) {
  console.log(entry.fileName, entry.reason, entry.playedMs); // what played, and how much of it
}
clearHistory(0);
```

`'one'` replays the current item, `'all'` moves each item that finishes to the end of the queue
so the whole queue repeats. History keeps the last `historySize` items per channel (20 by
default).

## Sprites, cues and crossfades

**Audio sprites** put many short sounds in one file: one download for every sound effect.
`endAt` (with `startAt`) plays one segment of any file; `defineSprite` names the segments.

```ts
const sfx = defineSprite('/sfx/sprite.mp3', {
  coin: [0, 300],
  engine: { endMs: 4000, loop: true, startMs: 1000 },
  jump: [400, 900]
});
await sfx.play('coin', 2, { interrupt: true }); // rapid sounds cut each other off
await sfx.play('engine', 3); // loops its segment until stopped
await queueAudio('/voice/all-lines.mp3', 1, { endAt: 4200, startAt: 3000 });
```

**Cues** fire events at moments in a track: captions, karaoke lyrics, lip-sync, or visuals. A cue
with `endMs` fires when playback enters it (`active: true`) and leaves it (`active: false`); a
cue without `endMs` fires once. Cues fire on time (not just when the browser reports progress),
and follow seeks.

```ts
onAudioCue(1, ({ active, cue }) => {
  console.log(active ? `show: ${cue.text}` : 'hide caption');
});
await queueAudio('/voice/intro.mp3', 1, {
  cues: [
    { endMs: 2400, startMs: 0, text: 'Welcome back!' },
    { data: { animation: 'wave' }, startMs: 2600 }
  ]
});
offAudioCue(1);
```

Captions you already have as a WebVTT file convert to cues with `parseWebVtt`
(`parseVttTimestamp` converts a single timestamp):

```ts
const vtt = await (await fetch('/captions/intro.vtt')).text();
await queueAudio('/voice/intro.mp3', 1, { cues: parseWebVtt(vtt) });
console.log(parseVttTimestamp('01:02.500')); // 62500
```

**Crossfade** overlaps consecutive items: near the end of each item the next starts and fades in
while the current one fades out (at most half of an item's length).

```ts
setCrossfade(0, 3000);
console.log(getCrossfade(0)); // 3000
```

## Lock screen and media controls

`connectMediaSession` shows a channel's current item on the lock screen, in media notifications
and in the browser's media hub, using the item's `metadata` (title, artist, album, artwork), and
wires up their play, pause, stop, next, previous and seek buttons. It is a separate function, so
apps that do not use it do not ship it.

```ts
const disconnect = connectMediaSession({ channel: 0, seekOffsetMs: 15000 });
await queueAudio('/episodes/42.mp3', 0, {
  metadata: {
    artist: 'My Podcast',
    artwork: [{ sizes: '512x512', src: '/art/42.png', type: 'image/png' }],
    title: 'Episode 42'
  }
});
disconnect(); // when the player unmounts
```

## Pause, resume and fades

```ts
await pauseChannel(0);
await resumeChannel(0);
await togglePauseChannel(0);
await pauseAllChannels();
await resumeAllChannels();
await togglePauseAllChannels();
console.log(isChannelPaused(0), getAllChannelsPauseState());

await pauseWithFade(FadeType.Gentle, 0); // fade out over 800ms, then pause
await resumeWithFade(); // fade back in with the matching curve
await pauseWithFade(FadeType.Dramatic, 1, 1500); // custom duration
await togglePauseWithFade(FadeType.Linear, 0);
await pauseAllWithFade(FadeType.Gentle);
await resumeAllWithFade();
await togglePauseAllWithFade();
console.log(getFadeConfig(FadeType.Dramatic).duration);
```

Calling a resume while a fade-out is still running cancels the pause and fades back in.

When the operating system pauses audio (a phone call, unplugged headphones, the lock screen or
Control Center), audioq notices: the channel reports as paused and `onAudioPause` fires, and a
play from the lock screen fires `onAudioResume`. Set `pauseWhenHidden: true` to pause playing
channels while the page is hidden and resume them when it is visible again.

## Volume

Output volume is **channel volume × item volume × global volume × ducking × fade**. Each part is
independent, so setting one never overwrites another.

```ts
await setChannelVolume(1, 0.5); // instant
await setChannelVolume(1, 0.2, 500, EasingType.EaseOut); // over 500ms
await transitionVolume(1, 0.8, 300); // same as setChannelVolume with a duration
cancelVolumeTransition(1);
cancelAllVolumeTransitions();
await setAllChannelsVolume(0.7);
await setGlobalVolume(0.5); // master volume
console.log(getChannelVolume(1), getAllChannelsVolume(), getGlobalVolume());
```

Muting keeps every volume, so unmuting restores the mix exactly. Audio keeps playing.

```ts
setMuted(!isMuted()); // a mute button
setChannelMuted(0, true); // just the music
console.log(isChannelMuted(0));
```

### Stereo panning

```ts
setChannelPan(1, -0.8); // footsteps on the left (-1 left, 0 center, 1 right)
console.log(getChannelPan(1));
```

Panning routes the channel through Web Audio, so it works for same-origin, preloaded or CORS
(`crossOrigin: 'anonymous'`) audio. Other audio plays centered, with a warning.

### Visualizers

`getChannelAnalyser(channel)` returns the browser's own `AnalyserNode` for a channel, measuring
what it plays (after volume, fades and panning):

```ts
const analyser = getChannelAnalyser(0);
const bins = new Uint8Array(analyser?.frequencyBinCount ?? 0);
const draw = (): void => {
  analyser?.getByteFrequencyData(bins); // 0-255 per frequency band; draw bars from it
  requestAnimationFrame(draw);
};
draw();
```

Like panning it uses Web Audio, so it measures same-origin, preloaded or CORS audio.

### Ducking

Lower every other channel while a priority channel (for example voice) has audio queued. Channels
that start while ducking is active are ducked too.

```ts
setVolumeDucking({
  duckingVolume: 0.2, // other channels drop to 20%
  priorityChannel: 1,
  priorityVolume: 1,
  duckTransitionDuration: 200,
  restoreTransitionDuration: 400
});
clearVolumeDucking();
```

## Events

Every `on*` function returns an unsubscribe function, which removes only that listener (ideal for
React effects). `off*(channel)` removes every listener of that kind on a channel, and
`off*(channel, callback)` removes one.

```ts
const offStart = onAudioStart(0, (info) => console.log('started', info.fileName, info.duration));
const offComplete = onAudioComplete(0, (info) => console.log(info.reason, info.remainingInQueue));
const offProgress = onAudioProgress(0, (info) => console.log(info.progress, info.currentTime));
const offQueue = onQueueChange(0, (snapshot) => console.log(snapshot.items.length));
const offPause = onAudioPause(0, (channel, info) => console.log('paused', channel, info.fileName));
const offResume = onAudioResume(0, (channel, info) => console.log('resumed', channel, info.src));
const offError = onAudioError(0, (error) => console.warn(error.errorType, error.error.message));

[offStart, offComplete, offProgress, offQueue, offPause, offResume, offError].forEach((off) =>
  off()
);

offAudioStart(0);
offAudioComplete(0);
offAudioProgress(0);
offQueueChange(0);
offAudioPause(0);
offAudioResume(0);
offAudioError(0);
```

React example:

<!-- validate:skip -->

```ts
useEffect(() => onAudioProgress(0, (info) => setProgress(info.progress)), []);
```

File names in event payloads are plain text (`rock & roll.mp3`). Frameworks escape them for you;
escape them yourself if you insert them with `innerHTML`.

## Reading state

```ts
const info = getCurrentAudioInfo(0); // null when nothing is queued
if (info) console.log(info.fileName, info.progress, info.isPlaying, info.volume);

const snapshot = getQueueSnapshot(0); // null for a channel that was never used
console.log(snapshot?.items.map((item) => item.fileName));
console.log(getAllChannelsInfo());
console.log(extractFileName('https://cdn.example.com/a%20b.mp3')); // 'a b.mp3'
```

### UI frameworks

`createChannelStore` turns a channel into a store with `subscribe` and `getSnapshot`. It works
with React's `useSyncExternalStore`, is a Svelte store as is, and fits Vue or Solid in two lines.
It only listens while subscribed and only reports visible changes.

```tsx
const music = createChannelStore(0); // once, outside components

function NowPlaying() {
  const { current, isPaused, items } = useSyncExternalStore(music.subscribe, music.getSnapshot);
  return (
    <p>
      {current ? `${current.fileName} ${isPaused ? '(paused)' : ''}` : 'Nothing playing'} ·{' '}
      {items.length} queued
    </p>
  );
}
```

```svelte
<p>{$music.current?.fileName ?? 'Nothing playing'}</p>
```

## Preloading

`preloadAudio` downloads files into memory, so they start instantly, keep working offline and
seek without the server's Range support (handy for sprites). Items queued with a preloaded URL
play from memory automatically. It never rejects; each result says whether it worked, and a file
that failed still plays from the network.

```ts
const results = await preloadAudio(['/sfx/sprite.mp3', '/music/level-1.mp3']);
console.log(
  results.every((result) => result.ok),
  isAudioPreloaded('/sfx/sprite.mp3')
);
await queueAudio('/sfx/sprite.mp3'); // plays from memory
releasePreloadedAudio('/music/level-1.mp3'); // free memory; playing sounds keep playing
```

Files from another origin need CORS headers. Downloads time out after `loadTimeoutMs`. For a queue
made with `createAudioQueue`, pass it last: `preloadAudio(urls, queue)`, as with
`createChannelStore(channel, queue)` and `defineSprite(src, map, queue)`.
Preloaded CDN files can also be routed through Web Audio on iOS, so their volume works there.

## Errors

A file that fails to load or play is reported through `onAudioError` and skipped; the next item
plays. A failing item that is still waiting is removed without disturbing the one playing.
`AudioErrorType` tells you what happened:

| Type              | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `AutoplayBlocked` | The browser needs a user interaction first. The item is **kept**.   |
| `Network`         | The file could not be downloaded.                                   |
| `Decode`          | The file is corrupt.                                                |
| `Unsupported`     | The browser cannot play this format or source.                      |
| `Timeout`         | The file did not start within `loadTimeoutMs` (default 15 seconds). |
| `Abort`           | The browser aborted loading.                                        |
| `Unknown`         | Anything else.                                                      |

Want retries? Re-queue from the error listener:

```ts
onAudioError(0, (error) => {
  if (error.errorType === AudioErrorType.Network) void queueAudio(error.src, error.channelNumber);
});
```

### Autoplay

Browsers block audio until the user has interacted with the page. audioq keeps blocked items in
the queue and starts them on the next click, tap or key press. To start them from your own button
handler instead:

```ts
button.addEventListener('click', () => unlockAudio());
```

## iOS and Web Audio

iOS ignores `HTMLAudioElement.volume`, so volume, fades and ducking there need the Web Audio API.
With `webAudio: 'auto'` (the default) audioq routes a sound through it only while its volume is
between silent and full, or when its channel is panned or analysed. Audio at full volume stays
native, because on iOS routed audio loses lock-screen and background playback and can drift out of
sync on pause. Muting uses the element's `muted` flag, which iOS honours. iOS also refuses to
start a new audio element outside a tap, so when the next item in a queue is refused, audioq moves
it onto an element that has already played (iOS lets those play again) and retries. Cross-origin files are
only routed if you queue them with `crossOrigin: 'anonymous'` and the server sends CORS headers;
otherwise they play at full volume rather than silently.

```ts
setQueueConfig({ webAudio: 'off' }); // never use Web Audio
setQueueConfig({ webAudio: 'force' }); // use it everywhere
console.log(getWebAudioSupport().reason, isIOSDevice(), isWebAudioSupported());
```

All Web Audio routing shares one `AudioContext`, closed by `destroyAllChannels()`.

## Configuration

`createAudioQueue(config)` and `setQueueConfig(config)` accept:

| Option                | Default   | Description                                                     |
| --------------------- | --------- | --------------------------------------------------------------- |
| `debug`               | `false`   | Log every event (except progress) via `logger.debug`.           |
| `defaultMaxQueueSize` | unlimited | Items per channel, including the playing one.                   |
| `dropOldestWhenFull`  | `false`   | Drop the oldest waiting item instead of rejecting a new one.    |
| `historySize`         | `20`      | Finished items remembered per channel for `getHistory`.         |
| `loadTimeoutMs`       | `15000`   | Skip an item that has not started after this long (0 disables). |
| `logger`              | `console` | Where warnings go; `null` silences the library.                 |
| `maxChannels`         | `64`      | Number of channels (`MAX_CHANNELS`).                            |
| `pauseWhenHidden`     | `false`   | Pause while the page is hidden, resume when visible.            |
| `prefetchCount`       | `1`       | Waiting items to preload ahead of the current one.              |
| `showQueueWarnings`   | `true`    | Warn when a queue limit is reached.                             |
| `webAudio`            | `'auto'`  | `'auto'`, `'force'` or `'off'` (see iOS).                       |

### Debugging

When a sound does not play, turn on the debug log: every event (queued, started, paused,
failed, completed and why, cues) is logged with its channel and payload.

```ts
setQueueConfig({ debug: true });
// audioq [channel 0] queuechange { items: [...], totalItems: 1, ... }
// audioq [channel 0] error { errorType: 'autoplay-blocked', ... }
```

## Browser support

Browsers from 2020 onwards (ES2020 and `HTMLAudioElement`): Chrome and Edge 80+, Firefox 74+,
Safari 13.1+ and their mobile versions. Node.js is supported for importing (SSR) but not for
playback.

## Development

Developing audioq needs Node 20.19+, 22.13+ or 24+ (the library itself runs in any browser).

```bash
npm install
npm test               # unit tests
npm run validate       # quick checks (format, lint, types, tests), also the pre-commit hook
npm run validate:all   # every validation gate, with a report
```

`npm run validate:all` runs 32 gates: formatting, lint, strict type checks, tests with per-file
coverage, a test file for every source file, a test reference for every exported function and
method, documentation for the whole public API, zero runtime dependencies, no circular imports,
size limits, a public API snapshot, README examples that compile, changelog order, the build, both
module formats, SSR-safe import, bundle size, and the published file list. Run
`npm run validate:all -- --list` to see them all.

Each run writes `.validation-reports/<timestamp>/report.md` (failing gates first, with every
problem), `report.json`, and a log per gate. The newest 5 runs are kept. Other useful options:
`--only=lint,build` and `--skip=bundle-size`.

After changing the `AudioQueue` class, run `npm run generate` to regenerate the top-level
functions, and `npm run api:update` if the public API changed on purpose.

## License

MIT
