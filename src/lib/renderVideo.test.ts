import { test, expect } from 'bun:test';
import {
  estimateFrameCount,
  progressFraction,
  timestampBase,
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
