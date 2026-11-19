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
- Crossfade between items: `setCrossfade`
- Audio sprites: `endAt`, `defineSprite`
- Captions, lyrics, lip-sync: `cues` + `onAudioCue`, WebVTT files via `parseWebVtt`
- Caching / offline: `preloadAudio`, `isAudioPreloaded`, `releasePreloadedAudio`
- UI framework state: `createChannelStore` (React `useSyncExternalStore`, Svelte, Vue, Solid)
- Muting that keeps volumes: `setMuted`, `setChannelMuted`
- Stereo panning: `setChannelPan`
- Visualizer data: `getChannelAnalyser`

Not planned as APIs (a timer does it; recipes are in the README):
- Sleep timer
- Scheduled playback at a predetermined time

Potential New Package Features:
- Sample-accurate gapless playback. Needs decoding whole files into Web Audio buffers (memory
  heavy; specialist libraries like gapless-5 do this). `setCrossfade(channel, 50)` hides the
  small gap between items for most music.
- Accessibility - audio descriptions (a second channel with ducking already covers most uses)

Potential New Dev Features:
- Debug and analytics mode

Needs real-device testing:
- iOS Safari: preloaded files (blob: URLs) play, including ones served as application/octet-stream
- iOS Safari: whether every new audio element needs its own user gesture (if so, keep a small
  pool of elements unlocked on the first tap, like Howler does)
- iOS: AudioContext "interrupted" state after phone calls and Siri
- Android Chrome: deferred media loading in background tabs vs `loadTimeoutMs`
