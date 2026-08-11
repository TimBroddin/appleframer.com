import { test, expect } from 'bun:test';
import {
  averageFrameDuration,
  bareAudioSpecificConfig,
  estimateFrameCount,
  FALLBACK_FRAME_DURATION_US,
  PROBE_FAILED_MESSAGE,
  PROBE_TIMEOUT_MS,
  progressFraction,
  timestampBase,
  trackEditWindow,
  trackTimeShift,
} from './renderVideo';

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

test('the probe deadline leaves room for a slow disk but not for a dead card', () => {
  // Both bounds are real failures, not style. Too short rejects a large but
  // perfectly good recording whose moov atom sits at the end of the file, so
  // the read has to seek across the whole thing. Too long and a truncated file
  // holds a detection worker slot while the user watches a card that is
  // already dead.
  expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
});

test('a stalled probe fails with the same message as a rejected one', () => {
  // The two are one problem with one remedy from the user's side, and the
  // detection path routes both to 'unmatched' identically. A second wording
  // would only ask them to tell apart cases they cannot act on differently.
  expect(PROBE_FAILED_MESSAGE).toContain('Could not read this video');
});

test('a track with no edit list is not shifted', () => {
  expect(trackTimeShift(undefined, 15360, 1000)).toBe(0);
  expect(trackTimeShift([], 15360, 1000)).toBe(0);
});

test('media_time cancels the encoder delay baked into the first cts', () => {
  // Measured on every real file here: the H.264 encoder emits a first cts of
  // 1024/15360 = 66666us and the edit list points media_time at exactly that
  // frame. Taking cts at face value would push video 66ms behind the audio.
  expect(trackTimeShift([{ segment_duration: 4000, media_time: 1024 }], 15360, 1000)).toBe(66667);
});

test('an empty edit is a real delay and shifts the track later, not earlier', () => {
  // media_time -1 marks an empty edit. This is how a genuine leading-audio
  // offset is stored — the samples still start at cts 0, so reading cts alone
  // would lose the offset entirely.
  expect(trackTimeShift([{ segment_duration: 56, media_time: -1 }], 44100, 1000)).toBe(-56000);
});

test('an empty edit followed by a real one combines both corrections', () => {
  expect(
    trackTimeShift(
      [
        { segment_duration: 56, media_time: -1 },
        { segment_duration: 3024, media_time: 0 },
      ],
      44100,
      1000
    )
  ).toBe(-56000);
});

test('a track with no edit list has nothing to cut', () => {
  // Most files. This is what keeps the untrimmed path free of any filtering.
  expect(trackEditWindow(undefined, 1000).end).toBe(Number.POSITIVE_INFINITY);
  expect(trackEditWindow([], 1000).end).toBe(Number.POSITIVE_INFINITY);
});

test('a trimming edit ends where its segment does, so cut footage stays cut', () => {
  // The measured failure: 4167ms of media behind an edit that selects 2000ms of
  // it. Honouring only the shift restored all 122 frames instead of 60.
  const window = trackEditWindow(
    [
      { segment_duration: 66, media_time: -1 },
      { segment_duration: 2000, media_time: 1024 },
    ],
    1000
  );
  // The empty edit is lead time trackTimeShift already folded into the shift,
  // so the media starts there rather than at zero.
  expect(window.start).toBe(66_000);
  expect(window.end).toBe(2_066_000);
});

test('an edit covering its whole media cuts nothing', () => {
  // The ordinary encoder-delay edit list every recording carries. If this ever
  // starts cutting, untrimmed exports lose their final frames.
  const window = trackEditWindow([{ segment_duration: 4167, media_time: 1024 }], 1000);
  expect(window.end).toBe(4_167_000);
});

test('a zero-duration edit is not read as a trim to the empty set', () => {
  // Some writers leave segment_duration at 0 meaning "to the end". Treating it
  // literally would drop every sample and export an empty video.
  expect(trackEditWindow([{ segment_duration: 0, media_time: 0 }], 1000).end).toBe(
    Number.POSITIVE_INFINITY
  );
});

test('a list of nothing but empty edits leaves the track unbounded', () => {
  // No media is selected at all, but a file this code has always exported must
  // not silently become an empty one.
  expect(trackEditWindow([{ segment_duration: 56, media_time: -1 }], 1000).end).toBe(
    Number.POSITIVE_INFINITY
  );
});

test('only the first real edit is honoured, so a cut list degrades to a prefix', () => {
  // Multi-segment lists are explicitly unsupported. The guarantee under test is
  // that the result is a PREFIX — short, never scrambled and never longer than
  // the source claims — rather than the two segments concatenated wrongly.
  const window = trackEditWindow(
    [
      { segment_duration: 1000, media_time: 0 },
      { segment_duration: 1000, media_time: 5000 },
    ],
    1000
  );
  expect(window.end).toBe(1_000_000);
});

test('with no audio the base is the video start, so video rebases to zero', () => {
  expect(timestampBase(66666, undefined)).toBe(66666);
});

test('the base is the earliest of the two tracks, not each track its own', () => {
  // The whole point: subtracting one shared base preserves the gap between the
  // tracks. Rebasing each track by its own start would collapse the gap to zero
  // and desync the audio.
  expect(timestampBase(66666, 0)).toBe(0);
  expect(timestampBase(0, 80000)).toBe(0);
});

test('a clip that starts late rebases to zero without losing the gap', () => {
  // A trimmed clip: neither track starts at zero, but audio still leads video
  // by 80000us and must keep doing so after the shift.
  const base = timestampBase(580000, 500000);
  expect(base).toBe(500000);
  expect(580000 - base).toBe(80000);
  expect(500000 - base).toBe(0);
});

// The muxer rejects a duration that is null, negative or NaN
// ("addVideoChunkRaw's fourth argument (duration) must be a non-negative real
// number"), and a zero collapses a frame to no on-screen time. These assert the
// fallback can never produce any of them, which is the property that keeps
// Firefox and WebKit encoding at all.

test('the mean is measured across intervals, not frames', () => {
  // 90 frames spanning 2.966667s at 30fps: 89 intervals of 33333us.
  expect(averageFrameDuration(2_966_667, 90)).toBe(33333);
});

test('a variable-frame-rate source averages its real span rather than assuming 30fps', () => {
  // The real simulator recording: 66 decoded frames across 4.118333s. The mean
  // is ~63ms, nearly double 1/30s — stamping 33333 on these would rewrite a
  // 4.1s recording as a 2.2s one.
  const mean = averageFrameDuration(4_118_333, 66);
  expect(mean).toBe(63359);
  expect(mean).toBeGreaterThan(FALLBACK_FRAME_DURATION_US);
  // The mean reproduces the source's own span, which is the property that makes
  // it safe for an irregular track.
  expect(mean * 65).toBeCloseTo(4_118_333, -3);
});

test('a track too short or too degenerate to measure falls back to 1/30s', () => {
  expect(averageFrameDuration(0, 1)).toBe(FALLBACK_FRAME_DURATION_US);
  expect(averageFrameDuration(1_000_000, 1)).toBe(FALLBACK_FRAME_DURATION_US);
  expect(averageFrameDuration(0, 90)).toBe(FALLBACK_FRAME_DURATION_US);
});

test('never returns a value the muxer would reject', () => {
  // A negative span (unordered timestamps) and NaN are the exact classes of
  // value that made the muxer throw.
  expect(averageFrameDuration(-5_000_000, 90)).toBe(FALLBACK_FRAME_DURATION_US);
  expect(averageFrameDuration(NaN, 90)).toBe(FALLBACK_FRAME_DURATION_US);
  expect(averageFrameDuration(1_000_000, NaN)).toBe(FALLBACK_FRAME_DURATION_US);
  expect(averageFrameDuration(Infinity, 90)).toBe(FALLBACK_FRAME_DURATION_US);
  // A span shorter than the frame count would round to zero.
  expect(averageFrameDuration(10, 90)).toBe(FALLBACK_FRAME_DURATION_US);
  for (const [span, count] of [[-1, 5], [0, 0], [NaN, NaN], [10, 90], [4_118_333, 66]]) {
    const d = averageFrameDuration(span, count);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
  }
});

test('the constant fallback is a real 30fps interval', () => {
  expect(FALLBACK_FRAME_DURATION_US).toBe(33333);
});

// The two engines disagree about what AudioEncoder's decoderConfig.description
// contains, and muxing WebKit's answer verbatim produced an audio track ffprobe
// reported as "Audio object type 0 ... 0 channels" and could not open. Both byte
// sequences below were captured from the real encoders on the same 48kHz stereo
// AAC config, and both must reduce to the same AudioSpecificConfig.

test("Chromium's description is already a bare AudioSpecificConfig", () => {
  // 0x1190: AAC-LC, 48kHz, stereo. Not a descriptor chain, so it passes through
  // untouched rather than being misread as one.
  const asc = new Uint8Array([0x11, 0x90]);
  expect(Array.from(bareAudioSpecificConfig(asc))).toEqual([0x11, 0x90]);
});

test("WebKit's whole ES_Descriptor is unwrapped to the same config", () => {
  // Captured from WebKit: ES_Descriptor(0x03) > DecoderConfigDescriptor(0x04) >
  // DecoderSpecificInfo(0x05) > 0x1190 — the identical ASC Chromium returns
  // directly, buried 39 bytes deep.
  const webkit = new Uint8Array(
    ('038080802200000004808080144014001800000000000000000005808080021190068080800102'.match(
      /../g
    ) as string[]).map((h) => parseInt(h, 16))
  );
  expect(Array.from(bareAudioSpecificConfig(webkit))).toEqual([0x11, 0x90]);
});

test('an unrecognisable description is passed through rather than guessed at', () => {
  // Returning the input identity-equal is what lets the caller skip allocating.
  const odd = new Uint8Array([0xff, 0x00, 0x12]);
  expect(bareAudioSpecificConfig(odd)).toBe(odd);
  const empty = new Uint8Array([]);
  expect(bareAudioSpecificConfig(empty)).toBe(empty);
});

test('a truncated descriptor is not read past its own buffer', () => {
  // A descriptor claiming more bytes than it has must return the original
  // rather than reading whatever follows it in memory.
  const truncated = new Uint8Array([0x03, 0x82]);
  expect(bareAudioSpecificConfig(truncated)).toBe(truncated);
  const lying = new Uint8Array([0x05, 0x40]);
  expect(bareAudioSpecificConfig(lying)).toBe(lying);
});
