# NetEase playback sync

Android reads only the MediaSession published by `com.netease.cloudmusic`. It does not use a NetEase cookie, accessibility, screen capture, audio recording, usage access, or storage access.

## Data flow

```text
NotificationListenerService
  -> allowlisted MediaController callbacks
  -> deterministic playback state machine
  -> Room playback_events outbox
  -> unique WorkManager sync
  -> POST /api/music/events/batch
  -> zxtoolkit D1 append-only events
  -> Runtime privacy projection
  -> zxlab /status
```

The Android callback never waits for a network request. A new local event schedules one unique, network-constrained worker. The existing periodic worker remains the recovery path after process death or extended offline use. No foreground service, wake lock, background WebSocket, alarm loop, or expedited-work loop is used.

Events are idempotent by `(device_id, event_id)`. The server derives current playback from the latest accepted event instead of trusting a mutable client-owned row. Requests are limited to 100 events. Synced local events are retained for 30 days; repeated permanent failures enter `dead_letter` after 20 attempts.

## Permission and privacy

The user explicitly enables Android notification access and a separate NetEase capture switch. The notification listener filters the package before reading metadata. Only title, artist, album, duration, playback state, position, and an HTTPS artwork URL are accepted. `content://` artwork, notification text, credentials, and raw Bundles are never uploaded or logged.

The public Status projection contains current or recent track metadata and coarse daily counters because this installation is personal. Exact event history remains behind device authentication at `/api/music/now-playing`; there is no public history endpoint.

## Power model

- Media callbacks are event-driven and exist only through Android's notification-listener lifecycle.
- Repeated metadata is deduplicated in memory.
- Position checkpoints are not polled in the MVP.
- Immediate upload is a unique WorkManager task with exponential backoff.
- Periodic recovery runs at Android's 15-minute minimum and requires network plus a non-low battery.
- The foreground inbox WebSocket is disconnected in `MainActivity.onStop`.

These constraints favor delayed delivery over process pinning. Android may defer periodic work under Doze; persisted Room events remain authoritative until the next permitted sync.
