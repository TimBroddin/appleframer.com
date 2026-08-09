import { test, expect } from 'bun:test';
import {
  buildFilename,
  buildUniqueFilenames,
  deserializeTokens,
  sanitizeFilename,
  DEFAULT_TOKENS,
  NameToken,
} from './filename';
import { DeviceFrame } from '../hooks/useFrames';

const frame: DeviceFrame = {
  id: 'iPhone-16-Pro Max-Portrait',
  category: 'iPhone',
  deviceType: '16',
  model: '16',
  version: 'Pro Max',
  orientation: 'Portrait',
  coordinates: { x: '0', y: '0', name: 'iPhone 16 Pro Max Portrait' },
};

const ipad: DeviceFrame = {
  id: 'iPad-Pro-2024-13',
  category: 'iPad',
  deviceType: 'Pro',
  model: 'Pro',
  version: '2024',
  variant: '13',
  coordinates: { x: '0', y: '0', name: 'iPad Pro 13' },
};

test('default tokens produce framed-<original>', () => {
  expect(buildFilename(DEFAULT_TOKENS, 'home.png', frame, 0)).toBe('framed-home');
});

test('field tokens read from the frame', () => {
  const tokens: NameToken[] = [
    { kind: 'model' },
    { kind: 'separator', value: '-' },
    { kind: 'version' },
  ];
  expect(buildFilename(tokens, 'x.png', frame, 0)).toBe('16-Pro Max');
});

test('index token is 1-based and zero-padded', () => {
  expect(buildFilename([{ kind: 'index' }], 'x.png', frame, 0)).toBe('01');
  expect(buildFilename([{ kind: 'index' }], 'x.png', frame, 11)).toBe('12');
});

test('path traversal in the original name is stripped', () => {
  expect(buildFilename([{ kind: 'original' }], '../../etc/passwd.png', frame, 0)).toBe(
    'etcpasswd'
  );
});

test('a dot in a legitimate variant survives sanitising', () => {
  // iPad variants like "12.9" must not be mangled into nothing.
  expect(sanitizeFilename('iPad-Pro-12.9')).toBe('iPad-Pro-12.9');
});

test('empty result falls back rather than emitting a bare extension', () => {
  // A colour token on a frame with no colour yields an empty string.
  expect(buildFilename([{ kind: 'color' }], 'shot.png', frame, 0)).toBe('framed-shot');
});

test('empty result with an unusable original still yields a usable name', () => {
  // "..." strips to ".." which sanitises away, leaving the "framed-" stem.
  expect(buildFilename([{ kind: 'color' }], '...', frame, 0)).toBe('framed');
});

test('a separator-only token list still yields a usable name', () => {
  expect(buildFilename([{ kind: 'separator', value: '-' }], '-', frame, 0)).toBe('framed');
});

test('duplicate names are suffixed rather than silently dropped', () => {
  const tokens: NameToken[] = [{ kind: 'model' }];
  const names = buildUniqueFilenames(tokens, [
    { name: 'a.png', frame },
    { name: 'b.png', frame },
    { name: 'c.png', frame },
  ]);
  expect(names).toEqual(['16', '16-2', '16-3']);
});

test('suffixing steps past a name that already exists literally', () => {
  const tokens: NameToken[] = [{ kind: 'original' }];
  const names = buildUniqueFilenames(tokens, [
    { name: 'shot.png', frame },
    { name: 'shot-2.png', frame },
    { name: 'shot.png', frame },
  ]);
  expect(names).toEqual(['shot', 'shot-2', 'shot-3']);
});

test('mixed devices in one batch use their own frame values', () => {
  const tokens: NameToken[] = [{ kind: 'category' }];
  const names = buildUniqueFilenames(tokens, [
    { name: 'a.png', frame },
    { name: 'b.png', frame: ipad },
  ]);
  expect(names).toEqual(['iPhone', 'iPad']);
});

test('deserialize falls back on malformed input', () => {
  expect(deserializeTokens(null)).toEqual(DEFAULT_TOKENS);
  expect(deserializeTokens('not json')).toEqual(DEFAULT_TOKENS);
  expect(deserializeTokens('[]')).toEqual(DEFAULT_TOKENS);
});
