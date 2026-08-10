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
