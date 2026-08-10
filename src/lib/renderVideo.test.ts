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
