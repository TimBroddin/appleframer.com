import { test, expect } from 'bun:test';
import { frameLabel, frameLabelDetailed } from './queue';
import { DeviceFrame } from '../hooks/useFrames';

const make = (over: Partial<DeviceFrame>): DeviceFrame => ({
  id: 'x',
  category: 'iPhone',
  deviceType: '16',
  model: '16',
  coordinates: { x: '0', y: '0', name: 'fallback' },
  ...over,
});

test('iPhone labels lead with the category', () => {
  // "16 Pro" alone does not read as a product name.
  expect(frameLabel(make({ model: '16', version: 'Pro' }))).toBe('iPhone 16 Pro');
  expect(frameLabel(make({ model: '16', version: 'Pro Max' }))).toBe('iPhone 16 Pro Max');
});

test('"Standard" is dropped as a data placeholder', () => {
  expect(frameLabel(make({ model: '16', version: 'Standard' }))).toBe('iPhone 16');
});

test('iPad does not repeat its category', () => {
  expect(
    frameLabel(
      make({ category: 'iPad', model: 'Pro', version: '2024', variant: '13' })
    )
  ).toBe('iPad Pro 2024 13');
});

test('bare iPad keeps its version', () => {
  expect(
    frameLabel(make({ category: 'iPad', model: 'Standard', version: '2021' }))
  ).toBe('iPad 2021');
});

test('Watch is labelled Apple Watch', () => {
  expect(
    frameLabel(
      make({ category: 'Watch', model: 'Ultra', version: '2024' })
    )
  ).toBe('Apple Watch Ultra 2024');
});

test('undefined frame reads as detecting', () => {
  expect(frameLabel(undefined)).toBe('Detecting…');
  expect(frameLabelDetailed(undefined)).toBe('Detecting…');
});

test('detailed label appends the colour', () => {
  expect(
    frameLabelDetailed(make({ model: '17', version: 'Pro', color: 'Cosmic Orange' }))
  ).toBe('iPhone 17 Pro · Cosmic Orange');
});

test('falls back to the coordinate name when nothing else is set', () => {
  const frame = make({ category: '', model: '', version: undefined });
  expect(frameLabel(frame)).toBe('fallback');
});
