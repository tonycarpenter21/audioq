# Migrating from audioq 2.x to 3.0

Most code that uses the top-level functions (`queueAudio`, `pauseChannel`, `setChannelVolume`,
`onAudioStart`, ...) keeps working unchanged. Check the list below for the parts you use.

## Behaviour changes

**`queueAudio` resolves when the item is queued, not when it starts playing.** In 2.x the
promise resolved when the first item started (and could wait forever if it never loaded), but
resolved immediately for later items. It now always resolves right away, with a handle:

```ts
// 2.x: await queueAudio('/a.mp3'); // waited for playback to start
const item = await queueAudio('/a.mp3');
await item.started; // wait for playback to start (true), or for the item to leave the queue (false)
await item.finished; // 'ended' | 'stopped' | 'error' | 'removed'
```

**Per-item `volume` no longer changes the channel volume.** `queueAudio(url, 0, { volume: 0.5 })`
plays that item at half the channel volume. In 2.x it also permanently set the channel volume to
0.5. If you relied on that, call `setChannelVolume(0, 0.5)`.

**Global volume now applies to every item**, including items queued with an explicit `volume`.

**Per-call `maxQueueSize` applies to that call only.** In 2.x it permanently changed the channel's
limit. Use `setChannelQueueLimit(channel, size)` for a lasting limit.

**Failed items are skipped without automatic retries.** The retry system was removed (it retried
blocked autoplay until the queue emptied, retried after stop, and could evict the playing item).
Handle retries yourself if you need them:

```ts
onAudioError(0, (error) => {
  if (error.errorType === AudioErrorType.Network) void queueAudio(error.src, error.channelNumber);
});
```

**Blocked autoplay keeps the queue.** Items queued before the user interacts with the page stay
queued and start on the first click, tap or key press. You get one `AutoplayBlocked` error.

**Stopping reports a completion with a reason.** `onAudioComplete` still fires when an item is
stopped, and now includes `reason: 'ended' | 'stopped' | 'error'` so you can tell them apart.

**File names are plain text.** `fileName` used to be HTML-escaped (`rock &amp; roll.mp3`). It is
now `rock & roll.mp3`. React, Vue, Svelte and Angular escape it for you; escape it yourself only
if you insert it with `innerHTML`.

**Any URL the browser can play is accepted**, including `blob:`, `data:` and `../` paths.

**Invalid channel numbers throw `RangeError`** (`NaN`, fractions, negative, 64 or more) instead
of failing later with a `TypeError`.

**`getQueueSnapshot` on an empty channel** returns `currentIndex: -1` instead of `0`.

**`on*` functions return an unsubscribe function.** Existing code that ignores the return value is
unaffected. `off*(channel)` still removes every listener of that kind on the channel;
`off*(channel, callback)` now removes just one.

**Item elements are created lazily.** Only the playing item and the next one (`prefetchCount`) are
loaded. Nothing changes for you unless you relied on every file downloading immediately.

## Removed exports

| 2.x                                                                                                                                                   | 3.0                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `setRetryConfig`, `getRetryConfig`, `retryFailedAudio`                                                                                                | Removed: re-queue from `onAudioError`                             |
| `setErrorRecovery`, `getErrorRecovery`                                                                                                                | Removed: failed items are always reported and skipped             |
| `audioChannels`                                                                                                                                       | `getQueueSnapshot`, `getAllChannelsInfo`, `getCurrentAudioInfo`   |
| `setWebAudioConfig({ enabled: false })`                                                                                                               | `setQueueConfig({ webAudio: 'off' })`                             |
| `setWebAudioConfig({ forceWebAudio: true })`                                                                                                          | `setQueueConfig({ webAudio: 'force' })`                           |
| `getWebAudioConfig`                                                                                                                                   | `getQueueConfig().webAudio`                                       |
| `validateAudioUrl`, `sanitizeForDisplay`, `cleanWebpackFilename`                                                                                      | Removed                                                           |
| `createQueueSnapshot`, `getAudioInfoFromElement`                                                                                                      | `getQueueSnapshot`, `getCurrentAudioInfo`                         |
| `createWebAudioNodes`, `cleanupWebAudioNodes`, `getAudioContext`, `setWebAudioVolume`, `getWebAudioVolume`, `resumeAudioContext`, `shouldUseWebAudio` | Removed (internal); `getWebAudioSupport` and `unlockAudio` remain |
| `AudioErrorType.Permission`                                                                                                                           | `AudioErrorType.AutoplayBlocked`                                  |
| `TimerType`, `GLOBAL_PROGRESS_KEY`                                                                                                                    | Removed                                                           |
| Types `RetryConfig`, `ErrorRecoveryOptions`, `ExtendedAudioQueueChannel`, `WebAudioConfig`, `WebAudioNodeSet`, `ChannelFadeState`                     | Removed                                                           |

## New

- `createAudioQueue(config)` and `getDefaultAudioQueue()` for independent queues.
- `unlockAudio()` to start blocked audio from your own click handler.
- Config options `loadTimeoutMs`, `prefetchCount`, `logger`, `maxChannels`, `webAudio`.
- Item option `crossOrigin`.
- Importing the package has no side effects (safe for SSR), and the package ships both ES modules
  and CommonJS.
