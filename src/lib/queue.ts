import { DeviceFrame } from '../hooks/useFrames';

export type RenderStatus = 'queued' | 'rendering' | 'done' | 'error';

export interface QueueItem {
  /** Stable identity for React keys and selection, independent of array order. */
  id: string;
  file: File;
  /** Per-image device, auto-detected on drop and overridable via the inspector. */
  frame: DeviceFrame;
  status: RenderStatus;
  /** Object URL of the rendered PNG. Owned by the queue, revoked on replace/remove. */
  blobUrl?: string;
  /** Raw screenshot preview, shown until the framed render lands. */
  sourceUrl: string;
  error?: string;
}

let nextId = 0;
export const createItemId = () => `item-${nextId++}`;

/** Matching tolerance in pixels for auto-detecting a device from screenshot size. */
const TOLERANCE = 2;

export function findFrameByScreenshotSize(
  frames: DeviceFrame[],
  width: number,
  height: number
): DeviceFrame | undefined {
  return frames.find((frame) => {
    const fw = frame.coordinates.screenshotWidth;
    const fh = frame.coordinates.screenshotHeight;
    return (
      typeof fw === 'number' &&
      typeof fh === 'number' &&
      Math.abs(fw - width) <= TOLERANCE &&
      Math.abs(fh - height) <= TOLERANCE
    );
  });
}

/** Human label for a frame, e.g. "16 Pro Max" or "iPad Pro 13". */
export function frameLabel(frame: DeviceFrame): string {
  const parts = [frame.model, frame.version, frame.variant].filter(
    (part): part is string => Boolean(part)
  );
  // For iPhone the model is the numeric series ("16") and version is the tier
  // ("Pro Max"), which reads correctly when joined. iPad/Watch follow the same
  // model → version → variant order.
  return parts.join(' ') || frame.coordinates.name;
}

/** Longer label including colour, for the inspector summary line. */
export function frameLabelDetailed(frame: DeviceFrame): string {
  const base = frameLabel(frame);
  return frame.color ? `${base} · ${frame.color}` : base;
}

/**
 * Finds the equivalent frame in another orientation/colour, keeping every other
 * facet fixed. Returns undefined when no such variant exists.
 */
export function findSibling(
  frames: DeviceFrame[],
  frame: DeviceFrame,
  patch: Partial<Pick<DeviceFrame, 'orientation' | 'color'>>
): DeviceFrame | undefined {
  const target = { ...frame, ...patch };
  return frames.find(
    (candidate) =>
      candidate.category === target.category &&
      candidate.model === target.model &&
      candidate.version === target.version &&
      candidate.variant === target.variant &&
      candidate.color === target.color &&
      candidate.orientation === target.orientation
  );
}
