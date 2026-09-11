import { DeviceFrame } from '../hooks/useFrames';

export type RenderStatus =
  | 'detecting'
  | 'queued'
  | 'rendering'
  | 'encoding'
  | 'done'
  | 'error'
  | 'unmatched';

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
  /**
   * Present only on video items. Encoding takes orders of magnitude longer
   * than a still render, so progress has to be reported rather than implied
   * by a spinner.
   */
  video?: { duration: number; frameCount: number; progress: number };

  /**
   * Object URL of the encoded MP4. Unlike the data-URL previews this is not
   * reclaimed by the GC, so it must be revoked when the item is removed or
   * re-queued.
   */
  videoUrl?: string;
}

let nextId = 0;
export const createItemId = () => `item-${nextId++}`;

/**
 * Containers the video path can actually demux.
 *
 * Deliberately narrower than "what a <video> element can play". Demuxing goes
 * through mp4box, which parses ISO-BMFF only, so these three are the whole set
 * — .mp4 and .m4v are ISO-BMFF outright and .mov is the QuickTime layout
 * mp4box also reads.
 *
 * .webm is the case that made this list necessary. It is a Matroska container,
 * which mp4box cannot parse at all, but the <video> element plays it happily —
 * so a dropped VP9 .webm probed fine, auto-detected a device, sat in the queue
 * looking accepted, and only died at encode. Rejecting it at the door is the
 * honest answer: the file was never going to work, and saying so after a
 * successful-looking device match reads as a bug in the app rather than a
 * limitation of the format.
 */
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v'];

/** MIME types matching the containers above, for files that carry one. */
const VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/m4v',
];

/**
 * Shown when a video is refused for its container rather than its codec or the
 * browser. Names what works, because "unsupported" alone leaves the user with
 * nothing to do — and the remedy here is a re-export, which is only obvious if
 * the target format is stated.
 */
export const VIDEO_CONTAINER_UNSUPPORTED_MESSAGE =
  'Only MP4 and MOV videos can be framed. Convert this file to MP4 and try again.';

/**
 * Whether a file is a video this pipeline can frame.
 *
 * Videos take a different render path to images, so the queue has to tell them
 * apart. Some tools hand over screen recordings with an empty `type`, so the
 * extension is a necessary fallback rather than belt-and-braces.
 *
 * The MIME check is an allow-list rather than the `video/*` prefix it used to
 * be, for the same reason the extension list is narrow: `video/webm` with no
 * usable extension would otherwise take the exact path .webm was removed from.
 * When a file carries a video MIME the extension is not consulted, so a
 * correctly-typed file is judged on its type; a `video/*` type outside the
 * list is not a video this app can frame.
 */
export function isVideoFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type.startsWith('video/')) return VIDEO_MIME_TYPES.includes(type);
  if (file.type) return false;
  const name = file.name.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Whether a file LOOKS like a video but is one this pipeline cannot demux.
 *
 * Separate from isVideoFile because the two answer different questions: that
 * one gates the render path, this one gates the error message. A .webm must not
 * be treated as framable, but it also must not be lumped in with the .DS_Store
 * and PDFs that get silently filtered — the user chose a video on purpose and
 * is owed a reason.
 */
export function isUnsupportedVideoFile(file: File): boolean {
  if (isVideoFile(file)) return false;
  if (file.type.toLowerCase().startsWith('video/')) return true;
  // A typeless file whose extension reads as video: same situation, and the
  // extension is all there is to go on.
  const name = file.name.toLowerCase();
  return !file.type && UNSUPPORTED_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Extensions that are recognisably video but not demuxable here. Not
 * exhaustive, and does not need to be — it only decides whether a typeless
 * rejected file gets the specific message or the generic one.
 */
const UNSUPPORTED_VIDEO_EXTENSIONS = ['.webm', '.mkv', '.avi', '.wmv', '.flv', '.ogv', '.mpg', '.mpeg'];

/**
 * The file picker's `accept` filter, derived from the same lists the drop path
 * validates against so the two cannot drift.
 *
 * Spelled out rather than `video/*` because the picker should not advertise
 * formats that will be rejected the moment they are chosen — a user who picks a
 * .webm from a dialog that offered it has been misled by the app, not by their
 * file. The extensions ride along with the MIME types because a screen recorder
 * that writes a typeless file would otherwise be greyed out in the dialog.
 */
export const FILE_ACCEPT_ATTRIBUTE = ['image/*', ...VIDEO_MIME_TYPES, ...VIDEO_EXTENSIONS].join(',');

/**
 * Whether the queue can do anything with a dropped file.
 *
 * A drop carries whatever the user selected — .DS_Store, a PDF, a folder's
 * worth of junk — so the set has to be narrowed before anything is added.
 * Videos pass because they are framed too; filtering to `image/*` here is what
 * used to make a dropped screen recording disappear without a word.
 */
export function isFramableFile(file: File): boolean {
  return file.type.startsWith('image/') || isVideoFile(file);
}

/** Matching tolerance in pixels for auto-detecting a device from screenshot size. */
const TOLERANCE = 2;

/**
 * Generation number of an iPhone frame, used to break screenshot-size ties.
 *
 * Several generations share a screenshot size (the 16 Pro, 17 Pro and 18 Pro
 * are all 1206x2622), so size alone cannot say which phone took a screenshot,
 * and the newest is the likeliest. "12-13" counts as 12. Non-numeric models
 * (the Air) and other categories have no generation and never win a tie.
 */
function iPhoneGeneration(frame: DeviceFrame): number {
  if (frame.category !== 'iPhone') return -Infinity;
  const generation = parseInt(frame.model, 10);
  return Number.isNaN(generation) ? -Infinity : generation;
}

/**
 * The frame a screenshot of this size was most likely taken on.
 *
 * When several devices share the size, the newest iPhone generation wins.
 * Otherwise, and among frames of the same generation, list order decides, which
 * is what keeps the first finish of a model as the default.
 */
export function findFrameByScreenshotSize(
  frames: DeviceFrame[],
  width: number,
  height: number
): DeviceFrame | undefined {
  let best: DeviceFrame | undefined;
  for (const frame of frames) {
    const fw = frame.coordinates.screenshotWidth;
    const fh = frame.coordinates.screenshotHeight;
    const matches =
      typeof fw === 'number' &&
      typeof fh === 'number' &&
      Math.abs(fw - width) <= TOLERANCE &&
      Math.abs(fh - height) <= TOLERANCE;
    if (matches && (!best || iPhoneGeneration(frame) > iPhoneGeneration(best))) {
      best = frame;
    }
  }
  return best;
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
 * Switching size, colour or screen may have no exact counterpart — an 11" iPad
 * might not offer the colour the 13" was using, and the Duo's Outer Open has no
 * landscape frame — so the match falls back progressively rather than
 * returning nothing and disabling the control.
 */
export function findSibling(
  frames: DeviceFrame[],
  frame: DeviceFrame,
  patch: Partial<Pick<DeviceFrame, 'orientation' | 'color' | 'variant' | 'version'>>
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

/**
 * Whether a device's frames are different screens of one phone rather than
 * different phones. The Duo's Inner, Outer and Outer Open views sit in the
 * version slot that Pro and Pro Max use, but they are screens of the same
 * device, so the inspector offers them as a row of their own.
 */
function hasScreenChoice(frame: DeviceFrame): boolean {
  return frame.category === 'iPhone' && frame.model === 'Duo';
}

/** The screens a device can be framed on, in list order; empty unless it has a choice. */
export function screensFor(frames: DeviceFrame[], frame: DeviceFrame): string[] {
  if (!hasScreenChoice(frame)) return [];
  return Array.from(
    new Set(
      frames
        .filter((f) => f.category === frame.category && f.model === frame.model && f.version)
        .map((f) => f.version as string)
    )
  );
}

/**
 * The orientations the inspector offers for a frame's finish.
 *
 * Normally that is what the frame's own model and size come in. A device with a
 * screen choice offers every orientation any of its screens has, so the row
 * does not vanish on a portrait-only screen; the missing one reads as
 * unavailable instead.
 */
export function orientationsFor(
  frames: DeviceFrame[],
  frame: DeviceFrame
): Array<'Portrait' | 'Landscape'> {
  const acrossScreens = hasScreenChoice(frame);
  return Array.from(
    new Set(
      frames
        .filter(
          (f) =>
            f.category === frame.category &&
            f.model === frame.model &&
            (acrossScreens || f.version === frame.version) &&
            f.variant === frame.variant &&
            f.color === frame.color &&
            f.orientation
        )
        .map((f) => f.orientation as 'Portrait' | 'Landscape')
    )
  );
}
