import { DeviceFrame } from '../hooks/useFrames';

export type RenderStatus = 'detecting' | 'queued' | 'rendering' | 'done' | 'error' | 'unmatched';

export interface QueueItem {
  /** Stable identity for React keys and selection, independent of array order. */
  id: string;
  file: File;
  /**
   * Per-image device, auto-detected on drop and overridable via the inspector.
   * Undefined while detection is still running, or when nothing matched.
   */
  frame?: DeviceFrame;
  status: RenderStatus;
  /**
   * Downscaled framed preview as a data URL, for the card and the single view.
   * The full-resolution PNG is rendered on demand at export rather than held
   * for every image in the batch.
   */
  previewUrl?: string;
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

/**
 * Human label for a frame, e.g. "iPhone 16 Pro Max" or "iPad Pro 13".
 *
 * The category leads because the model alone is ambiguous: an iPhone's model is
 * the bare series number ("16"), which reads as nothing on its own.
 */
export function frameLabel(frame: DeviceFrame | undefined): string {
  if (!frame) return 'Detecting…';

  // "Watch" is the category in the data but the product is "Apple Watch".
  const category = frame.category === 'Watch' ? 'Apple Watch' : frame.category;

  const parts = [category, frame.model, frame.version, frame.variant]
    .filter((part): part is string => Boolean(part))
    // "Standard" is a data placeholder for the base tier, not a product name —
    // "iPhone 16 Standard" should read "iPhone 16".
    .filter((part) => part !== 'Standard');

  // iPad repeats the category in the model ("iPad" > "Pro"), so drop the
  // duplicate rather than emitting "iPad iPad Pro".
  const deduped = parts.filter(
    (part, index) => index === 0 || part.toLowerCase() !== parts[0].toLowerCase()
  );
  return deduped.join(' ') || frame.coordinates.name;
}

/** Longer label including colour, for the inspector summary line. */
export function frameLabelDetailed(frame: DeviceFrame | undefined): string {
  const base = frameLabel(frame);
  return frame?.color ? `${base} · ${frame.color}` : base;
}

/**
 * Groups items by device, preserving first-appearance order both between
 * groups and within them.
 *
 * The sheet and shift-range selection must agree on the order cards appear in,
 * so both derive it from here rather than each computing its own.
 */
export function groupItemsByDevice(items: QueueItem[]): Array<[string, QueueItem[]]> {
  const groups = new Map<string, QueueItem[]>();
  items.forEach((item) => {
    const key = frameLabel(item.frame);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  });
  return Array.from(groups.entries());
}

/** The order cards actually appear in, which grouping changes. */
export function displayOrder(items: QueueItem[], groupByDevice: boolean): QueueItem[] {
  if (!groupByDevice) return items;
  return groupItemsByDevice(items).flatMap(([, groupItems]) => groupItems);
}

/**
 * Finds the equivalent frame with one facet changed, keeping the rest fixed.
 *
 * Switching size or colour may have no exact counterpart — an 11" iPad might
 * not offer the colour the 13" was using — so the match falls back
 * progressively rather than returning nothing and disabling the control.
 */
export function findSibling(
  frames: DeviceFrame[],
  frame: DeviceFrame,
  patch: Partial<Pick<DeviceFrame, 'orientation' | 'color' | 'variant'>>
): DeviceFrame | undefined {
  const target = { ...frame, ...patch };
  const sameModel = frames.filter(
    (candidate) =>
      candidate.category === target.category &&
      candidate.model === target.model &&
      candidate.version === target.version &&
      candidate.variant === target.variant
  );

  return (
    sameModel.find(
      (c) => c.color === target.color && c.orientation === target.orientation
    ) ??
    // Keep the orientation before the colour: a portrait shot flipped to
    // landscape is far more disruptive than a different finish.
    sameModel.find((c) => c.orientation === target.orientation) ??
    sameModel.find((c) => c.color === target.color) ??
    sameModel[0]
  );
}
