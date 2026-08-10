import { DeviceFrame } from '../hooks/useFrames';

/**
 * Filenames are composed from an ordered list of tokens rather than a free-text
 * pattern string. The design's naming row is a chip composer, and tokens keep
 * the value structurally valid — there is no way to type a broken pattern.
 */

export type TokenKind =
  | 'original'
  | 'category'
  | 'model'
  | 'version'
  | 'variant'
  | 'color'
  | 'orientation'
  | 'index'
  | 'separator'
  | 'text';

export interface NameToken {
  kind: TokenKind;
  /** Literal content for 'separator' and 'text' tokens. */
  value?: string;
}

export const FIELD_TOKENS: Array<{ kind: TokenKind; label: string }> = [
  { kind: 'original', label: 'original' },
  { kind: 'category', label: 'category' },
  { kind: 'model', label: 'model' },
  { kind: 'version', label: 'version' },
  { kind: 'variant', label: 'variant' },
  { kind: 'color', label: 'color' },
  { kind: 'orientation', label: 'orientation' },
  { kind: 'index', label: 'index' },
];

export const SEPARATOR_TOKENS: Array<{ value: string; label: string }> = [
  { value: '-', label: 'dash' },
  { value: '_', label: 'underscore' },
  { value: ' ', label: 'space' },
  { value: '.', label: 'dot' },
];

export const DEFAULT_TOKENS: NameToken[] = [
  { kind: 'text', value: 'framed' },
  { kind: 'separator', value: '-' },
  { kind: 'original' },
];

/**
 * Strips characters that are unsafe in a filename. Both the tokens and the
 * values substituted into them can contain these: an uploaded file may be named
 * "../foo.png", and some frame models legitimately contain a dot ("12.9").
 */
export function sanitizeFilename(value: string): string {
  return value
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/--+/g, '-')
    .replace(/__+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[-_\s.]+|[-_\s.]+$/g, '');
}

function tokenValue(
  token: NameToken,
  originalName: string,
  /** Absent while a dropped image is still being matched to a device. */
  frame: DeviceFrame | undefined,
  index: number
): string {
  switch (token.kind) {
    case 'original':
      return originalName.replace(/\.[^/.]+$/, '');
    case 'category':
      return frame?.category || '';
    case 'model':
      return frame?.model || '';
    case 'version':
      return frame?.version || '';
    case 'variant':
      return frame?.variant || '';
    case 'color':
      return frame?.color || '';
    case 'orientation':
      return frame?.orientation || '';
    case 'index':
      return String(index + 1).padStart(2, '0');
    case 'separator':
    case 'text':
      return token.value ?? '';
    default:
      return '';
  }
}

/** Builds the filename (without extension) for one image. */
export function buildFilename(
  tokens: NameToken[],
  originalName: string,
  frame: DeviceFrame | undefined,
  index: number
): string {
  const raw = tokens
    .map((token) => tokenValue(token, originalName, frame, index))
    .join('');

  // An empty result would make every image in a batch collide on the same zip
  // entry, so fall back rather than emitting a bare ".png". The "framed"
  // literal guarantees the fallback is never itself empty.
  const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '');
  return sanitizeFilename(raw) || sanitizeFilename(`framed-${nameWithoutExt}`);
}

/**
 * Assigns unique names across a batch. Distinct images can produce the same
 * name — either because sanitizing collapses them together, or because the
 * tokens omit {original} and are therefore identical for every image. Zip
 * writers silently keep only the last entry, so duplicates get suffixed.
 */
export function buildUniqueFilenames(
  tokens: NameToken[],
  entries: Array<{
    name: string;
    frame: DeviceFrame | undefined;
    /**
     * Position to use for the {index} token. Pass the item's index in the full
     * queue when exporting a subset, otherwise an image shown as 03 elsewhere
     * would be renumbered to 01 in the archive.
     */
    index?: number;
  }>
): string[] {
  const used = new Set<string>();
  return entries.map((entry, position) => {
    const base = buildFilename(tokens, entry.name, entry.frame, entry.index ?? position);
    // Step past any suffix that is itself already taken, so a batch holding
    // both "shot.png" twice and a literal "shot-2.png" still stays unique.
    let filename = base;
    let suffix = 2;
    while (used.has(filename)) {
      filename = `${base}-${suffix}`;
      suffix++;
    }
    used.add(filename);
    return filename;
  });
}

/** Serialises tokens for localStorage. */
export function serializeTokens(tokens: NameToken[]): string {
  return JSON.stringify(tokens);
}

export function deserializeTokens(raw: string | null): NameToken[] {
  if (!raw) return DEFAULT_TOKENS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TOKENS;
    // Guard against older or hand-edited values.
    const valid = parsed.filter(
      (token): token is NameToken =>
        token && typeof token === 'object' && typeof token.kind === 'string'
    );
    return valid.length > 0 ? valid : DEFAULT_TOKENS;
  } catch {
    return DEFAULT_TOKENS;
  }
}
