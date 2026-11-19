Done in 3.0:
- Audio seeking: `seekTo`, `seekBy`, `startAt`
- Repeat entire queue: `setRepeatMode(channel, 'all')` (and `'one'`)
- Playback speed control without pitch change: `setPlaybackRate`, item `playbackRate`
- Shuffle mode: `shuffleQueue`
- Delayed playback between tracks: `setChannelGap`
- History with completion info: `getHistory` (`reason`, `playedMs`, `finishedAt`)
- Media Session API: `connectMediaSession`
- Loading state: `AudioInfo.isLoading`
- Memory management: elements only for the playing and next items, released when they leave
- Playlist helpers: `metadata`, `interrupt`, `dedupeMs`, Blob/File sources, `pauseWhenHidden`

Not planned as APIs (a timer does it; recipes are in the README):
- Sleep timer
- Scheduled playback at a predetermined time

Potential New Package Features:
- Crossfade between items (needs two elements playing at once per channel)
- Gapless playback (Web Audio buffer scheduling)
- Accessibility - audio descriptions, closed captions (cue events from item metadata)
- Audio sprites (many short sounds in one file)

Potential New Dev Features:
- Debug and analytics mode
- Caching system (the browser HTTP cache already covers most cases; revisit for offline apps)

Needs real-device testing:
- iOS Safari: whether every new audio element needs its own user gesture (if so, keep a small
  pool of elements unlocked on the first tap, like Howler does)
- iOS: AudioContext "interrupted" state after phone calls and Siri
- Android Chrome: deferred media loading in background tabs vs `loadTimeoutMs`
