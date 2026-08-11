import { test, expect, afterEach } from 'bun:test';
import {
  encodableOutputSize,
  fitsMacroblockBudget,
  H264_MAX_MACROBLOCKS,
  isVideoSupported,
  macroblockCount,
  VIDEO_SIZE_UNSUPPORTED_MESSAGE,
  VIDEO_UNSUPPORTED_MESSAGE,
} from './videoSupport';

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

test('the size message does not blame the browser for a codec limit', () => {
  // These are different problems with different responses. Telling a Chrome
  // user to switch browsers when the real cause is the H.264 level's frame-size
  // cap sends them to install something that fails identically — which is the
  // misdiagnosis that made the original bug take browser instrumentation to
  // find.
  expect(VIDEO_SIZE_UNSUPPORTED_MESSAGE).not.toContain('WebCodecs');
  expect(VIDEO_SIZE_UNSUPPORTED_MESSAGE).not.toContain('Chrome');
  expect(VIDEO_SIZE_UNSUPPORTED_MESSAGE).toContain('too large');
});

/**
 * Sizes measured directly against VideoEncoder.isConfigSupported with codec
 * avc1.640028 in headless Chromium. These are observations, not assumptions:
 * the maximum accepted width was swept at each height, and the macroblock
 * product came out at 8192 (or one row under) every time regardless of shape.
 */
const MEASURED: Array<[number, number, boolean]> = [
  [1080, 1920, true],
  [1088, 1920, true],
  [1920, 1088, true],
  [1024, 2048, true],
  [816, 2560, true],
  // 8 pixels wider than the supported 1088x1920 and already over budget, which
  // is what makes this an area limit rather than a long-edge one.
  [1096, 1920, false],
  [1152, 2048, false],
  [1600, 2800, false],
  [2048, 2048, false],
  [1440, 2560, false],
];

test('the macroblock budget predicts what the browser actually accepts', () => {
  for (const [width, height, supported] of MEASURED) {
    expect(fitsMacroblockBudget(width, height)).toBe(supported);
  }
});

test('a partial macroblock still costs a whole one', () => {
  // 1090 is 68.125 macroblocks wide, which the encoder charges as 69. Rounding
  // this down would under-count the area and let an unencodable size through.
  expect(macroblockCount(1090, 1920)).toBe(69 * 120);
  expect(macroblockCount(1088, 1920)).toBe(68 * 120);
});

test('scaling by the long edge alone does not fit the budget', () => {
  // The obvious rule — cap the long edge at 1920, a standard video height —
  // yields 1096x1920 for the iPhone 8 Plus bezel. That is 8280 macroblocks and
  // was measured REJECTED, so the ceiling has to be on area, not on an edge.
  expect(macroblockCount(1096, 1920)).toBeGreaterThan(H264_MAX_MACROBLOCKS);
  expect(fitsMacroblockBudget(1096, 1920)).toBe(false);
});

test('an oversized frame is scaled to something encodable', () => {
  // The user's actual failure: iPhone 8 Plus Portrait, 1600x2800.
  const { width, height } = encodableOutputSize(1600, 2800);
  expect(fitsMacroblockBudget(width, height)).toBe(true);
  expect(width % 2).toBe(0);
  expect(height % 2).toBe(0);
});

test('scaling preserves the aspect ratio', () => {
  for (const [w, h] of [
    [1600, 2800],
    [4760, 4040],
    [2288, 2973],
    [3800, 2260],
  ]) {
    const out = encodableOutputSize(w, h);
    // Within a percent: the even-pixel rounding cannot land exactly on the
    // source ratio, but a visible stretch would be a real defect.
    expect(Math.abs(out.width / out.height - w / h) / (w / h)).toBeLessThan(0.01);
  }
});

test('a frame already within budget is never scaled up', () => {
  // Apple Watch bezels are small enough to encode as-is. Enlarging them would
  // invent detail and cost encode time for nothing.
  expect(encodableOutputSize(480, 760)).toEqual({ width: 480, height: 760 });
  expect(encodableOutputSize(1080, 1920)).toEqual({ width: 1080, height: 1920 });
});

test('odd dimensions are made even by rounding down, not up', () => {
  // H.264 rejects odd dimensions, and 16 of the shipped frames have one.
  // Rounding UP could cross a macroblock boundary and push a size that just fit
  // back over the budget, so the direction is load-bearing rather than a
  // preference.
  const { width, height } = encodableOutputSize(1179, 2555);
  expect(width % 2).toBe(0);
  expect(height % 2).toBe(0);
  expect(width).toBeLessThanOrEqual(1179);
  expect(height).toBeLessThanOrEqual(2555);
});

test('scaling terminates and fits for extreme aspect ratios', () => {
  // A pathological shape must fail as a small output rather than hang the
  // encode in the fitting loop.
  for (const [w, h] of [
    [8000, 100],
    [100, 8000],
    [10000, 10000],
  ]) {
    const out = encodableOutputSize(w, h);
    expect(fitsMacroblockBudget(out.width, out.height)).toBe(true);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  }
});
