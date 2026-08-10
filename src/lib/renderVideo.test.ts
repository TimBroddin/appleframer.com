import { test, expect } from 'bun:test';
import { estimateFrameCount, progressFraction } from './renderVideo';

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
