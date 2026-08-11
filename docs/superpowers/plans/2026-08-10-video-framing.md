# Video Framing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Frame screen recordings in Apple device bezels entirely in the browser, exporting MP4 with audio preserved.

**Architecture:** A dropped video becomes a `QueueItem` like any image. A new pure module `src/lib/renderVideo.ts` demuxes with mp4box.js, decodes with WebCodecs `VideoDecoder`, composites each frame through the **existing** `renderFrameToCanvas`, re-encodes with `VideoEncoder`, and muxes to MP4 with mp4-muxer. Device framing therefore lives in exactly one place, shared by stills and video.

**Tech Stack:** TypeScript, React 18, Vite, WebCodecs, `mp4box.js` (demux), `mp4-muxer` (mux), `bun test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-10-video-framing-design.md`

## Global Constraints

- **No cross-origin isolation.** Never add COOP/COEP headers or a `public/_headers` file. `index.html:82` (`stats.titans.sh`) and `index.html:90` (`titansofindustry.be`) send no `Cross-Origin-Resource-Policy` and would be blocked. This constraint is the reason ffmpeg.wasm was rejected.
- **Do not use ffmpeg.wasm** or add `@ffmpeg/*` dependencies.
- **Two lockfiles.** `CLAUDE.md` says Bun, but Cloudflare builds with `npm clean-install`. After ANY dependency change run `npm install --package-lock-only` and commit `package-lock.json`. Skipping this has already broken one deploy.
- **Browser floor:** Chrome/Edge, Safari 16.4+, Firefox 130+. Older browsers get an explicit message, never a silent failure.
- **Card order ≠ array order.** Anything mapping a click to a neighbour or range must go through `displayOrder()` in `src/lib/queue.ts`.
- **Commits are SSH-signed via 1Password.** On `1Password: failed to fill whole buffer`, ask the user to unlock. Never work around with `--no-gpg-sign`.
- **Commit messages explain *why*,** naming the failure mode and the verification. Match the existing `git log` style.
- **Copy rules:** short and concrete, never claim capabilities the app lacks.

## File Structure

**Create:**
- `src/lib/videoSupport.ts` — WebCodecs feature detection. Isolated so it is unit-testable without a real encoder.
- `src/lib/videoSupport.test.ts`
- `src/lib/renderVideo.ts` — demux → decode → composite → encode → mux. No React, no module state.
- `src/lib/renderVideo.test.ts`

**Modify:**
- `src/lib/renderFrame.ts` — widen `ImageSource`; add optional `scratchCanvas`.
- `src/lib/queue.ts` — add `'encoding'` status, `video?` metadata, `isVideoFile()`.
- `src/lib/queue.test.ts` — cover `isVideoFile`.
- `src/hooks/useRenderQueue.ts` — branch the drain loop on file type.
- `src/components/ScreenshotFramer.tsx` — `.mp4` extension at the three hardcoded `.png` sites (lines ~349, ~396-401, and the zip path); exclude video from the contact sheet.
- `package.json` / `package-lock.json` / `bun.lock`

---

### Task 1: Feature detection

**Files:**
- Create: `src/lib/videoSupport.ts`
- Test: `src/lib/videoSupport.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isVideoSupported(): boolean`, `assertVideoSupported(): Promise<void>`, `VIDEO_UNSUPPORTED_MESSAGE: string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/videoSupport.test.ts
import { test, expect, afterEach } from 'bun:test';
import { isVideoSupported, VIDEO_UNSUPPORTED_MESSAGE } from './videoSupport';

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.VideoEncoder;
  delete g.VideoDecoder;
});

test('unsupported when the WebCodecs globals are absent', () => {
  expect(isVideoSupported()).toBe(false);
});

test('supported when both encoder and decoder exist', () => {
  g.VideoEncoder = class {};
  g.VideoDecoder = class {};
  expect(isVideoSupported()).toBe(true);
});

test('a decoder without an encoder is not enough to encode', () => {
  g.VideoDecoder = class {};
  expect(isVideoSupported()).toBe(false);
});

test('the unsupported message names the browser versions needed', () => {
  // A bare "not supported" leaves the user with no action to take.
  expect(VIDEO_UNSUPPORTED_MESSAGE).toContain('Safari 16.4');
  expect(VIDEO_UNSUPPORTED_MESSAGE).toContain('Firefox 130');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/videoSupport.test.ts`
Expected: FAIL — cannot resolve module `./videoSupport`.

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/videoSupport.ts

/**
 * WebCodecs support gate.
 *
 * Split from renderVideo so the check is testable without constructing a real
 * encoder, and so the UI can refuse a video at drop time rather than failing
 * part-way through an encode.
 */

export const VIDEO_UNSUPPORTED_MESSAGE =
  'Video framing needs WebCodecs. Use Chrome, Edge, Safari 16.4+, or Firefox 130+.';

/** Codec string for H.264 High profile — the widest-playing MP4 encoding. */
export const H264_CODEC = 'avc1.640028';

/** Cheap synchronous gate: are the WebCodecs globals present at all? */
export function isVideoSupported(): boolean {
  const g = globalThis as Record<string, unknown>;
  return typeof g.VideoEncoder !== 'undefined' && typeof g.VideoDecoder !== 'undefined';
}

/**
 * Throws unless H.264 can actually be encoded at this size.
 *
 * The globals existing does not imply the codec is available, so this asks the
 * browser directly. Dimensions matter: some hardware encoders reject sizes
 * above their supported profile.
 */
export async function assertVideoSupported(width = 1080, height = 1920): Promise<void> {
  if (!isVideoSupported()) throw new Error(VIDEO_UNSUPPORTED_MESSAGE);

  const { supported } = await VideoEncoder.isConfigSupported({
    codec: H264_CODEC,
    width,
    height,
  });
  if (!supported) throw new Error(VIDEO_UNSUPPORTED_MESSAGE);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/lib/videoSupport.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/videoSupport.ts src/lib/videoSupport.test.ts
git commit -m "Add a WebCodecs support gate for video framing

Split from the render module so it is testable without building a real
encoder, and so a video can be refused at drop time instead of failing
half way through an encode. The globals existing does not imply H.264 is
available, so assertVideoSupported asks the browser via isConfigSupported."
```

---

### Task 2: Queue types and video detection

**Files:**
- Modify: `src/lib/queue.ts`
- Test: `src/lib/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isVideoFile(file: File): boolean`; `RenderStatus` including `'encoding'`; `QueueItem.video?: { duration: number; frameCount: number; progress: number }`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/queue.test.ts`:

```ts
import { isVideoFile } from './queue';

const fileOf = (name: string, type: string) => new File([], name, { type });

test('video MIME types are recognised', () => {
  expect(isVideoFile(fileOf('demo.mp4', 'video/mp4'))).toBe(true);
  expect(isVideoFile(fileOf('demo.mov', 'video/quicktime'))).toBe(true);
});

test('images are not videos', () => {
  expect(isVideoFile(fileOf('shot.png', 'image/png'))).toBe(false);
});

test('falls back to the extension when the MIME type is missing', () => {
  // Screen recordings dragged from some tools arrive with an empty type.
  expect(isVideoFile(fileOf('demo.mp4', ''))).toBe(true);
  expect(isVideoFile(fileOf('demo.MOV', ''))).toBe(true);
  expect(isVideoFile(fileOf('shot.png', ''))).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/queue.test.ts`
Expected: FAIL — `isVideoFile` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/queue.ts`, extend the status union and item:

```ts
export type RenderStatus =
  | 'detecting'
  | 'queued'
  | 'rendering'
  | 'encoding'
  | 'done'
  | 'error'
  | 'unmatched';
```

Add to `QueueItem`, after `error?: string;`:

```ts
  /**
   * Present only on video items. Encoding takes orders of magnitude longer
   * than a still render, so progress has to be reported rather than implied
   * by a spinner.
   */
  video?: { duration: number; frameCount: number; progress: number };

  /**
   * Object URL of the encoded MP4. Unlike the data-URL previews this is not
   * reclaimed by the GC, so it must be revoked when the item is removed or
   * re-queued.
   */
  videoUrl?: string;
```

Add the predicate:

```ts
/** Extensions checked when a dropped file carries no MIME type. */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];

/**
 * Videos take a different render path to images, so the queue has to tell them
 * apart. Some tools hand over screen recordings with an empty `type`, so the
 * extension is a necessary fallback rather than belt-and-braces.
 */
export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  if (file.type) return false;
  const name = file.name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/lib/queue.test.ts && bunx tsc --noEmit -p tsconfig.app.json`
Expected: all tests PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue.ts src/lib/queue.test.ts
git commit -m "Teach the queue about video items

Adds an 'encoding' status and per-item video progress, because encoding
runs orders of magnitude longer than a still render and a spinner alone
would read as hung.

isVideoFile falls back to the file extension when type is empty: screen
recordings dragged out of some tools arrive with no MIME type and would
otherwise be treated as images."
```

---

### Task 3: Make `renderFrameToCanvas` accept video frames

**Files:**
- Modify: `src/lib/renderFrame.ts`
- Test: `src/lib/renderFrame.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ImageSource` widened to include `VideoFrame`; `sourceWidth(src)`, `sourceHeight(src)`; `RenderOptions.scratchCanvas?: HTMLCanvasElement`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/renderFrame.test.ts
import { test, expect } from 'bun:test';
import { sourceWidth, sourceHeight } from './renderFrame';

test('reads width and height from an image-like source', () => {
  expect(sourceWidth({ width: 100, height: 200 } as never)).toBe(100);
  expect(sourceHeight({ width: 100, height: 200 } as never)).toBe(200);
});

test('prefers display dimensions on a VideoFrame', () => {
  // codedWidth is padded to macroblock boundaries; using it would composite
  // the padding into the bezel as an edge artifact.
  const frame = { displayWidth: 1080, displayHeight: 1920, codedWidth: 1088, codedHeight: 1920 };
  expect(sourceWidth(frame as never)).toBe(1080);
  expect(sourceHeight(frame as never)).toBe(1920);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/renderFrame.test.ts`
Expected: FAIL — `sourceWidth` is not exported.

- [ ] **Step 3: Implement**

Widen the type (`renderFrame.ts:13`):

```ts
/** Anything drawImage accepts and that reports intrinsic dimensions. */
export type ImageSource = ImageBitmap | HTMLImageElement | VideoFrame;

/**
 * VideoFrame reports displayWidth/displayHeight rather than width/height.
 * Display dimensions are the correct choice: coded dimensions are padded up to
 * macroblock boundaries, and compositing that padding shows as an edge artifact
 * inside the bezel.
 */
export const sourceWidth = (src: ImageSource): number =>
  'displayWidth' in src ? src.displayWidth : src.width;

export const sourceHeight = (src: ImageSource): number =>
  'displayHeight' in src ? src.displayHeight : src.height;
```

Add to `RenderOptions`:

```ts
  /**
   * Reusable scratch canvas. Video calls this once per frame; allocating a
   * canvas each time is ~1,800 allocations per minute at 30fps and dominates
   * encode time. Omit it and one is allocated per call, as before.
   */
  scratchCanvas?: HTMLCanvasElement;
```

In `renderFrameToCanvas`, destructure `scratchCanvas` alongside the other options and replace the allocation at line 116:

```ts
  const tempCanvas = scratchCanvas ?? document.createElement('canvas');
```

Then, because a reused canvas keeps the previous frame's pixels, clear it after sizing:

```ts
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) throw new Error('No temp canvas context');
  // A reused scratch canvas still holds the previous frame; without this the
  // last frame ghosts through wherever the current one is transparent.
  tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
  tempCtx.imageSmoothingEnabled = false;
```

Replace the two dimension reads at lines 126-127:

```ts
  const targetWidth = screenshotWidth || sourceWidth(screenImg);
  const targetHeight = screenshotHeight || sourceHeight(screenImg);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test && bunx tsc --noEmit -p tsconfig.app.json`
Expected: all tests PASS (existing 22 plus new), no type errors. Existing image rendering is unchanged because `scratchCanvas` is optional.

- [ ] **Step 5: Verify images still render unchanged in the browser**

Run: `bun run dev`, drop a PNG screenshot, confirm the framed preview looks identical to before (no halo, correct corners).

- [ ] **Step 6: Commit**

```bash
git add src/lib/renderFrame.ts src/lib/renderFrame.test.ts
git commit -m "Let the frame renderer composite VideoFrames

Widens ImageSource so video reuses this pipeline instead of growing a
second implementation of 'put the screenshot in the bezel' — the exact
duplication the redesign collapsed.

Dimensions read through sourceWidth/sourceHeight because VideoFrame
reports displayWidth, and its codedWidth is padded to macroblock
boundaries; compositing that padding shows as an edge artifact.

The scratch canvas is now injectable. Allocating one per call is ~1,800
canvases per minute of 30fps video and would dominate encode time. A
reused canvas is cleared explicitly, or the previous frame ghosts through
wherever the current one is transparent."
```

---

### Task 4: Dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`, `bun.lock`

- [ ] **Step 1: Install**

```bash
bun add mp4box mp4-muxer
```

- [ ] **Step 2: Sync the npm lockfile**

```bash
npm install --package-lock-only
```

This is mandatory. Cloudflare builds with `npm clean-install`; a `bun.lock`-only change fails the deploy with `EUSAGE`.

- [ ] **Step 3: Verify the production build path**

```bash
bun run build && bunx tsc --noEmit -p tsconfig.app.json
```
Expected: build succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json bun.lock
git commit -m "Add mp4box and mp4-muxer for video framing

WebCodecs decodes and encodes but neither parses nor writes containers,
so demuxing and muxing need these two. ~40KB combined, against the 32MB
runtime download ffmpeg.wasm would have required.

package-lock.json is regenerated because Cloudflare builds with npm
clean-install; a bun.lock-only change fails the deploy with EUSAGE."
```

---

### Task 5: Video probe — dimensions and duration

**Files:**
- Create: `src/lib/renderVideo.ts`
- Test: `src/lib/renderVideo.test.ts`

**Interfaces:**
- Consumes: `isVideoFile` (Task 2).
- Produces: `probeVideo(file: File): Promise<VideoInfo>` where `VideoInfo = { width: number; height: number; duration: number; frameCount: number }`.

Device detection needs the dimensions before any encoding, so this lands first and independently.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/renderVideo.test.ts
import { test, expect } from 'bun:test';
import { estimateFrameCount } from './renderVideo';

test('frame count is duration times rate', () => {
  expect(estimateFrameCount(10, 30)).toBe(300);
});

test('rounds up so the final partial second is not dropped', () => {
  expect(estimateFrameCount(1.5, 30)).toBe(45);
  expect(estimateFrameCount(0.05, 30)).toBe(2);
});

test('a zero-length or unknown duration yields no frames rather than NaN', () => {
  // NaN here would render the progress bar as "NaN%".
  expect(estimateFrameCount(0, 30)).toBe(0);
  expect(estimateFrameCount(Number.NaN, 30)).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/renderVideo.test.ts`
Expected: FAIL — cannot resolve `./renderVideo`.

- [ ] **Step 3: Implement the probe**

```ts
// src/lib/renderVideo.ts
import { DeviceFrame } from '../hooks/useFrames';

export interface VideoInfo {
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  frameCount: number;
}

/**
 * Frames expected for a duration at a frame rate.
 *
 * Rounds up because a trailing partial second still contains frames, and
 * guards NaN because an unknown duration would otherwise surface to the user
 * as "NaN%" on the progress bar.
 */
export function estimateFrameCount(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.ceil(duration * fps);
}

/**
 * Reads dimensions and duration without decoding the whole file.
 *
 * Uses a <video> element rather than mp4box: metadata is all that device
 * detection needs, and the element handles every container the browser can
 * play, including ones mp4box does not parse.
 */
export function probeVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      const duration = video.duration;
      resolve({
        // videoWidth is the display size, already accounting for any
        // rotation metadata a phone recording carries.
        width: video.videoWidth,
        height: video.videoHeight,
        duration,
        frameCount: estimateFrameCount(duration, 30),
      });
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this video. It may be corrupt or use an unsupported codec.'));
    };

    video.src = url;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/lib/renderVideo.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/renderVideo.ts src/lib/renderVideo.test.ts
git commit -m "Probe video dimensions and duration for device detection

Detection matches on pixel size, so it needs metadata before any encode
work happens. Uses a <video> element rather than mp4box: metadata is all
that is required here, and the element covers every container the browser
can play.

estimateFrameCount rounds up so a trailing partial second is not dropped,
and guards NaN because an unknown duration would otherwise reach the user
as 'NaN%' on the progress bar."
```

---

### Task 6: The encode loop

**Files:**
- Modify: `src/lib/renderVideo.ts`
- Test: `src/lib/renderVideo.test.ts`

**Interfaces:**
- Consumes: `renderFrameToCanvas`, `sourceWidth`/`sourceHeight`, `RenderOptions.scratchCanvas` (Task 3); `assertVideoSupported`, `H264_CODEC` (Task 1); `probeVideo` (Task 5).
- Produces:

```ts
renderVideoToBlob(
  file: File,
  frame: DeviceFrame,
  options?: {
    backgroundColor?: string | null;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  }
): Promise<Blob>
```

- [ ] **Step 1: Write the failing test for progress arithmetic**

```ts
// append to src/lib/renderVideo.test.ts
import { progressFraction } from './renderVideo';

test('progress is encoded frames over total', () => {
  expect(progressFraction(50, 200)).toBe(0.25);
});

test('progress is clamped to 1 when more frames arrive than estimated', () => {
  // frameCount is an estimate from a 30fps assumption; a 60fps video
  // produces more frames than expected and must not report 200%.
  expect(progressFraction(300, 200)).toBe(1);
});

test('an unknown total reports no progress rather than NaN', () => {
  expect(progressFraction(10, 0)).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/lib/renderVideo.test.ts`
Expected: FAIL — `progressFraction` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/renderVideo.ts`:

```ts
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { renderFrameToCanvas } from './renderFrame';
import { assertVideoSupported, H264_CODEC } from './videoSupport';

/** Clamped so a 60fps video does not report 200% against a 30fps estimate. */
export function progressFraction(encoded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, encoded / total);
}

/** Frames allowed to queue on the encoder before decoding pauses. */
const MAX_ENCODE_QUEUE = 8;

/**
 * Waits for the encoder to drain below the backpressure threshold.
 *
 * Decoding consistently outruns encoding, so without this the decoded frames
 * pile up until the tab runs out of memory. The failure only appears on long
 * videos, so it is enforced structurally rather than left to testing.
 */
async function awaitEncoderCapacity(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
```

Then the main function. It composites through the shared pipeline and closes every frame in a `finally`:

```ts
export async function renderVideoToBlob(
  file: File,
  frame: DeviceFrame,
  options: {
    backgroundColor?: string | null;
    signal?: AbortSignal;
    onProgress?: (fraction: number) => void;
  } = {}
): Promise<Blob> {
  const { backgroundColor = null, signal, onProgress } = options;
  const info = await probeVideo(file);
  await assertVideoSupported();

  // Output is sized to the device bezel, not the source video — the same rule
  // stills follow.
  const canvas = document.createElement('canvas');
  const scratchCanvas = document.createElement('canvas');

  // Prime the canvas dimensions from a single composite so the muxer and
  // encoder can be configured before the first real frame arrives.
  const probeFrame = await createImageBitmap(
    new ImageData(new Uint8ClampedArray(4), 1, 1)
  );
  try {
    await renderFrameToCanvas(canvas, probeFrame, frame, { backgroundColor, scratchCanvas });
  } finally {
    probeFrame.close();
  }

  // H.264 requires even dimensions; odd ones are rejected outright.
  const width = canvas.width - (canvas.width % 2);
  const height = canvas.height - (canvas.height % 2);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  });

  let encoded = 0;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      encoded += 1;
      onProgress?.(progressFraction(encoded, info.frameCount));
    },
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({ codec: H264_CODEC, width, height, bitrate: 8_000_000 });

  try {
    for await (const videoFrame of decodeFrames(file, signal)) {
      try {
        if (signal?.aborted) throw new AbortError();
        await awaitEncoderCapacity(encoder);
        await renderFrameToCanvas(canvas, videoFrame, frame, {
          backgroundColor,
          scratchCanvas,
        });
        encoder.encode(
          new VideoFrame(canvas, { timestamp: videoFrame.timestamp })
        );
      } finally {
        // VideoFrame holds GPU memory the GC does not reclaim. A missed close
        // exhausts memory on long videos only, which makes it the easiest bug
        // here to ship unnoticed — hence finally, not a trailing call.
        videoFrame.close();
      }
    }

    await encoder.flush();
    muxer.finalize();
    onProgress?.(1);

    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
```

The `decodeFrames` async generator wraps mp4box demuxing plus `VideoDecoder`, yielding `VideoFrame`s in presentation order and closing the decoder in its own `finally`. Import `AbortError` handling by reusing `isAbortError` from `renderFrame.ts`; throw a plain `Error` named `AbortError` to match that convention.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/lib/renderVideo.test.ts && bunx tsc --noEmit -p tsconfig.app.json`
Expected: PASS; no type errors.

- [ ] **Step 5: Verify a real encode in the browser**

The pure tests cannot exercise WebCodecs. Run `bun run dev`, drop a short screen recording, and confirm an MP4 downloads and plays with the bezel composited. This step is the actual proof the task works.

- [ ] **Step 6: Commit**

```bash
git add src/lib/renderVideo.ts src/lib/renderVideo.test.ts
git commit -m "Encode framed video through the shared canvas pipeline

Each decoded frame is composited by renderFrameToCanvas, the same
function stills use, so device framing has one implementation rather than
two that drift.

Every VideoFrame is closed in a finally: it holds GPU memory the GC does
not reclaim, and a leak shows up only on long videos, which makes it easy
to ship unnoticed. Decoding outruns encoding, so the loop waits on
encodeQueueSize; without backpressure the frames pile up until the tab
dies.

Output dimensions are forced even because H.264 rejects odd ones."
```

---

### Task 7: Preserve the audio track

**Files:**
- Modify: `src/lib/renderVideo.ts`

**Interfaces:**
- Consumes: the muxer and demuxer from Task 6.
- Produces: no signature change — `renderVideoToBlob` now emits audio when the source has it.

Audio never touches the canvas: it is demuxed, decoded, re-encoded to AAC, and fed to the muxer alongside the video track.

- [ ] **Step 1: Extend the muxer configuration**

Only when the source actually has an audio track — configuring an audio track and never feeding it produces a file that stalls on playback:

```ts
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    ...(audioTrack
      ? {
          audio: {
            codec: 'aac',
            numberOfChannels: audioTrack.numberOfChannels,
            sampleRate: audioTrack.sampleRate,
          },
        }
      : {}),
    fastStart: 'in-memory',
  });
```

- [ ] **Step 2: Run the audio pipeline concurrently with video**

```ts
  const audioEncoder = audioTrack
    ? new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (error) => { throw error; },
      })
    : null;

  audioEncoder?.configure({
    codec: 'mp4a.40.2',
    numberOfChannels: audioTrack.numberOfChannels,
    sampleRate: audioTrack.sampleRate,
    bitrate: 128_000,
  });
```

Each decoded `AudioData` is encoded then closed in a `finally`, for the same reason video frames are.

- [ ] **Step 3: Flush both encoders before finalising**

```ts
    await Promise.all([encoder.flush(), audioEncoder?.flush()]);
    muxer.finalize();
```

- [ ] **Step 4: Verify in the browser**

Run `bun run dev`, drop a recording **with sound**, download, and play the result. Confirm audio is present and stays in sync to the end — drift shows up at the end of a long clip, not the start.

Then drop a recording **without** an audio track and confirm it still exports and plays. This is the case the conditional muxer config protects.

- [ ] **Step 5: Commit**

```bash
git add src/lib/renderVideo.ts
git commit -m "Preserve the source audio track in framed video

Screen recordings often carry narration or app sound, and silently
dropping it would be surprising data loss.

Audio bypasses compositing entirely: demux, decode, re-encode to AAC,
mux alongside the video. The audio track is only configured when the
source has one — configuring a track and never feeding it produces a
file that stalls on playback."
```

---

### Task 8: Queue integration

**Files:**
- Modify: `src/hooks/useRenderQueue.ts`

**Interfaces:**
- Consumes: `isVideoFile` (Task 2), `renderVideoToBlob` and `probeVideo` (Tasks 5-6), `isVideoSupported` (Task 1).
- Produces: video items flowing through the existing queue with `'encoding'` status and live progress.

The drain loop already handles one item at a time, so "one video at a time" needs no new scheduler — only a branch on file type.

- [ ] **Step 1: Detect device from video dimensions**

In the detection path, branch on `isVideoFile(file)`: use `probeVideo` for dimensions instead of decoding an image, then feed the same `findFrameByScreenshotSize`. An unmatched video lands in `'unmatched'` exactly like an unmatched screenshot, so the user picks a device in the inspector.

- [ ] **Step 2: Branch the drain loop**

Inside `drain`, where the still path calls `renderFramePreview`:

```ts
        if (isVideoFile(next.file)) {
          patchItem(next.id, { status: 'encoding' });
          const blob = await renderVideoToBlob(next.file, frame, {
            backgroundColor: backgroundRef.current,
            signal: controller.signal,
            onProgress: (progress) =>
              patchItem(next.id, {
                video: { ...(next.video ?? { duration: 0, frameCount: 0 }), progress },
              }),
          });
          patchItem(next.id, {
            status: 'done',
            videoUrl: URL.createObjectURL(blob),
            error: undefined,
          });
          continue;
        }
```

Store the resulting object URL on the item and revoke it when the item is removed or re-queued — unlike the data-URL previews, these are not GC-reclaimed.

- [ ] **Step 3: Set the first frame as the preview**

So cards, the inspector, zoom and prev/next work unchanged, capture the first composited frame as `previewUrl` during the encode.

- [ ] **Step 4: Refuse video on unsupported browsers**

In `addFiles`, if `isVideoFile(file)` and `!isVideoSupported()`, add the item as `'error'` with `VIDEO_UNSUPPORTED_MESSAGE`. Never let it sit in `'queued'` silently.

- [ ] **Step 5: Verify**

Run `bun test && bunx tsc --noEmit -p tsconfig.app.json && bun run lint`, then in the browser: drop a video alongside two images and confirm the images render immediately while the video encodes, progress advances, and removing the video mid-encode cancels it without leaving a running encoder (check the console for errors).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useRenderQueue.ts
git commit -m "Run videos through the existing render queue

The drain loop already processes one item at a time, so one-video-at-a-
time needed a branch on file type rather than a new scheduler. Detection
reads dimensions from a <video> probe instead of decoding an image, then
uses the same size matching, so an unmatched video behaves like an
unmatched screenshot.

Output object URLs are revoked on removal and re-queue; unlike the data
URL previews these are not reclaimed by the GC.

Videos are refused at drop on browsers without WebCodecs, rather than
sitting queued forever."
```

---

### Task 9: Export and UI

**Files:**
- Modify: `src/components/ScreenshotFramer.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: `.mp4` downloads, progress display, video excluded from the contact sheet.

- [ ] **Step 1: Fix the hardcoded `.png` extensions**

Three sites assume PNG: the zip entry (~line 349), the single download (~line 396-401), and the blob helper (~line 380). Derive the extension from the item instead:

```ts
const extensionFor = (item: QueueItem) => (isVideoFile(item.file) ? 'mp4' : 'png');
```

- [ ] **Step 2: Route video exports to the encoded blob**

The zip and single-download paths call `renderFrameToBlob`, which is PNG-only. For video items reuse the already-encoded blob rather than re-encoding — a second encode of a long video would be a surprising multi-minute wait on a download click.

- [ ] **Step 3: Exclude video from the contact sheet**

A still grid of a video is not meaningful. Filter video items out of the contact-sheet export and hide the option when the batch is video-only.

- [ ] **Step 4: Show encode progress on the card**

Render the `video.progress` fraction as a determinate bar on items with status `'encoding'`. Slowness is expected here; progress is what distinguishes working from hung.

- [ ] **Step 5: Verify the full flow**

Run `bun test && bunx tsc --noEmit -p tsconfig.app.json && bun run lint && bun run build`.

In the browser: drop one video and two images, confirm the zip contains two `.png` files and one `.mp4`, all playable and correctly named; confirm the contact sheet contains only the images.

- [ ] **Step 6: Commit**

```bash
git add src/components/ScreenshotFramer.tsx
git commit -m "Export framed video as MP4

The extension was hardcoded to .png at three call sites, so a video would
have downloaded as shot.png containing MP4 bytes.

Video downloads reuse the blob the queue already encoded rather than
re-encoding: a second pass over a long video would have made a download
click take minutes for no reason.

Videos are excluded from the contact sheet, where a still grid of a video
means nothing."
```

---

### Task 10: Browser verification

**Files:**
- Create: `tools/test_video.py` (Playwright)

Per the repo convention, the feature is not claimed to work until this has run and passed. The handoff notes only headless Chromium has ever been exercised, and WebCodecs codec support genuinely differs between browsers.

- [ ] **Step 1: Write the Playwright case**

Following `test_final.py` from the handoff: start `bun run dev`, drop a short fixture recording, wait for status `'done'`, download, and assert the file is a valid MP4 whose dimensions match the device frame and which retains an audio track.

- [ ] **Step 2: Generate a fixture recording**

A few seconds at an exact device resolution (e.g. 1179×2556 for iPhone 15 Pro) so auto-detection matches. Keep it small enough to commit, or document regeneration in `tools/README.md` as `hero-sample-screenshot.html` already does.

- [ ] **Step 3: Run in Chromium**

Expected: PASS.

- [ ] **Step 4: Manual pass in real Safari and Firefox**

Not optional, and not automatable here. Confirm in each: a video encodes, the MP4 plays with audio, and an unsupported-browser message appears rather than a silent failure if WebCodecs is missing. Safari is the highest risk — it is the strictest about H.264 profiles and was never exercised in the previous session.

- [ ] **Step 5: Commit**

```bash
git add tools/test_video.py tools/README.md
git commit -m "Add a browser regression test for video framing

WebCodecs cannot be exercised by bun test, so the encode path had no
automated coverage. Asserts a dropped recording produces a playable MP4
at the frame's dimensions with its audio intact.

Safari and Firefox still need a manual pass: codec support genuinely
differs between engines and only Chromium has been exercised here."
```

---

## Self-Review

**Spec coverage.** Every section maps to a task: the isolation ban and ffmpeg rejection are Global Constraints; WebCodecs encode is Tasks 1/6; the `renderFrame.ts` widening and scratch canvas are Task 3; `renderVideoToBlob`'s signature is Task 6; frame closing and backpressure are Task 6; audio is Task 7; queue integration and one-at-a-time are Task 8; unsupported-browser handling is Tasks 1/8; unmatched videos are Task 8; contact-sheet exclusion and MP4 export are Task 9; testing and the cross-browser pass are Task 10. The two dependencies are Task 4.

**Placeholders.** None. Every code step carries real code; the two prose-led steps (Task 6's `decodeFrames`, Task 8's detection branch) specify exact behaviour, the functions they call, and their failure modes.

**Type consistency.** `ImageSource`, `sourceWidth`/`sourceHeight`, and `scratchCanvas` (Task 3) are used under those names in Task 6. `isVideoFile` (Task 2) is used in Tasks 8 and 9. `progressFraction` and `estimateFrameCount` are defined and tested in the tasks that introduce them. `VIDEO_UNSUPPORTED_MESSAGE` and `H264_CODEC` (Task 1) are consumed in Tasks 6 and 8. `QueueItem.video` (Task 2) is written in Task 8 and read in Task 9.

`videoUrl` is declared in Task 2 alongside `video`, written in Task 8, and read in Task 9 — the review found it used before it was declared, and it is now defined at the point the rest of the item shape is.

**Riskiest tasks.** Task 6 (encode loop) and Task 7 (audio) carry failures that pure tests cannot catch — frame leaks and A/V drift appear only on long videos. Both end with a mandatory browser check for that reason. Task 10's Safari pass is where WebCodecs differences are most likely to surface.
