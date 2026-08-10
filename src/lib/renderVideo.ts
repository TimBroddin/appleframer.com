import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { createFile, MP4BoxBuffer, MultiBufferStream } from 'mp4box';
import type { AudioSampleEntry, ISOFile, Sample, Track, VisualSampleEntry } from 'mp4box';
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

/** A track edit-list entry, as mp4box parses it. */
export interface TrackEdit {
  segment_duration: number;
  media_time: number;
}

/**
 * How far a track's sample timestamps must move to reach the presentation
 * timeline, in microseconds. Subtract the result from every sample's cts.
 *
 * Sample timestamps alone are NOT where a track starts. An H.264 encoder emits
 * its first frame with a leading cts — 66666us on every file measured here —
 * and the container cancels it with an edit whose `media_time` points at the
 * first frame the player should actually show. Taking cts at face value would
 * push video 66ms later than audio and desync a recording that was fine.
 *
 * A `media_time` of -1 marks an EMPTY edit, which is the opposite case: it is a
 * genuine delay before the track starts, so its duration is added back rather
 * than subtracted. This is how a real leading-audio offset is stored — measured
 * on a clip built with `-itsoffset 0.08`, where the 56ms lead lives entirely in
 * an empty edit and both tracks' first cts are 0.
 *
 * Verified against ffprobe's own start_time, which applies edit lists: this
 * reproduces 0.056 for that clip against ffprobe's 0.056009, and 0/0 for
 * ordinary recordings where the two tracks really are aligned.
 *
 * @param edits the track's edit list, or undefined when it has none
 * @param mediaTimescale the track's own timescale, which media_time is in
 * @param movieTimescale the movie timescale, which segment_duration is in
 */
export function trackTimeShift(
  edits: TrackEdit[] | undefined,
  mediaTimescale: number,
  movieTimescale: number
): number {
  if (!edits?.length || !mediaTimescale || !movieTimescale) return 0;

  let emptyLead = 0;
  for (const edit of edits) {
    if (edit.media_time === -1) {
      emptyLead += (edit.segment_duration * 1e6) / movieTimescale;
      continue;
    }
    // The first real edit establishes the origin; later ones would be a genuine
    // cut list, which is beyond what this needs to handle.
    return Math.round((edit.media_time * 1e6) / mediaTimescale - emptyLead);
  }
  // Nothing but empty edits: the whole track is delayed by their total.
  return Math.round(-emptyLead);
}

/**
 * The single origin both tracks are measured from, in microseconds.
 *
 * Both tracks are shifted by this one value rather than each by its own start,
 * so whatever gap the source had between them is still present in what reaches
 * the muxer. Inputs are edit-list-corrected presentation times, not raw cts.
 *
 * Note this does not by itself guarantee the gap survives into the FILE:
 * mp4-muxer pins every track's first sample to t=0 (`lastTimescaleUnits = 0`)
 * and stores the rest as deltas, so a late-starting track cannot be represented
 * at all. See the firstTimestampBehavior comment for what that costs. Keeping a
 * common origin is still worth doing — it is what makes the two encoders'
 * output describe one timeline rather than two unrelated ones.
 */
export function timestampBase(videoStart: number, audioStart: number | undefined): number {
  if (audioStart === undefined) return videoStart;
  return Math.min(videoStart, audioStart);
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

/**
 * The AudioSpecificConfig for an AAC track, which AudioDecoder needs as its
 * `description` — like the video SPS/PPS, it lives in the container rather than
 * the samples, and AAC cannot be decoded without it.
 *
 * It sits inside the esds box as a DecoderSpecificInfo (tag 5) nested in a
 * DecoderConfigDescriptor (tag 4). Read through mp4box's parsed descriptor tree
 * rather than by re-serialising the box, because unlike avcC the payload is not
 * simply "the box minus its header" — the descriptors are length-prefixed and
 * the ASC is only a few bytes deep inside them.
 *
 * Non-AAC entries have no esds and return undefined, which is correct: Opus
 * carries dOps instead, and its config is not an ASC.
 */
function audioDescription(entry: AudioSampleEntry): Uint8Array | undefined {
  const esds = (entry as { esds?: { esd?: { findDescriptor(tag: number): unknown } } }).esds;
  const decoderConfig = esds?.esd?.findDescriptor(4) as
    | { findDescriptor(tag: number): { data?: Uint8Array } | undefined }
    | undefined;
  return decoderConfig?.findDescriptor(5)?.data;
}

/**
 * Whether AudioDecoder can be configured for this track, asked before anything
 * is built.
 *
 * A recording may carry Opus, or PCM in a .mov, and AudioDecoder rejects codecs
 * the browser cannot decode. Failing the whole export over an exotic audio
 * codec would be a bad trade — the user asked for a framed video — so an
 * unsupported track is dropped and the video exports silently without it.
 * Producing a file with a configured-but-unfed audio track would be worse still:
 * it stalls on playback.
 */
async function canDecodeAudio(config: AudioDecoderConfig): Promise<boolean> {
  try {
    const { supported } = await AudioDecoder.isConfigSupported(config);
    return supported === true;
  } catch {
    // isConfigSupported throws (rather than returning false) on a codec string
    // it cannot even parse, which is exactly what a PCM or exotic track hits.
    return false;
  }
}

/**
 * The AudioDecoder configuration for a demuxed audio track.
 *
 * Built in ONE place so the pre-flight support check and the real configure()
 * call can never test different values — a gate that probes a different config
 * than the decoder actually receives is worse than no gate, because it reports
 * confidence it has not earned. This exact object is passed to both.
 *
 * The codec string is lowercased because mp4box reports the sample entry's
 * fourcc as written in the container, and for Opus that is literally "Opus" —
 * the registered box name. WebCodecs matches codec strings case-sensitively and
 * wants "opus", so an uncorrected string is rejected and a perfectly decodable
 * track gets dropped as unsupported. Harmless for AAC, whose "mp4a.40.2" is
 * already lowercase.
 */
function audioDecoderConfig(audio: DemuxedAudio): AudioDecoderConfig {
  return {
    codec: audio.track.codec.toLowerCase(),
    numberOfChannels: audio.track.audio?.channel_count ?? 2,
    sampleRate: audio.track.audio?.sample_rate ?? 48_000,
    description: audio.description,
  };
}

interface DemuxedAudio {
  track: Track;
  chunks: EncodedAudioChunk[];
  /** AudioSpecificConfig for AAC, or undefined for codecs without one. */
  description: Uint8Array | undefined;
  /** Presentation time of the track's first sample, edit list applied. */
  start: number;
}

interface DemuxedTrack {
  track: Track;
  chunks: EncodedVideoChunk[];
  /** AVC/HEVC decoder configuration record, or undefined for codecs without one. */
  description: Uint8Array | undefined;
  /** Presentation time of the track's first sample, edit list applied. */
  start: number;
  /** Undefined when the source has no audio track mp4box could read. */
  audio: DemuxedAudio | undefined;
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
  const audioChunks: EncodedAudioChunk[] = [];
  let videoTrack: Track | undefined;
  let audioTrack: Track | undefined;
  let demuxError: Error | undefined;
  // Per-track corrections from the edit lists, resolved in onReady. Applied as
  // samples arrive so every chunk downstream is already on the presentation
  // timeline and nothing has to remember to correct it later.
  let videoShift = 0;
  let audioShift = 0;

  isoFile.onError = (module, message) => {
    demuxError = new Error(`Could not read this video (${module}): ${message}`);
  };
  isoFile.onSamples = (id, _user, samples: Array<Sample>) => {
    // Both tracks are extracted in the same pass, so the callback is shared and
    // the track id is what tells them apart.
    const isAudio = id === audioTrack?.id;
    for (const sample of samples) {
      if (!sample.data) continue;
      const init = {
        // Every audio sample is independently decodable; only video has deltas.
        type: (isAudio || sample.is_sync ? 'key' : 'delta') as EncodedVideoChunkType,
        // Microseconds, and from cts rather than dts: cts is the presentation
        // time, which is what the decoder tags its output with and what the
        // muxer writes. Using dts would misorder B-frames on playback.
        //
        // Rounded because a 15360 timescale does not divide into whole
        // microseconds, and WebCodecs timestamps are integers — left
        // fractional they are truncated, which drifts against the durations.
        //
        // Shifted onto the presentation timeline, because raw cts carries the
        // encoder delay the container's edit list is there to cancel.
        timestamp: Math.round((sample.cts * 1e6) / sample.timescale) - (isAudio ? audioShift : videoShift),
        duration: Math.round((sample.duration * 1e6) / sample.timescale),
        data: sample.data,
      };
      if (isAudio) audioChunks.push(new EncodedAudioChunk(init));
      else chunks.push(new EncodedVideoChunk(init));
    }
    // The chunk copied the bytes, so mp4box's own copy is now dead weight;
    // without this the demuxer holds the entire track a second time.
    isoFile.releaseUsedSamples(id, samples[samples.length - 1].number + 1);
  };
  isoFile.onReady = (info) => {
    videoTrack = info.videoTracks[0];
    if (!videoTrack) return;
    videoShift = trackTimeShift(videoTrack.edits, videoTrack.timescale, info.timescale);
    // Both setExtractionOptions calls must precede the single start(), and all
    // of it must stay synchronous inside onReady — mp4box empties its stream
    // buffers during appendBuffer, so anything deferred yields zero samples.
    isoFile.setExtractionOptions(videoTrack.id, undefined, { nbSamples: 1 });
    audioTrack = info.audioTracks[0];
    if (audioTrack) {
      audioShift = trackTimeShift(audioTrack.edits, audioTrack.timescale, info.timescale);
      isoFile.setExtractionOptions(audioTrack.id, undefined, { nbSamples: 1 });
    }
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

  // A track with no samples is dropped rather than carried as an empty one: the
  // muxer would then declare an audio track it is never fed, which stalls
  // playback — the exact failure the conditional configuration exists to avoid.
  let audio: DemuxedAudio | undefined;
  if (audioTrack && audioChunks.length) {
    const audioEntry = isoFile.getTrackSamplesInfo(audioTrack.id)?.[0]?.description as
      | AudioSampleEntry
      | undefined;
    if (audioEntry) {
      audio = {
        track: audioTrack,
        chunks: audioChunks,
        description: audioDescription(audioEntry),
        start: audioChunks[0].timestamp,
      };
    }
  }

  return {
    track: videoTrack,
    chunks,
    description: decoderDescription(entry),
    start: chunks[0].timestamp,
    audio,
  };
}

/**
 * Decodes an already-demuxed video track and yields frames in presentation
 * order.
 *
 * Takes the demux result rather than the File because the caller needs the
 * audio track from the same pass before encoding starts — both to configure the
 * muxer's audio track and to compute the shared timestamp base.
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
  demuxed: DemuxedTrack,
  signal?: AbortSignal
): AsyncGenerator<VideoFrame, void, undefined> {
  const { track, chunks, description } = demuxed;

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

/** AudioData objects allowed to queue on the audio encoder before decoding pauses. */
const MAX_AUDIO_QUEUE = 8;

/**
 * A configured, ready-to-run audio pipeline. Its mere existence is the proof
 * that this source's audio can actually be transcoded.
 */
interface AudioPipeline {
  decoder: AudioDecoder;
  encoder: AudioEncoder;
  pending: AudioData[];
  /**
   * Where encoded chunks go. The encoder's output callback is fixed at
   * construction, but the muxer does not exist yet at that point, so the
   * callback closes over this and it is pointed at the muxer once there is one.
   */
  setSink: (sink: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void) => void;
  /** Set from either codec's error callback; read by the transcode loop. */
  readError: () => Error | undefined;
  close: () => void;
}

/**
 * Builds and configures both audio codecs, or returns undefined if this source's
 * audio cannot be transcoded.
 *
 * Split out from the transcode itself, and called BEFORE the muxer is built, so
 * the decision to drop audio is always made while it is still free to make. Once
 * the muxer has declared an audio track, dropping it leaves a track with a
 * declared duration and zero samples — measured to produce exactly the file that
 * stalls on playback — and a muxer cannot un-declare a track. Every way audio
 * can fail to start must therefore be discovered here, not later.
 *
 * `isConfigSupported` alone is not enough: it validates the shape of a config
 * without necessarily accepting the codec-specific `description`, so a real
 * `configure()` is the only honest test. Both are done here, on the same config
 * object, and a throw from either means audio is dropped rather than fatal.
 */
async function createAudioPipeline(audio: DemuxedAudio): Promise<AudioPipeline | undefined> {
  const decoderConfig = audioDecoderConfig(audio);
  // The exact config configure() will receive — never a reconstructed one, or
  // the gate would be answering a question nobody asked.
  if (!(await canDecodeAudio(decoderConfig))) return undefined;

  const numberOfChannels = decoderConfig.numberOfChannels ?? 2;
  const sampleRate = decoderConfig.sampleRate ?? 48_000;

  let codecError: Error | undefined;
  const noteError = (error: Error) => {
    codecError = error;
  };

  let decoder: AudioDecoder | undefined;
  let encoder: AudioEncoder | undefined;
  const pending: AudioData[] = [];
  // Nothing is encoded before transcodeAudio points this at the muxer, so the
  // no-op is never actually hit; it exists so the callback is total.
  let sink: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void = () => {};

  try {
    encoder = new AudioEncoder({
      output: (chunk, meta) => sink(chunk, meta),
      // Stashed rather than thrown, for the same reason the video codecs do it:
      // a throw here lands on the codec's own task, past any try/catch.
      error: noteError,
    });
    encoder.configure({
      codec: 'mp4a.40.2',
      numberOfChannels,
      sampleRate,
      bitrate: 128_000,
    });

    decoder = new AudioDecoder({
      output: (data) => pending.push(data),
      error: noteError,
    });
    decoder.configure(decoderConfig);
  } catch {
    // An unsupported description, a sample rate the AAC encoder refuses — this
    // is the failure the pre-flight check cannot see. Reaching it costs only the
    // codecs built so far, because the muxer does not exist yet.
    if (decoder && decoder.state !== 'closed') decoder.close();
    if (encoder && encoder.state !== 'closed') encoder.close();
    return undefined;
  }

  return {
    decoder,
    encoder,
    pending,
    setSink: (next) => {
      sink = next;
    },
    readError: () => codecError,
    close: () => {
      for (const data of pending) data.close();
      pending.length = 0;
      if (decoder!.state !== 'closed') decoder!.close();
      if (encoder!.state !== 'closed') encoder!.close();
    },
  };
}

/**
 * Decodes the source audio and re-encodes it to AAC, feeding `muxer` directly.
 *
 * Audio never touches the canvas — it is a straight transcode running alongside
 * compositing — so it is kept out of the frame loop entirely rather than
 * interleaved with it.
 *
 * Takes an already-configured pipeline, because whether audio is viable has to
 * be settled before the muxer declares the track. See createAudioPipeline.
 *
 * Timestamps are shifted by `base`, the shared origin the video track also uses,
 * so both encoders describe one timeline. See timestampBase.
 *
 * Every AudioData is closed in a finally: like VideoFrame it holds memory the
 * GC does not reclaim, and the leak only shows on long recordings.
 */
async function transcodeAudio(
  pipeline: AudioPipeline,
  audio: DemuxedAudio,
  muxer: Muxer<ArrayBufferTarget>,
  base: number,
  signal?: AbortSignal
): Promise<void> {
  const { chunks } = audio;
  const { decoder, encoder, pending } = pipeline;

  try {
    // The muxer exists and has declared the track, so encoded chunks now have
    // somewhere to go.
    pipeline.setSink((chunk, meta) => muxer.addAudioChunk(chunk, meta));

    // Encodes and closes everything decoded so far. Closing in a finally per
    // item means a throw from encode() — a closed queue after an abort, most
    // likely — still releases the AudioData rather than stranding it.
    const drain = () => {
      while (pending.length) {
        const data = pending.shift()!;
        try {
          encoder.encode(data);
        } finally {
          data.close();
        }
      }
    };

    for (const chunk of chunks) {
      throwIfAborted(signal);
      const failure = pipeline.readError();
      if (failure) throw failure;

      // Bounded on both codecs before another AudioData can be created, for the
      // same reason the video path bounds its queues: decoding outruns encoding,
      // and AudioData holds memory until it is closed.
      while (decoder.decodeQueueSize > MAX_AUDIO_QUEUE || encoder.encodeQueueSize > MAX_AUDIO_QUEUE) {
        await yieldToCodec();
        throwIfAborted(signal);
        const failure = pipeline.readError();
        if (failure) throw failure;
        drain();
      }

      // A copy with the shifted timestamp, since EncodedAudioChunk is
      // immutable. The bytes are the compressed frame the file already holds,
      // so this is cheap compared with a decoded AudioData.
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      decoder.decode(
        new EncodedAudioChunk({
          type: chunk.type,
          timestamp: chunk.timestamp - base,
          duration: chunk.duration ?? undefined,
          data,
        })
      );
      drain();
    }

    await decoder.flush();
    const afterDecode = pipeline.readError();
    if (afterDecode) throw afterDecode;
    drain();

    await encoder.flush();
    const afterEncode = pipeline.readError();
    if (afterEncode) throw afterEncode;
  } finally {
    // Closes anything decoded but never encoded — an abort mid-loop lands here
    // with the buffer non-empty and nothing else will ever close it — and both
    // codecs, so an aborted encode leaves nothing running.
    pipeline.close();
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
    /**
     * Called when the source had audio but the export could not carry it, so
     * the caller can say so rather than leaving the user to notice a silent
     * video. Never called for a source that had no audio to begin with.
     */
    onAudioDropped?: (reason: Error) => void;
  } = {}
): Promise<Blob> {
  const { backgroundColor = null, signal, onProgress, onAudioDropped } = options;
  const info = await probeVideo(file);
  await assertVideoSupported();

  // Demuxed up front rather than inside decodeFrames, because the audio track
  // has to be known before the muxer is configured: declaring an audio track
  // and never feeding it produces a file that stalls on playback.
  const demuxed = await demuxVideoTrack(file);

  // Both audio codecs are built and configured HERE, before the muxer exists, so
  // a source whose audio cannot be transcoded is discovered while dropping it is
  // still free. Once the muxer declares an audio track there is no way back:
  // measured, a declared track fed zero samples yields a file whose audio stream
  // has a full duration and no packets, which is the stall-on-playback case.
  //
  // Failing the whole encode over an exotic audio codec would cost the user the
  // thing they actually asked for, so this degrades to video-only instead.
  let audio = demuxed.audio;
  let audioPipeline: AudioPipeline | undefined;
  if (audio) {
    audioPipeline = await createAudioPipeline(audio);
    if (!audioPipeline) {
      onAudioDropped?.(
        new Error(`This video's audio (${audio.track.codec}) could not be decoded, so it was dropped.`)
      );
      audio = undefined;
    }
  }

  // One base for both tracks, computed before either encoder runs so their
  // relative offset survives into the output. The muxer cannot be trusted to do
  // this — see timestampBase.
  const base = timestampBase(demuxed.start, audio?.start);

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
      // Declared only when the source actually has decodable audio. A configured
      // track that is never fed produces a file that stalls on playback.
      ...(audio
        ? {
            audio: {
              codec: 'aac' as const,
              numberOfChannels: audio.track.audio?.channel_count ?? 2,
              sampleRate: audio.track.audio?.sample_rate ?? 48_000,
            },
          }
        : {}),
      fastStart: 'in-memory',
      // A source whose first frame has a non-zero presentation time — an edited
      // clip, or a phone recording with an edit list — throws outright under the
      // default 'strict' behaviour. Rebasing to zero is what a trimmed clip
      // means anyway: the output starts at its own beginning.
      //
      // NOT 'cross-track-offset', despite that being the option nominally meant
      // for two tracks. Its base is Math.min over the tracks fed SO FAR, and our
      // two encoders emit concurrently, so the first video chunk gets rebased by
      // video's own start while every later one gets rebased by audio's.
      // Measured on realistic chunks: video frame 1 at 0.000 and frame 2 at
      // 0.054670 instead of 0.033333 — a broken first interval plus a permanent
      // lag. 'offset' is order-independent and produced an identical, correct
      // timeline in all three feed orders tested.
      //
      // The cost is that a genuine leading-track offset is flattened to zero,
      // because mp4-muxer pins every track's first sample to t=0
      // (`track.lastTimescaleUnits = 0`) and stores the rest as deltas — a
      // late-starting track is simply not representable, and 'strict' throws
      // rather than allowing one. Measured worst case 56ms on a clip built with
      // -itsoffset 0.08; ordinary recordings are 6-21ms, which is encoder
      // priming rather than a real offset. Correcting it would need an edit list
      // this muxer does not write.
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

  // Started once the muxer exists — it is configured lazily on the first frame,
  // and addAudioChunk needs somewhere to go. Held rather than awaited so the
  // transcode runs alongside compositing instead of serialising behind it.
  let audioDone: Promise<void> | undefined;

  try {
    for await (const videoFrame of decodeFrames(demuxed, signal)) {
      try {
        throwIfAborted(signal);
        if (encoderError) throw encoderError;

        await renderFrameToCanvas(canvas, videoFrame, frame, {
          backgroundColor,
          signal,
          scratchCanvas,
        });
        if (!encoder) {
          await configure();
          if (audio && audioPipeline) {
            audioDone = transcodeAudio(audioPipeline, audio, muxer!, base, signal);
          }
        }
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
        //
        // Shifted by the same base the audio track uses, so the two stay in the
        // relationship the source had.
        const composited = new VideoFrame(outputCanvas, {
          timestamp: videoFrame.timestamp - base,
        });
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

    // Both encoders, not just the video one: finalizing while the audio encoder
    // still holds buffered chunks truncates the audio track. transcodeAudio
    // flushes its own encoder before resolving, so awaiting it is the audio half
    // of this.
    //
    // The audio half is awaited SEPARATELY and its rejection caught, because a
    // combined Promise.all would reject before finalize() and throw away a
    // fully-encoded video track over an audio-only problem. An abort is the one
    // audio failure that stays fatal — it means the user cancelled, so there is
    // no export to salvage — and is re-raised below by the video path's own
    // throwIfAborted. Anything else degrades to video-only, matching what the
    // pre-flight does for a codec it could not configure at all.
    const [, audioFailure] = await Promise.all([
      encoder.flush(),
      audioDone?.then(
        () => undefined,
        (error: Error) => error
      ),
    ]);
    if (encoderError) throw encoderError;
    throwIfAborted(signal);
    if (audioFailure) {
      // The track was declared and partially fed. Measured: that truncates the
      // audio rather than corrupting the file — players read the samples that
      // are there — which is why this is recoverable at all, and why the
      // unrecoverable case is handled before the muxer is built.
      onAudioDropped?.(audioFailure);
    }
    muxer.finalize();
    onProgress?.(1);

    const { buffer } = muxer.target;
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    // An abort or a throw leaves the audio transcode running against a muxer
    // nobody will finalize. It honours the same signal, so it will settle on its
    // own; awaiting it here keeps its codecs from being closed by its finally
    // after this function has already returned, and swallows the rejection that
    // an abort raises, which would otherwise be unhandled.
    if (audioDone) await audioDone.catch(() => {});
    // The pipeline is configured before the first frame is composited, so a
    // throw anywhere before that — an unsupported output size, an abort on frame
    // one — leaves two configured codecs that transcodeAudio never took
    // ownership of. close() is idempotent via the state guards, so calling it
    // after a completed transcode is harmless.
    audioPipeline?.close();
    // Removing a video mid-encode must not leave a running encoder holding
    // hardware resources.
    if (encoder && encoder.state !== 'closed') encoder.close();
  }
}
