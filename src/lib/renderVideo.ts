import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { createFile, MP4BoxBuffer, MultiBufferStream } from 'mp4box';
import type { AudioSampleEntry, ISOFile, Sample, Track, VisualSampleEntry } from 'mp4box';
import type { DeviceFrame } from '../hooks/useFrames';
import { renderFrameToCanvas } from './renderFrame';
import {
  assertVideoSupported,
  encodableOutputSize,
  H264_CODEC,
  VIDEO_SIZE_UNSUPPORTED_MESSAGE,
} from './videoSupport';

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
 * How long a metadata probe may take before it is treated as a dead file.
 *
 * A <video> element that accepts a source and then stalls fires NEITHER
 * loadedmetadata NOR error — a truncated or subtly corrupt MP4 is the realistic
 * way to get there. Without a bound the probe promise simply never settles,
 * which is survivable in isolation but not for the callers this now has: the
 * probe runs inside a fixed-width detection worker pool, so a stalled file
 * consumes a worker slot permanently and enough of them deadlock detection
 * outright.
 *
 * 15 seconds is chosen to sit clear of both failure modes rather than to be
 * quick. `preload = 'metadata'` reads the container header, not the media, so
 * even a multi-gigabyte recording only needs enough IO to reach the moov atom —
 * on a slow external disk that is seconds, not tens of seconds. The margin is
 * mostly for a moov at the END of the file, which some cameras and screen
 * recorders write and which forces a seek across the whole thing. Going much
 * shorter risks rejecting a large but perfectly good recording; going much
 * longer leaves the user staring at a card that is already dead.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/**
 * Shown when a probe is abandoned. Deliberately the same wording as the
 * `error` path: from the user's side "the browser stalled on this file" and
 * "the browser rejected this file" are the same problem with the same remedy,
 * and inventing a second message would only ask them to tell the two apart.
 */
export const PROBE_FAILED_MESSAGE =
  'Could not read this video. It may be corrupt or use an unsupported codec.';

/**
 * Reads dimensions and duration without decoding the whole file.
 *
 * Uses a <video> element rather than mp4box: metadata is all that device
 * detection needs, and the element handles every container the browser can
 * play, including ones mp4box does not parse.
 *
 * Always settles. See PROBE_TIMEOUT_MS for why that is load-bearing rather
 * than tidiness.
 */
export function probeVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(PROBE_FAILED_MESSAGE));
    }, PROBE_TIMEOUT_MS);

    /**
     * Runs on every exit, including the timeout, which would otherwise leak
     * both the object URL and an element still holding a decode pipeline open.
     * Clearing src and calling load() is what actually makes the element let go
     * of the source — dropping the reference alone leaves a media element the
     * browser is still working on. Nulling the handlers first means load()
     * cannot re-enter onerror and settle an already-settled promise.
     */
    function cleanup() {
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    }

    video.onloadedmetadata = () => {
      // Read before cleanup: load() resets the element and zeroes these.
      const duration = video.duration;
      // videoWidth is the display size, already accounting for any
      // rotation metadata a phone recording carries.
      const width = video.videoWidth;
      const height = video.videoHeight;
      cleanup();
      // 30fps is a progress-bar estimate only, not a claim about the video's
      // true frame rate. The real frame count is not knowable without demuxing.
      // Task 6 will clamp progress to 1 precisely because this estimate can be
      // wrong for 60fps or higher-rate videos.
      resolve({
        width,
        height,
        duration,
        frameCount: estimateFrameCount(duration, 30),
      });
    };

    video.onerror = () => {
      cleanup();
      reject(new Error(PROBE_FAILED_MESSAGE));
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
 * Last-resort frame duration, in microseconds, for a source that did not supply
 * one. Derived from the track's own span rather than assumed.
 *
 * Every frame handed to the muxer must carry a duration: mp4-muxer rejects a
 * null one outright ("addVideoChunkRaw's fourth argument (duration) must be a
 * non-negative real number"), which is what took Firefox and WebKit down. A
 * VideoFrame does not inherit a duration from the canvas it wraps, so one has
 * to be supplied explicitly, and the decoded source frame is the right place to
 * get it — but `duration` is nullable in the WebCodecs IDL and a container with
 * a damaged `stts` can yield a zero, so a fallback is still required.
 *
 * A fixed 1/30s would be wrong here, and specifically wrong for the sources
 * this app exists to frame. Screen recordings are variable frame rate: a real
 * iPhone simulator capture measures `r_frame_rate=600/1` with per-frame gaps
 * ranging from 3.3ms to 298ms, because the simulator only emits a frame when
 * the screen actually changes. Stamping 33.3ms on all of them would rewrite a
 * 4.19s recording as 67/30 = 2.2s of video.
 *
 * So the fallback is the track's MEAN frame duration — its real elapsed span
 * divided by its real frame count — which is the best single estimate available
 * without inventing timing the source never had, and which by construction
 * reproduces the source's total duration even when individual gaps are
 * irregular. `span` is measured from the first to the last timestamp, so it
 * covers count-1 intervals.
 *
 * Falls back in turn to 1/30s only when the track is too degenerate to measure
 * (a single frame, or a zero/negative span). That constant is safe precisely
 * because it can no longer stretch a whole video: it applies to at most a frame
 * whose neighbours gave nothing to measure, and 30fps is the rate the rest of
 * this file already assumes for estimation. Never returns 0, negative, or NaN —
 * those are exactly the values the muxer refuses.
 */
export const FALLBACK_FRAME_DURATION_US = Math.round(1e6 / 30);

export function averageFrameDuration(span: number, frameCount: number): number {
  if (!Number.isFinite(span) || !Number.isFinite(frameCount)) return FALLBACK_FRAME_DURATION_US;
  // count-1 intervals separate count frames; anything less cannot be measured.
  const intervals = frameCount - 1;
  if (intervals < 1 || span <= 0) return FALLBACK_FRAME_DURATION_US;
  const mean = Math.round(span / intervals);
  // A span shorter than the frame count rounds to zero, which the muxer rejects
  // just as hard as null.
  return mean > 0 ? mean : FALLBACK_FRAME_DURATION_US;
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
 * The half-open presentation interval `[start, end)` a track's samples must fall
 * inside, in microseconds on the timeline `trackTimeShift` produces.
 *
 * The shift alone only moves timestamps; it never drops anything. A trim made in
 * QuickTime is stored as an edit whose `segment_duration` is SHORTER than the
 * media it points into — the cut frames stay in the file and only the edit list
 * says not to show them. Honouring the shift but not the duration therefore
 * restores footage the user deliberately cut: measured on a clip whose edit says
 * 2000ms over 4167ms of media, the export came back 4.27s / 122 frames instead
 * of 2s / 60.
 *
 * `end` is Infinity when there is nothing to enforce, which is the common case:
 * a file with no edit list at all, and — deliberately — an edit whose duration
 * covers its media, so ordinary recordings take an unconditional fast path.
 *
 * MULTI-SEGMENT LISTS ARE NOT SUPPORTED. Only the first real edit is honoured,
 * matching trackTimeShift, which resolves the origin from that same edit. A
 * genuine cut list would need every interval and a per-segment retiming to close
 * the gaps; screen recordings do not produce one. The degradation is predictable
 * rather than silent: later segments are dropped, so the output is a prefix of
 * what the source describes — short, never scrambled, and never longer than the
 * source claims.
 *
 * @param edits the track's edit list, or undefined when it has none
 * @param movieTimescale the movie timescale, which segment_duration is in
 */
export function trackEditWindow(
  edits: TrackEdit[] | undefined,
  movieTimescale: number
): { start: number; end: number } {
  const unbounded = { start: 0, end: Number.POSITIVE_INFINITY };
  if (!edits?.length || !movieTimescale) return unbounded;

  let emptyLead = 0;
  for (const edit of edits) {
    if (edit.media_time === -1) {
      emptyLead += (edit.segment_duration * 1e6) / movieTimescale;
      continue;
    }
    // The empty edits ahead of this one are lead time trackTimeShift has
    // already folded into the shift, so on the shifted timeline the media
    // starts at exactly that lead and runs for the segment's duration.
    const start = Math.round(emptyLead);
    const duration = (edit.segment_duration * 1e6) / movieTimescale;
    // A zero/absent duration means "to the end of the media" in practice, and
    // an edit list that declares one is not a trim to be enforced.
    if (!(duration > 0)) return { start, end: Number.POSITIVE_INFINITY };
    return { start, end: start + Math.round(duration) };
  }
  // Nothing but empty edits: no media is selected at all, but treating that as
  // "drop everything" would turn a file this code has always exported into an
  // empty one. Leave it unbounded and let the shift speak for itself.
  return unbounded;
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
 * Whether AudioEncoder can produce AAC, asked before anything is built.
 *
 * The decoder gate above is NOT enough on its own, and the asymmetry is what
 * broke Firefox outright. Firefox decodes AAC but does not encode it —
 * measured, `isConfigSupported` on the exact config below returns
 * `supported: false` there while Chromium and WebKit both return true.
 *
 * What made that fatal rather than merely unsupported is that `configure()`
 * does NOT report it. Per the WebCodecs contract a config that is well-formed
 * but unsupported is not a synchronous throw: `configure()` returns normally,
 * `state` reads 'configured', and the NotSupportedError is delivered later on
 * the codec's own task through the error callback. Measured in Firefox — the
 * error lands ~300ms after a configure() that threw nothing. So the try/catch
 * around configure() saw a healthy pipeline, the muxer went on to declare an
 * AAC track, and the failure surfaced with the export already past the point
 * where audio can still be dropped for free.
 *
 * Asking here keeps every audio-drop decision on the near side of the muxer,
 * which is the invariant the whole pipeline is built around.
 */
async function canEncodeAudio(config: AudioEncoderConfig): Promise<boolean> {
  try {
    const { supported } = await AudioEncoder.isConfigSupported(config);
    return supported === true;
  } catch {
    // Same reasoning as canDecodeAudio: a config the browser cannot even parse
    // throws rather than answering, and that is still just "no".
    return false;
  }
}

/**
 * The AudioEncoder configuration for the output track.
 *
 * Built in one place for the same reason the decoder config is: the pre-flight
 * and the real configure() must be answering about the same thing, or the gate
 * reports confidence it has not earned.
 */
function audioEncoderConfig(numberOfChannels: number, sampleRate: number): AudioEncoderConfig {
  return { codec: 'mp4a.40.2', numberOfChannels, sampleRate, bitrate: 128_000 };
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
  // The interval each track's edit list actually selects, on that same shifted
  // timeline. Both tracks are cut against ONE end, resolved in onReady, because
  // trimming them independently would move audio and video by different amounts
  // and desync a recording the shift had just aligned.
  let editEnd = Number.POSITIVE_INFINITY;

  isoFile.onError = (module, message) => {
    demuxError = new Error(`Could not read this video (${module}): ${message}`);
  };
  isoFile.onSamples = (id, _user, samples: Array<Sample>) => {
    // Both tracks are extracted in the same pass, so the callback is shared and
    // the track id is what tells them apart.
    const isAudio = id === audioTrack?.id;
    for (const sample of samples) {
      if (!sample.data) continue;
      const timestamp =
        Math.round((sample.cts * 1e6) / sample.timescale) - (isAudio ? audioShift : videoShift);
      // Past the end of what the edit list selects: this is footage the user
      // trimmed away, still sitting in the file because a container trim only
      // rewrites the edit list. Emitting it would hand back the cut frames.
      //
      // Only the tail is cut, never the head. The shift already puts the first
      // selected sample at the window's start, so there is nothing before it to
      // drop — and dropping from the front is what would strand the delta
      // frames that follow without the keyframe they reference.
      if (timestamp >= editEnd) continue;
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
        timestamp,
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
    // One end for both tracks, taken from the video edit list. Audio's own list
    // would usually give the same answer, but "usually" is not good enough: the
    // two are rounded to different timescales, and cutting each track at its own
    // end would leave audio running past the last frame — a desync introduced by
    // the very fix meant to remove trimmed footage. Video is the track the user
    // sees, so it decides.
    editEnd = trackEditWindow(videoTrack.edits, info.timescale).end;
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
 * Reads an MPEG-4 descriptor's length, which is stored as a base-128 varint
 * with a continuation bit, optionally padded to a fixed width with 0x80 bytes.
 *
 * Returns the payload length and where the payload starts, or undefined if the
 * bytes run out — a truncated descriptor must not be read past its own buffer.
 */
function readDescriptorLength(
  bytes: Uint8Array,
  offset: number
): { length: number; start: number } | undefined {
  let length = 0;
  let cursor = offset;
  // Four continuation bytes is the maximum a 32-bit length can occupy.
  for (let i = 0; i < 4; i += 1) {
    if (cursor >= bytes.length) return undefined;
    const byte = bytes[cursor];
    cursor += 1;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { length, start: cursor };
  }
  return undefined;
}

/**
 * The bare AudioSpecificConfig from whatever an AudioEncoder handed back as its
 * `decoderConfig.description`.
 *
 * Engines disagree about what that field contains, and the disagreement
 * silently corrupts the output. Measured on the same 48kHz stereo AAC encode:
 * Chromium returns the 2-byte ASC (`0x1208`) that the spec's
 * AudioDecoderConfig.description calls for, while WebKit returns a 39-byte blob
 * that is an entire ES_Descriptor — tag 0x03, wrapping a DecoderConfigDescriptor
 * (tag 0x04), wrapping the DecoderSpecificInfo (tag 0x05) that holds the actual
 * ASC.
 *
 * mp4-muxer writes this straight into the esds box it builds, so WebKit's blob
 * ends up nested inside a second ES_Descriptor. The resulting track parses as
 * "Audio object type 0 ... 0 channels" and ffprobe cannot open it at all — a
 * declared audio track that no decoder can read, which is the same class of
 * broken file the pipeline works so hard to avoid elsewhere.
 *
 * So the descriptor tree is walked and the innermost tag-5 payload returned.
 * Anything that is not a recognisable descriptor chain is passed through
 * unchanged: that is the Chromium case, where the description already IS the
 * ASC and there is nothing to unwrap. Deliberately conservative — an
 * unrecognised shape is returned as-is rather than guessed at, since a wrong
 * guess would break the engine that was already correct.
 */
export function bareAudioSpecificConfig(description: Uint8Array): Uint8Array {
  let bytes = description;
  // ES_Descriptor -> DecoderConfigDescriptor -> DecoderSpecificInfo. Bounded by
  // the nesting the spec actually defines rather than looping on arbitrary data.
  for (let depth = 0; depth < 4; depth += 1) {
    const tag = bytes[0];
    // 0x05 is the DecoderSpecificInfo itself: its payload is the ASC, which is
    // what we are after.
    if (tag !== 0x03 && tag !== 0x04 && tag !== 0x05) return description;

    const header = readDescriptorLength(bytes, 1);
    if (!header) return description;
    const body = bytes.subarray(header.start, header.start + header.length);
    if (!body.length) return description;

    if (tag === 0x05) return body;

    if (tag === 0x03) {
      // ES_Descriptor: 2-byte ES_ID then a flags byte, whose top bits mark
      // optional fields that must be stepped over before the nested descriptor.
      if (body.length < 3) return description;
      let cursor = 2;
      const flags = body[cursor];
      cursor += 1;
      if (flags & 0x80) cursor += 2; // streamDependenceFlag: dependsOn_ES_ID
      if (flags & 0x40) {
        // URL_Flag: a length-prefixed URL string.
        if (cursor >= body.length) return description;
        cursor += 1 + body[cursor];
      }
      if (flags & 0x20) cursor += 2; // OCRstreamFlag: OCR_ES_Id
      if (cursor >= body.length) return description;
      bytes = body.subarray(cursor);
      continue;
    }

    // 0x04, DecoderConfigDescriptor: 13 bytes of fixed fields precede the
    // nested DecoderSpecificInfo.
    if (body.length <= 13) return description;
    bytes = body.subarray(13);
  }
  return description;
}

/**
 * The encoder metadata as the muxer should receive it, with the description
 * normalised to a bare AudioSpecificConfig.
 *
 * Returns the original object when there is nothing to change, so the common
 * path allocates nothing.
 */
function normalizeAudioMeta(meta?: EncodedAudioChunkMetadata): EncodedAudioChunkMetadata | undefined {
  const description = meta?.decoderConfig?.description;
  if (!description) return meta;
  const source =
    description instanceof Uint8Array
      ? description
      : new Uint8Array(
          ArrayBuffer.isView(description)
            ? description.buffer.slice(
                description.byteOffset,
                description.byteOffset + description.byteLength
              )
            : description
        );
  const bare = bareAudioSpecificConfig(source);
  if (bare === source) return meta;
  return { ...meta, decoderConfig: { ...meta!.decoderConfig!, description: bare } };
}

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
  /**
   * How many encoded chunks actually reached the muxer.
   *
   * Distinguishes a partially-fed audio track from one that was declared and
   * never fed at all. The two look identical at the finalize site but are not
   * the same file: partial feeding truncates the audio, which players handle,
   * while zero samples is the stall-on-playback case this pipeline goes to
   * some length to avoid. See the finalize path in renderVideoToBlob.
   */
  readChunkCount: () => number;
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
 *
 * The converse is equally true and is the harder half: `configure()` alone is
 * not enough either, because an unsupported codec fails ASYNCHRONOUSLY through
 * the error callback rather than by throwing. That is why BOTH directions —
 * decode and encode — are pre-flighted here before either codec is built. See
 * canEncodeAudio for the Firefox failure that proved it.
 */
async function createAudioPipeline(audio: DemuxedAudio): Promise<AudioPipeline | undefined> {
  const decoderConfig = audioDecoderConfig(audio);
  // The exact config configure() will receive — never a reconstructed one, or
  // the gate would be answering a question nobody asked.
  if (!(await canDecodeAudio(decoderConfig))) return undefined;

  const numberOfChannels = decoderConfig.numberOfChannels ?? 2;
  const sampleRate = decoderConfig.sampleRate ?? 48_000;

  // Being able to DECODE the source says nothing about being able to re-encode
  // it: Firefox does the first and not the second. Asked before either codec is
  // constructed, so a browser without an AAC encoder drops audio here — while
  // it is still free — instead of dying after the muxer has declared the track.
  const encoderConfig = audioEncoderConfig(numberOfChannels, sampleRate);
  if (!(await canEncodeAudio(encoderConfig))) return undefined;

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

  // Counts chunks handed to the REAL sink, not chunks the encoder emitted.
  // Until transcodeAudio points the sink at the muxer it is a no-op, and a
  // chunk that went there reached no muxer — counting it would assert the track
  // had samples when it has none, which is exactly the state this detects.
  // Incremented by the sink setter below rather than here.
  let chunkCount = 0;

  try {
    encoder = new AudioEncoder({
      output: (chunk, meta) => sink(chunk, meta),
      // Stashed rather than thrown, for the same reason the video codecs do it:
      // a throw here lands on the codec's own task, past any try/catch.
      error: noteError,
    });
    encoder.configure(encoderConfig);

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
      // Wrapped rather than stored directly so the count follows the chunks
      // that actually reach the muxer, whatever the sink turns out to be.
      sink = (chunk, meta) => {
        next(chunk, meta);
        chunkCount += 1;
      };
    },
    readError: () => codecError,
    readChunkCount: () => chunkCount,
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
    // somewhere to go. The metadata is normalised on the way through because
    // WebKit's encoder reports a whole ES_Descriptor where the spec asks for a
    // bare AudioSpecificConfig, and muxing that verbatim yields an audio track
    // no decoder can open. See bareAudioSpecificConfig.
    pipeline.setSink((chunk, meta) => muxer.addAudioChunk(chunk, normalizeAudioMeta(meta)));

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
    /**
     * The first composited frame as a PNG data URL, handed over as soon as it
     * exists so a card can show something during a minute-long encode.
     *
     * A data URL rather than a VideoFrame or a canvas: this crosses into React
     * state, where anything holding GPU memory would need a lifetime the queue
     * has no way to enforce, and anything referencing the shared output canvas
     * would be overwritten by the very next frame.
     */
    onFirstFrame?: (dataUrl: string) => void;
  } = {}
): Promise<Blob> {
  const { backgroundColor = null, signal, onProgress, onAudioDropped } = options;
  // Cleared after it fires, so "first" is decided by this loop rather than by
  // how the encoder's asynchronous output callback happens to be paced against
  // it — `encoded` increments on the codec's own task and is still 0 here.
  let onFirstFrame = options.onFirstFrame;
  const info = await probeVideo(file);
  await assertVideoSupported();

  // Demuxed up front rather than inside decodeFrames, because the audio track
  // has to be known before the muxer is configured: declaring an audio track
  // and never feeding it produces a file that stalls on playback.
  const demuxed = await demuxVideoTrack(file);

  // The source's own mean frame duration, measured across the demuxed track,
  // held for any frame that reaches the encoder without a duration of its own.
  // Computed from the encoded chunks because they are the complete track — the
  // decode loop only ever sees a bounded window of it — and computed once
  // rather than per frame. See averageFrameDuration for why a fixed 1/30s would
  // misrepresent a variable-frame-rate screen recording.
  const sourceChunks = demuxed.chunks;
  const fallbackFrameDuration = averageFrameDuration(
    sourceChunks[sourceChunks.length - 1].timestamp - sourceChunks[0].timestamp,
    sourceChunks.length
  );

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
      // Deliberately does NOT say "could not be decoded". There are two ways to
      // land here and only one of them is a decode problem: Firefox decodes AAC
      // perfectly well and simply cannot encode it, so blaming the source codec
      // would send a user hunting for a fault in a recording that is fine. This
      // wording covers both causes honestly and names the one thing that is
      // always true — the export continues without sound.
      onAudioDropped?.(
        new Error(
          `This browser cannot re-encode this video's audio (${audio.track.codec}), so it was dropped and the video exported without sound.`
        )
      );
      audio = undefined;
    }
  }

  // One base for both tracks, computed before either encoder runs so their
  // relative offset survives into the output. The muxer cannot be trusted to do
  // this — see timestampBase.
  const base = timestampBase(demuxed.start, audio?.start);

  // Compositing happens at the device bezel's full resolution — the same rule
  // stills follow — but unlike a PNG that is not what gets encoded. H.264 caps
  // a frame at 8192 macroblocks, which almost every bezel exceeds, so the
  // composite is scaled down on the way into the encoder. See
  // encodableOutputSize. The size is not known until the first composite runs,
  // since it comes from the frame PNG's own dimensions, so the encoder and
  // muxer are configured lazily on the first frame rather than from a primed
  // canvas.
  const canvas = document.createElement('canvas');
  const scratchCanvas = document.createElement('canvas');
  // What actually reaches the encoder: the composite scaled to fit the codec's
  // limits, at even dimensions. Kept separate from `canvas` because
  // renderFrameToCanvas always sizes that one to the frame PNG.
  const outputCanvas = document.createElement('canvas');

  let muxer: Muxer<ArrayBufferTarget> | undefined;
  let encoder: VideoEncoder | undefined;
  let outputCtx: CanvasRenderingContext2D | undefined;
  let encoderError: Error | undefined;
  let encoded = 0;
  /**
   * Every encoded video chunk, kept so the file can be re-muxed without an
   * audio track if audio turns out to have contributed nothing. A muxer cannot
   * un-declare a track, so the only way back from a declared-but-unfed audio
   * track is to build a second muxer — which needs the chunks again.
   *
   * Retained only when there is an audio track that could still fail this way;
   * a video-only export never populates this. The memory is proportional to the
   * COMPRESSED output, which ArrayBufferTarget is already holding in full, so
   * this at worst doubles a cost the export already pays rather than adding one
   * of a different order.
   */
  const videoChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
  const retainVideoChunks = Boolean(audio);
  /** The encoded size, kept so a re-mux declares the same video track. */
  let outputSize: { width: number; height: number } | undefined;

  const configure = async () => {
    // The composite is scaled to the largest size the codec will accept at this
    // aspect ratio, which also guarantees both dimensions are even — H.264
    // rejects odd ones outright.
    //
    // This replaces an earlier one-pixel CROP that existed only to make odd
    // frames even. Cropping is now neither sufficient nor necessary:
    // insufficient because evenness was never the binding constraint (the
    // 1600x2800 iPhone 8 Plus bezel is already even and still rejected, at 17500
    // macroblocks against a budget of 8192), and unnecessary because scaling
    // produces even dimensions on its own. Nothing is lost by dropping it — the
    // cropped row/column was measured fully transparent on all 16 odd frames,
    // and it is now resampled rather than discarded.
    const { width, height } = encodableOutputSize(canvas.width, canvas.height);
    outputCanvas.width = width;
    outputCanvas.height = height;
    outputSize = { width, height };

    outputCtx = outputCanvas.getContext('2d') ?? undefined;
    if (!outputCtx) throw new Error('No output canvas context');

    // Smoothing for the DOWNSCALE, deliberately unlike the composite step,
    // which disables it because interpolation bleeds screenshot pixels past the
    // mask in Safari. That risk does not apply here: this resamples an
    // already-finished frame, where nearest-neighbour would alias the bezel's
    // curves and text badly. Same reasoning and same setting as
    // renderFramePreview's downscale pass.
    //
    // Set after the resize above, which resets all context state.
    outputCtx.imageSmoothingEnabled = true;
    outputCtx.imageSmoothingQuality = 'high';

    // The early gate ran before the frame was known, and only proves WebCodecs
    // works at all. This asks about the size actually being encoded. It should
    // now always pass, since encodableOutputSize targets the codec's own limit,
    // so reaching the throw means a browser whose real limit is lower than
    // level 4.0's — asking is what keeps that a clear message rather than a
    // codec error raised after the whole file has already been demuxed.
    const { supported } = await VideoEncoder.isConfigSupported({
      codec: H264_CODEC,
      width,
      height,
    });
    if (!supported) throw new Error(VIDEO_SIZE_UNSUPPORTED_MESSAGE);

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
        // Held for a possible video-only re-mux. EncodedVideoChunk is immutable
        // and the muxer copies what it needs, so keeping the reference is safe
        // and costs no copy here.
        if (retainVideoChunks) videoChunks.push({ chunk, meta });
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

        // Scale the composite into the encoder-sized canvas. Encoding `canvas`
        // directly would hand the encoder a frame far larger than its
        // configured size, which is the whole bug this sizing exists to fix.
        //
        // Cleared first because drawImage composites source-over onto whatever
        // is already there. renderFrameToCanvas clears its own canvas but only
        // paints a background when one was asked for, so with the default
        // transparent background every pixel outside the bezel stays clear and
        // would otherwise retain frame N-1 — the same ghosting the scratch
        // canvas hit one layer in. H.264 has no alpha, so it bakes in.
        outputCtx!.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        outputCtx!.drawImage(canvas, 0, 0, outputCanvas.width, outputCanvas.height);

        // A second VideoFrame, wrapping the composited canvas. It is closed in
        // the same breath it is encoded: encode() copies what it needs
        // synchronously, so holding it any longer only pins GPU memory.
        //
        // Shifted by the same base the audio track uses, so the two stay in the
        // relationship the source had.
        //
        // The duration must be passed explicitly and is not optional. A
        // VideoFrame built from a canvas has no timing of its own — it inherits
        // nothing from the source frame it was composited from — so omitting it
        // yields a chunk with a null duration, which mp4-muxer refuses:
        // "addVideoChunkRaw's fourth argument (duration) must be a non-negative
        // real number". Chromium happened to infer one and survive; Firefox and
        // WebKit did not, and video export failed outright in both.
        //
        // The decoded source frame's own duration is preferred because it is the
        // source's real timing, which for these variable-frame-rate screen
        // recordings differs from frame to frame. It was measured populated on
        // every frame of both test sources in all three engines; the fallback is
        // for the nullable-by-spec case and for a container whose stts yields a
        // zero.
        // `> 0` rather than `?? fallback`: null is not the only bad value. A
        // container with a damaged stts decodes to a frame whose duration is 0,
        // which the muxer accepts (it is non-negative) and which would collapse
        // that frame to no on-screen time at all. Both cases want the measured
        // fallback, and NaN — the other value the muxer rejects — fails this
        // comparison too rather than being propagated.
        const sourceDuration = videoFrame.duration;
        const composited = new VideoFrame(outputCanvas, {
          timestamp: videoFrame.timestamp - base,
          duration:
            sourceDuration != null && sourceDuration > 0 ? sourceDuration : fallbackFrameDuration,
        });
        try {
          encoder!.encode(composited);
        } finally {
          composited.close();
        }

        // The first composite doubles as the item's still preview, so a card
        // has something framed to show through a minute-long encode instead of
        // the raw recording. Read AFTER encode() so a frame the encoder rejects
        // never becomes the preview for a video that will not finish.
        //
        // Deliberately the SCALED outputCanvas rather than the full-resolution
        // composite, on two grounds. It is what the user is actually going to
        // get — a preview that showed more detail than the exported MP4 would
        // misrepresent the deliverable, and this preview is also what the zoom
        // overlay and the single view enlarge, which is exactly where an honest
        // resolution matters. And the card displays it at ~180px, so the extra
        // pixels would be discarded after inflating a data URL that crosses
        // into React state. Reading outputCanvas is also required for
        // correctness regardless: the next iteration clears and overwrites it,
        // so the read has to happen here either way.
        //
        // toDataURL is synchronous, so this cannot interleave with the frame
        // loop, the frame lifetimes above, or the encoder backpressure below —
        // it observes the pipeline without participating in it.
        if (onFirstFrame) {
          const emit = onFirstFrame;
          onFirstFrame = undefined;
          emit(outputCanvas.toDataURL('image/png'));
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
      onAudioDropped?.(audioFailure);

      // Whether the declared audio track ever received a sample decides which
      // file this is, and the two are not equally survivable.
      //
      // Partially fed: measured to truncate the audio rather than corrupt the
      // file — players read the samples that are there — so finalizing as-is is
      // the right trade, and it is why a late audio failure is recoverable at
      // all.
      //
      // Fed NOTHING: this is the state the pre-flight exists to prevent and
      // that this file documents as the bad one — a declared track with a full
      // duration and zero packets, measured to stall on playback. It is
      // reachable here despite the pre-flight because a codec can fail
      // asynchronously AFTER configure() succeeded but before emitting its
      // first chunk, which no check made before the muxer was built could have
      // seen.
      //
      // The remedy is a re-mux rather than a failed export, for the same reason
      // the pre-flight degrades instead of throwing: the user asked for a framed
      // video, the video track is complete and correct, and destroying it over
      // an audio track that contributed nothing would cost them the thing they
      // actually wanted. Re-muxing replays the retained chunks into a
      // video-only muxer, which is cheap — no re-encoding, just a container
      // rebuild.
      if (audioPipeline && audioPipeline.readChunkCount() === 0 && outputSize) {
        const videoOnly = new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: 'avc', width: outputSize.width, height: outputSize.height },
          fastStart: 'in-memory',
          // Same reasoning as the first muxer: the chunks being replayed carry
          // the timestamps they were encoded with, so the rebase must match or
          // the timeline shifts.
          firstTimestampBehavior: 'offset',
        });
        for (const { chunk, meta } of videoChunks) videoOnly.addVideoChunk(chunk, meta);
        videoOnly.finalize();
        onProgress?.(1);
        return new Blob([videoOnly.target.buffer], { type: 'video/mp4' });
      }
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
