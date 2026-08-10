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
