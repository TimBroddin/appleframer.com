# Video Framing — Design

**Date:** 2026-08-10
**Status:** Approved

## Problem

AppleFramer frames screenshots but not screen recordings. App Store previews are
videos, so anyone producing store assets currently does the stills here and the
video somewhere else.

PR #1 ("Add video transcoding", draft since May 2025) attempted this with
ffmpeg.wasm. It cannot be merged: it is WIP, it conflicts with `main`, and it
edits `FramePreview.tsx` — deleted in the redesign — and `ScreenshotFramer.tsx`,
which was rewritten. This design rebuilds the feature the PR wanted on the
current architecture, and does not use ffmpeg.

## Why not ffmpeg.wasm

ffmpeg.wasm needs `SharedArrayBuffer`, which needs cross-origin isolation
(`COOP: same-origin` + `COEP: require-corp`) site-wide. Two measured
consequences:

1. The PR set those headers in `vite.config.ts`, which affects the dev server
   only. There is no `_headers` file, so video would have worked locally and
   failed silently in production.
2. Enabling isolation would break working parts of the site. Neither
   `stats.titans.sh/api/script.js` (`index.html:82`) nor
   `www.titansofindustry.be/project-menu.js` (`index.html:90`) sends
   `Cross-Origin-Resource-Policy`; under `require-corp` both are blocked, as are
   Google Fonts. This was verified by inspecting the responses, not assumed.

Avoiding isolation entirely removes both problems and keeps analytics and the
project menu untouched. That rules out threaded ffmpeg.wasm, and single-threaded
ffmpeg.wasm costs a ~32 MB runtime download — which also sits badly against the
"nothing leaves your browser" pitch — while running slowly.

WebCodecs is used instead: the browser's own encoders and decoders, exposed to
JavaScript. It needs no isolation, adds ~40 KB rather than 32 MB, and is
hardware-accelerated.

The decisive reason is architectural. A decoded `VideoFrame` is `drawImage`-able,
so compositing runs through the **existing** `renderFrameToCanvas`. Device
framing stays in one place, shared by stills and video. The ffmpeg approach
re-expresses the same compositing as a `filter_complex` string — a second
implementation of "put the screenshot in the bezel" that drifts from the first.
The redesign already collapsed exactly this kind of duplicate render path
(`renderFrame.ts:5-9`); reintroducing one would undo that.

The cost is browser support: Chrome/Edge, Safari 16.4+, Firefox 130+. Older
browsers get an explicit message, never a silent failure.

## Scope

A dropped video becomes a queue item like any image — auto-detected device,
inspector, preview, prev/next — and exports as MP4 with its audio preserved. One
video encodes at a time.

Out of scope: videos in the contact sheet (a still grid of a video means
nothing), trimming, speed changes, and per-video background overrides.

## Architecture

`RenderStatus` gains `'encoding'`. `QueueItem` gains optional video metadata:

```ts
export type RenderStatus =
  | 'detecting' | 'queued' | 'rendering' | 'encoding'
  | 'done' | 'error' | 'unmatched';

export interface QueueItem {
  // ...existing fields
  /** Present only for video items; drives the encode progress indicator. */
  video?: { duration: number; frameCount: number; progress: number };
}
```

New module `src/lib/renderVideo.ts` owns the encode loop and nothing else:

```
demux (mp4box.js) → decode (VideoDecoder) → composite (renderFrameToCanvas)
                  → encode (VideoEncoder) → mux (mp4-muxer)
```

Audio bypasses compositing entirely: demux, decode, re-encode to AAC, feed the
muxer in parallel. It never touches the canvas.

Two new dependencies, ~40 KB combined: `mp4box.js` (WebCodecs decodes but does
not parse containers) and `mp4-muxer` (it emits chunks, not files).

## Changes to `renderFrame.ts`

Both additive; existing image callers are unaffected.

**Widen the source type.** The contract is already "anything `drawImage` accepts
and that reports intrinsic dimensions", which `VideoFrame` satisfies:

```ts
export type ImageSource = ImageBitmap | HTMLImageElement | VideoFrame;
```

`VideoFrame` exposes `displayWidth`/`displayHeight` rather than
`width`/`height`, so the two reads of `screenImg.width`/`.height`
(`renderFrame.ts:126-127`) go through an accessor that prefers the display
dimensions when present:

```ts
const sourceWidth = (src: ImageSource) =>
  'displayWidth' in src ? src.displayWidth : src.width;
```

`displayWidth` is the correct choice over `codedWidth`: coded dimensions are
padded to macroblock boundaries and would introduce edge artifacts.

**Accept a reusable temp canvas.** `renderFrameToCanvas` creates a temp canvas
per call (`renderFrame.ts:116`). Irrelevant for one screenshot; at 30fps it is
~1,800 allocations per minute and would dominate encode time. Add an optional
`scratchCanvas` to `RenderOptions` so the encode loop supplies one canvas for
the whole video. When omitted, behaviour is exactly as today.

## `renderVideoToBlob`

One exported function, no React and no module state, mirroring the existing
`renderFrameToBlob` so the two read as siblings:

```ts
export async function renderVideoToBlob(
  file: File,
  frame: DeviceFrame,
  opts?: {
    backgroundColor?: string | null;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  }
): Promise<Blob>
```

Output is sized to the **frame's** dimensions, not the video's, matching stills.
It allocates one canvas and one scratch canvas and reuses both for every frame.

Every decoded frame is closed in a `finally`:

```ts
try {
  await renderFrameToCanvas(canvas, videoFrame, frame, { backgroundColor, scratchCanvas });
  encoder.encode(new VideoFrame(canvas, { timestamp: videoFrame.timestamp }));
} finally {
  videoFrame.close();
}
```

`VideoFrame` holds GPU memory that is not garbage collected. A missed `close()`
exhausts memory only on long videos, which makes it the most likely
hard-to-diagnose bug here — hence `finally`, not a trailing call.

Decoding outruns encoding on long footage, so the loop waits on
`encoder.encodeQueueSize` before decoding further. Without backpressure, frames
accumulate until the tab dies. Both of these are correct by construction rather
than by testing, because the failure only appears at durations too long to test
routinely.

## Queue integration

`useRenderQueue` already picks one `'queued'` item at a time, so "one video at a
time" is the existing behaviour, not a new scheduler. The change is a branch on
file type: video items call `renderVideoToBlob` with an `onProgress` that flows
through the existing `patchItem`.

The first decoded frame is set as `previewUrl`, so cards, the inspector, device
detection, zoom and prev/next work unchanged.

## Error handling

**Unsupported browser.** Feature-detect at load: `typeof window.VideoEncoder !==
'undefined'` *and* `VideoEncoder.isConfigSupported()` for H.264, since presence
does not imply codec support. When absent, videos are rejected at drop naming
the requirement (Safari 16.4+, Firefox 130+).

**Cancellation.** The existing `AbortSignal` convention carries over, checked
each frame. Decoder and encoder are closed in `finally`; removing a video
mid-encode must not leave a running encoder.

**Failures.** Corrupt files, unsupported input codecs (HEVC or ProRes from a Mac
recording is realistic), and dimensions matching no device all land in the
existing `'error'` and `'unmatched'` states with specific messages. An unmatched
video behaves exactly like an unmatched screenshot: the user picks a device in
the inspector. No new error UI.

**Slowness is expected.** A minute of 4K is real work. Progress reporting is
what makes that read as working rather than hung.

## Testing

`bun test` covers the pure logic: device matching for video dimensions, output
filename derivation, progress arithmetic, and the abort path.

Encoding needs a real browser. A Playwright case follows `test_final.py` from
the session handoff: drop a video, wait for `'done'`, assert a valid MP4 with the
frame's dimensions and an intact audio track. Per repo convention the feature is
not claimed to work until that has actually run and passed.

Cross-browser matters more than usual here — the handoff notes only headless
Chromium has ever been exercised, and WebCodecs codec support genuinely differs
across browsers. Safari and Firefox need a manual pass.
