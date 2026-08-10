import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { createFile, MP4BoxBuffer, MultiBufferStream } from 'mp4box';
import type { ISOFile, Sample, Track, VisualSampleEntry } from 'mp4box';
import type { DeviceFrame } from '../hooks/useFrames';
import { renderFrameToCanvas } from './renderFrame';
import { assertVideoSupported, H264_CODEC, VIDEO_UNSUPPORTED_MESSAGE } from './videoSupport';

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
      // 30fps is a progress-bar estimate only, not a claim about the video's
      // true frame rate. The real frame count is not knowable without demuxing.
      // Task 6 will clamp progress to 1 precisely because this estimate can be
      // wrong for 60fps or higher-rate videos.
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

/** Clamped so a 60fps video does not report 200% against a 30fps estimate. */
export function progressFraction(encoded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, encoded / total);
}

/**
 * Matches the AbortError renderFrame.ts throws, so isAbortError recognises a
 * cancelled encode and callers can drop it silently instead of showing a toast.
 */
class AbortError extends Error {
  constructor() {
    super('Render aborted');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortError();
}

/** Frames allowed to queue on the encoder before decoding pauses. */
const MAX_ENCODE_QUEUE = 8;

/**
 * Chunks allowed in flight on the decoder before the decode loop waits.
 *
 * Decoded frames are the expensive resource — each is a full-size GPU surface —
 * so this bounds how many exist at once regardless of how long the video is.
 */
const MAX_DECODE_QUEUE = 4;

/**
 * Yields to the event loop so the codec's own callbacks can run.
 *
 * setTimeout rather than a microtask: the codecs deliver output through tasks,
 * so a microtask loop would spin forever without ever letting the queue drain.
 */
const yieldToCodec = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Waits for the encoder to drain below the backpressure threshold.
 *
 * Decoding consistently outruns encoding, so without this the decoded frames
 * pile up until the tab runs out of memory. The failure only appears on long
 * videos, so it is enforced structurally rather than left to testing.
 */
async function awaitEncoderCapacity(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    await yieldToCodec();
  }
}

/**
 * The AVC/HEVC decoder configuration record for a track's sample entry.
 *
 * VideoDecoder cannot start without it: the SPS/PPS live in the container, not
 * in the samples. mp4box only exposes the parsed box, so it is re-serialised
 * and its 8-byte box header sliced off — the record is the box's payload.
 *
 * MultiBufferStream rather than DataStream because mp4box 2.x types avcCBox's
 * write() against the subclass, even though the body only touches DataStream
 * methods. An empty one grows on write exactly like a bare DataStream.
 */
function decoderDescription(entry: VisualSampleEntry): Uint8Array | undefined {
  const config = entry.avcC ?? entry.hvcC ?? entry.av1C ?? entry.vpcC;
  if (!config) return undefined;

  // vpcC is a FullBox, whose writeHeader adds a version byte and 24-bit flags on
  // top of the ordinary 8-byte box header; avcC, hvcC and av1C are plain Boxes.
  // Slicing 8 for vpcC would leave four stray leading bytes.
  const headerSize = config === entry.vpcC ? 12 : 8;

  const stream = new MultiBufferStream();
  config.write(stream);
  return new Uint8Array(stream.buffer.slice(headerSize, stream.byteLength));
}

interface DemuxedTrack {
  track: Track;
  chunks: EncodedVideoChunk[];
  /** AVC/HEVC decoder configuration record, or undefined for codecs without one. */
  description: Uint8Array | undefined;
}

/**
 * Reads every video sample out of `file` as encoded chunks.
 *
 * Extraction has to be configured and started from inside onReady, and the
 * whole file appended in one go. mp4box empties its stream buffers as it parses
 * — once appendBuffer returns, getSample can no longer read sample bytes — so
 * setExtractionOptions/start must run while the append is still in flight.
 * Deferring either to a later turn silently yields zero samples.
 *
 * For the same reason stop() cannot be used for backpressure: a stopped
 * extraction can never resume, and the samples it skipped are lost for good
 * (measured: 9 of 120 delivered). Pacing therefore happens on the decoder,
 * which is where the memory actually is — chunks are compressed bytes the file
 * already occupies, while decoded frames are full-size GPU surfaces.
 */
async function demuxVideoTrack(file: File): Promise<DemuxedTrack> {
  // mp4box parses from buffers rather than streams, and the whole file is
  // already in memory as a File. fileStart is mandatory: mp4box uses it to
  // address buffers as one file, and omitting it parses nothing.
  const source = await file.arrayBuffer();

  const isoFile: ISOFile = createFile();
  const chunks: EncodedVideoChunk[] = [];
  let videoTrack: Track | undefined;
  let demuxError: Error | undefined;

  isoFile.onError = (module, message) => {
    demuxError = new Error(`Could not read this video (${module}): ${message}`);
  };
  isoFile.onSamples = (_id, _user, samples: Array<Sample>) => {
    for (const sample of samples) {
      if (!sample.data) continue;
      chunks.push(
        new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          // Microseconds, and from cts rather than dts: cts is the presentation
          // time, which is what the decoder tags its output with and what the
          // muxer writes. Using dts would misorder B-frames on playback.
          //
          // Rounded because a 15360 timescale does not divide into whole
          // microseconds, and WebCodecs timestamps are integers — left
          // fractional they are truncated, which drifts against the durations.
          timestamp: Math.round((sample.cts * 1e6) / sample.timescale),
          duration: Math.round((sample.duration * 1e6) / sample.timescale),
          data: sample.data,
        })
      );
    }
    // EncodedVideoChunk copied the bytes, so mp4box's own copy is now dead
    // weight; without this the demuxer holds the entire video a second time.
    isoFile.releaseUsedSamples(videoTrack!.id, samples[samples.length - 1].number + 1);
  };
  isoFile.onReady = (info) => {
    videoTrack = info.videoTracks[0];
    if (!videoTrack) return;
    isoFile.setExtractionOptions(videoTrack.id, undefined, { nbSamples: 1 });
    isoFile.start();
  };

  isoFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(source, 0));
  isoFile.flush();

  if (demuxError) throw demuxError;
  if (!videoTrack) throw new Error('This video has no readable video track.');
  if (!chunks.length) throw new Error('This video has no readable video frames.');

  // getTrackSamplesInfo, not getTrackSample: the latter reads sample bytes back
  // out of the stream, which is empty by now, whereas the sample list carries
  // the parsed sample entry from the moment moov was read.
  const entry = isoFile.getTrackSamplesInfo(videoTrack.id)?.[0]?.description as
    | VisualSampleEntry
    | undefined;
  if (!entry) throw new Error('This video has no readable video track.');

  return { track: videoTrack, chunks, description: decoderDescription(entry) };
}

/**
 * Decodes `file` and yields frames in presentation order.
 *
 * mp4box hands samples over in DECODE order, which for B-frames is not display
 * order; VideoDecoder is what reorders them, so chunks go in as they come and
 * frames come out already sorted by timestamp.
 *
 * The caller owns every yielded VideoFrame and must close it. Anything still
 * buffered when the caller stops early is closed here, in the generator's own
 * finally — an abort mid-loop would otherwise strand a queue of GPU frames.
 */
async function* decodeFrames(
  file: File,
  signal?: AbortSignal
): AsyncGenerator<VideoFrame, void, undefined> {
  const { track, chunks, description } = await demuxVideoTrack(file);

  const pending: VideoFrame[] = [];
  let decodeError: Error | undefined;
  let decoder: VideoDecoder | undefined;

  try {
    decoder = new VideoDecoder({
      output: (videoFrame) => pending.push(videoFrame),
      // Throwing from a codec callback lands on the codec's own task, past any
      // try/catch here, and surfaces as an unhandled rejection. Stash and raise.
      error: (error) => {
        decodeError = error;
      },
    });
    decoder.configure({
      codec: track.codec,
      codedWidth: track.video?.width,
      codedHeight: track.video?.height,
      description,
    });

    for (const chunk of chunks) {
      throwIfAborted(signal);
      if (decodeError) throw decodeError;

      // Both queues are bounded before another frame is created. Without this
      // the decoder would run the whole file ahead of the consumer and every
      // decoded frame would be alive at once — the failure that only shows up
      // on long videos.
      while (decoder.decodeQueueSize > MAX_DECODE_QUEUE || pending.length > MAX_DECODE_QUEUE) {
        await yieldToCodec();
        throwIfAborted(signal);
        if (decodeError) throw decodeError;
        while (pending.length) yield pending.shift()!;
      }

      decoder.decode(chunk);
      while (pending.length) yield pending.shift()!;
    }

    await decoder.flush();
    if (decodeError) throw decodeError;

    while (pending.length) {
      throwIfAborted(signal);
      yield pending.shift()!;
    }
  } finally {
    // Frames the consumer never received still hold GPU memory. An abort or a
    // throw mid-iteration lands here with the buffer non-empty, and nothing
    // else will ever close them.
    for (const videoFrame of pending) videoFrame.close();
    pending.length = 0;
    if (decoder && decoder.state !== 'closed') decoder.close();
  }
}

/**
 * Encodes `file` as an MP4 with each frame composited into `frame`'s bezel.
 *
 * Compositing goes through renderFrameToCanvas — the same function stills use —
 * so device framing has one implementation rather than two that drift.
 */
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
  // stills follow. The size is not known until the first composite runs, since
  // it comes from the frame PNG's own dimensions, so the encoder and muxer are
  // configured lazily on the first frame rather than from a primed canvas.
  const canvas = document.createElement('canvas');
  const scratchCanvas = document.createElement('canvas');
  // What actually reaches the encoder. Kept separate because it must be even
  // (see below) while renderFrameToCanvas always sizes `canvas` to the frame
  // PNG, and 16 of the shipped frames — iPhone 14 Pro and 16, several iPads —
  // are an odd number of pixels wide or tall.
  const outputCanvas = document.createElement('canvas');

  let muxer: Muxer<ArrayBufferTarget> | undefined;
  let encoder: VideoEncoder | undefined;
  let outputCtx: CanvasRenderingContext2D | undefined;
  let encoderError: Error | undefined;
  let encoded = 0;

  const configure = async () => {
    // H.264 requires even dimensions; odd ones are rejected outright. Cropping
    // the last row/column rather than scaling keeps every other pixel exact.
    const width = canvas.width - (canvas.width % 2);
    const height = canvas.height - (canvas.height % 2);
    outputCanvas.width = width;
    outputCanvas.height = height;

    outputCtx = outputCanvas.getContext('2d') ?? undefined;
    if (!outputCtx) throw new Error('No output canvas context');

    // The early gate ran at a default size before the frame was known. The real
    // output is the frame PNG's size, which is much larger — iPad Pro 12.9 is
    // 2288x2973 — and some hardware encoders reject sizes above their supported
    // profile. Asking now, rather than letting configure() throw, keeps the
    // refusal a clear message instead of a codec error raised after the whole
    // file has already been demuxed.
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: H264_CODEC,
      width,
      height,
    });
    if (!supported) throw new Error(VIDEO_UNSUPPORTED_MESSAGE);

    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height },
      fastStart: 'in-memory',
      // A source whose first frame has a non-zero presentation time — an edited
      // clip, or a phone recording with an edit list — throws outright under the
      // default 'strict' behaviour. Rebasing to zero is what a trimmed clip
      // means anyway: the output starts at its own beginning.
      //
      // TASK 7 (audio): 'offset' rebases each track INDEPENDENTLY by its own
      // first timestamp. A recording whose audio starts 80ms before its video
      // would have that real offset silently collapsed to zero, desyncing A/V.
      // Switch to 'cross-track-offset' — which rebases both tracks by the single
      // earliest timestamp — once an audio track exists. This will not fail
      // loudly; it just drifts.
      firstTimestampBehavior: 'offset',
    });

    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        muxer!.addVideoChunk(chunk, meta);
        encoded += 1;
        onProgress?.(progressFraction(encoded, info.frameCount));
      },
      // Throwing here would surface as an unhandled rejection on the codec's
      // own task, past any try/catch in this function. Stash it instead and let
      // the loop below raise it on the next frame.
      error: (error) => {
        encoderError = error;
      },
    });
    encoder.configure({ codec: H264_CODEC, width, height, bitrate: 8_000_000 });
  };

  try {
    for await (const videoFrame of decodeFrames(file, signal)) {
      try {
        throwIfAborted(signal);
        if (encoderError) throw encoderError;

        await renderFrameToCanvas(canvas, videoFrame, frame, {
          backgroundColor,
          signal,
          scratchCanvas,
        });
        if (!encoder) await configure();
        await awaitEncoderCapacity(encoder!);

        // Copy into the even-sized canvas. Encoding the composite canvas
        // directly would hand the encoder a frame whose size disagrees with its
        // configured size on every odd-dimension device frame.
        //
        // Cleared first because drawImage composites source-over onto whatever
        // is already there. renderFrameToCanvas clears its own canvas but only
        // paints a background when one was asked for, so with the default
        // transparent background every pixel outside the bezel stays clear and
        // would otherwise retain frame N-1 — the same ghosting the scratch
        // canvas hit one layer in. H.264 has no alpha, so it bakes in.
        outputCtx!.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx!.drawImage(canvas, 0, 0);

        // A second VideoFrame, wrapping the composited canvas. It is closed in
        // the same breath it is encoded: encode() copies what it needs
        // synchronously, so holding it any longer only pins GPU memory.
        const composited = new VideoFrame(outputCanvas, { timestamp: videoFrame.timestamp });
        try {
          encoder!.encode(composited);
        } finally {
          composited.close();
        }
      } finally {
        // VideoFrame holds GPU memory the GC does not reclaim. A missed close
        // exhausts memory on long videos only, which makes it the easiest bug
        // here to ship unnoticed — hence finally, not a trailing call.
        videoFrame.close();
      }
    }

    if (encoderError) throw encoderError;
    // A video whose every frame failed to decode would otherwise finalize an
    // empty muxer and hand back a file no player will open.
    if (!encoder || !muxer) throw new Error('This video produced no frames to encode.');

    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    onProgress?.(1);

    const { buffer } = muxer.target;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    // Removing a video mid-encode must not leave a running encoder holding
    // hardware resources.
    if (encoder && encoder.state !== 'closed') encoder.close();
  }
}
