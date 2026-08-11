import { DeviceFrame, getFramePath } from '../hooks/useFrames';

/**
 * The single canvas pipeline for compositing a screenshot into a device frame.
 *
 * This used to exist twice — once in FramePreview for the on-screen canvas and
 * once in ScreenshotFramer for the zip export — and the two copies had already
 * drifted apart. The render queue needs one authoritative implementation, so
 * both callers now come through here.
 */

/** Anything drawImage accepts and that reports intrinsic dimensions. */
export type ImageSource = ImageBitmap | HTMLImageElement | VideoFrame;

/**
 * VideoFrame reports displayWidth/displayHeight rather than width/height.
 * Display dimensions are the correct choice: coded dimensions are padded up to
 * macroblock boundaries, and compositing that padding shows as an edge artifact
 * inside the bezel.
 */
export const sourceWidth = (src: ImageSource): number =>
  'displayWidth' in src ? src.displayWidth : src.width;

export const sourceHeight = (src: ImageSource): number =>
  'displayHeight' in src ? src.displayHeight : src.height;

export interface RenderOptions {
  /** Solid background behind the device, or null for transparent. */
  backgroundColor?: string | null;
  /** Abort signal — checked at each async boundary so superseded renders stop early. */
  signal?: AbortSignal;
  /**
   * Reusable scratch canvas. Video calls this once per frame; allocating a
   * canvas each time is ~1,800 allocations per minute at 30fps and dominates
   * encode time. Omit it and one is allocated per call, as before.
   */
  scratchCanvas?: HTMLCanvasElement;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

class AbortError extends Error {
  constructor() {
    super('Render aborted');
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortError();
}

/** Frame assets are immutable and reused across every image in a batch. */
const frameAssetCache = new Map<string, Promise<FrameAssets>>();

interface FrameAssets {
  frameImg: HTMLImageElement;
  maskImg: HTMLImageElement | null;
  /** Identity of the mask file, used as the stencil cache key. */
  maskPath: string;
}

function loadFrameAssets(frame: DeviceFrame): Promise<FrameAssets> {
  const frameName = frame.coordinates.name;
  const frameDir = getFramePath(frame);
  const framePath = `/frames/${frameDir}/${frameName}.png`;
  const maskPath = `/frames/${frameDir}/${frameName}_mask.png`;

  const cached = frameAssetCache.get(framePath);
  if (cached) return cached;

  const pending = (async () => {
    const frameImg = await loadImage(framePath);
    let maskImg: HTMLImageElement | null = null;
    try {
      maskImg = await loadImage(maskPath);
    } catch {
      // Not every frame ships a mask; the destination-out pass below still
      // clips corners correctly without one.
    }
    return { frameImg, maskImg, maskPath };
  })();

  frameAssetCache.set(framePath, pending);
  // A failed load must not poison the cache for later retries.
  pending.catch(() => frameAssetCache.delete(framePath));
  return pending;
}

/**
 * Cached alpha stencils, keyed by mask file and the size it was rasterised at.
 *
 * The stencil depends only on the mask PNG and the screen rectangle's
 * dimensions — never on the screenshot — so for video it is the same object for
 * every frame of the clip. Computing it per frame is what made masked devices
 * cost ~6x a maskless one: measured 21.1ms against 3.6ms per composite at the
 * iPhone 16 Pro's bezel, i.e. roughly 3s of pure mask work in a 5-second clip.
 *
 * Bounded because a session can touch many devices and the entries are large
 * (a 1206x2622 stencil is ~12MB of backing store). Eviction is
 * least-recently-used via Map insertion order, which for the realistic access
 * pattern — one device for a whole clip, or a handful across a batch — never
 * evicts anything in the hot path.
 */
const maskStencilCache = new Map<string, HTMLCanvasElement>();
const MAX_CACHED_STENCILS = 8;

/**
 * A canvas whose alpha is 1 exactly where the mask says "hide this pixel".
 *
 * Replaces a per-pixel JS loop over getImageData that ran on every frame. The
 * expensive part — thresholding the mask — happens once here; applying it is
 * then a single `destination-out` composite, which the compositor does rather
 * than the main thread.
 *
 * The threshold semantics are preserved exactly: near-black, not pure black,
 * counts as masked, because some masks use (0,0,1). Anything at or above the
 * threshold in any channel keeps its pixel, matching the original `&&`.
 */
function maskStencil(
  maskImg: HTMLImageElement,
  maskPath: string,
  width: number,
  height: number
): HTMLCanvasElement {
  // The size is part of the key: the same mask rasterised for a different
  // screen rectangle is a different stencil, and reusing one across sizes would
  // erase the wrong pixels.
  const key = `${maskPath}@${width}x${height}`;
  const cached = maskStencilCache.get(key);
  if (cached) {
    // Refresh recency so the LRU eviction below keeps what is actually in use.
    maskStencilCache.delete(key);
    maskStencilCache.set(key, cached);
    return cached;
  }

  const stencil = document.createElement('canvas');
  stencil.width = width;
  stencil.height = height;
  const stencilCtx = stencil.getContext('2d');
  if (!stencilCtx) throw new Error('No mask canvas context');
  // Same reason as everywhere else in this file: interpolation across the mask
  // edge bleeds screenshot pixels past it in Safari.
  stencilCtx.imageSmoothingEnabled = false;
  stencilCtx.drawImage(maskImg, 0, 0, width, height);

  const data = stencilCtx.getImageData(0, 0, width, height);
  const pixels = data.data;
  const threshold = 10;
  for (let i = 0; i < pixels.length; i += 4) {
    // Treat near-black as masked: some masks use (0,0,1) rather than pure black.
    const masked =
      pixels[i] < threshold && pixels[i + 1] < threshold && pixels[i + 2] < threshold;
    // Opaque black where the screenshot must be erased, fully transparent
    // elsewhere. destination-out subtracts by alpha, so only this channel is
    // load-bearing; the colour channels are zeroed to keep the stencil's
    // meaning obvious rather than incidental.
    pixels[i] = 0;
    pixels[i + 1] = 0;
    pixels[i + 2] = 0;
    pixels[i + 3] = masked ? 255 : 0;
  }
  stencilCtx.putImageData(data, 0, 0);

  maskStencilCache.set(key, stencil);
  if (maskStencilCache.size > MAX_CACHED_STENCILS) {
    // Map iteration is insertion order, so the first key is the least recently
    // used given the refresh above.
    const oldest = maskStencilCache.keys().next().value;
    if (oldest !== undefined) maskStencilCache.delete(oldest);
  }
  return stencil;
}

/**
 * Composites `screenImg` into `frame` on `canvas`, sizing the canvas to the
 * frame's natural dimensions.
 */
export async function renderFrameToCanvas(
  canvas: HTMLCanvasElement,
  screenImg: ImageSource,
  frame: DeviceFrame,
  { backgroundColor = null, signal, scratchCanvas }: RenderOptions = {}
): Promise<void> {
  throwIfAborted(signal);

  const { frameImg, maskImg, maskPath } = await loadFrameAssets(frame);
  throwIfAborted(signal);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas context');

  canvas.width = frameImg.width;
  canvas.height = frameImg.height;

  // Setting width/height resets context state, so smoothing is disabled after
  // the resize. Smoothing causes screenshot pixels to bleed past the mask in
  // Safari.
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Fill the background on the MAIN canvas only. The temp canvas below relies
  // on transparency for the mask and the destination-out frame erase, so
  // filling it there would defeat the corner clipping.
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const tempCanvas = scratchCanvas ?? document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) throw new Error('No temp canvas context');
  // A reused scratch canvas still holds the previous frame's pixels. Sizing a
  // FRESH canvas already clears it, but assigning the same width/height to an
  // already-that-size canvas is a no-op in most engines, so the clear below
  // cannot be inferred from the resize above and must happen unconditionally.
  tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
  tempCtx.imageSmoothingEnabled = false;

  const { x, y, screenshotWidth, screenshotHeight } = frame.coordinates;
  const screenshotX = parseInt(x);
  const screenshotY = parseInt(y);
  const targetWidth = screenshotWidth || sourceWidth(screenImg);
  const targetHeight = screenshotHeight || sourceHeight(screenImg);

  // The screenshot fills the screen area exactly. A 3px inset used to guard
  // against bleeding past rounded corners on maskless frames, but the
  // destination-out pass below now does that properly using the frame's own
  // alpha. On frames whose screen area is fully transparent — the iPad Pro 13,
  // for one — the inset left a 3px hole ringing the screen that showed as a
  // pale halo in the preview and baked into exports.
  const adjustedWidth = targetWidth;
  const adjustedHeight = targetHeight;
  const adjustedX = screenshotX;
  const adjustedY = screenshotY;

  if (maskImg) {
    tempCtx.clearRect(0, 0, canvas.width, canvas.height);
    tempCtx.drawImage(screenImg, adjustedX, adjustedY, adjustedWidth, adjustedHeight);

    // Erase the masked pixels by compositing rather than by walking them in JS.
    // This used to be a getImageData/putImageData round trip with a per-pixel
    // loop, which re-derived an identical result for every frame of a video;
    // the stencil is now computed once per (mask, size) and cached. See
    // maskStencil.
    const stencil = maskStencil(maskImg, maskPath, adjustedWidth, adjustedHeight);
    tempCtx.globalCompositeOperation = 'destination-out';
    tempCtx.drawImage(stencil, adjustedX, adjustedY);
    tempCtx.globalCompositeOperation = 'source-over';
  } else {
    tempCtx.drawImage(screenImg, adjustedX, adjustedY, adjustedWidth, adjustedHeight);
  }

  // The corner masks are plain square blocks rather than the screen's rounded
  // silhouette, so they leave screenshot pixels underneath the frame's rounded
  // corner. Erase everything the frame body covers using its own alpha channel,
  // which is the authoritative screen shape. This also softens the edge against
  // the frame's antialiasing.
  tempCtx.globalCompositeOperation = 'destination-out';
  tempCtx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
  tempCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(tempCanvas, 0, 0);
  ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
}

/**
 * Decodes a file to a bitmap.
 *
 * createImageBitmap decodes off the main thread, so it neither blocks the UI
 * nor pays the layout cost of an <img>. A large screenshot batch is dominated
 * by decode time, which makes this the single biggest win in the pipeline.
 */
export async function decodeFile(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file);
  }
  // Safari < 15 and other older engines.
  const url = URL.createObjectURL(file);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function closeBitmap(source: ImageSource | undefined) {
  // Bitmaps hold decoded pixels outside the JS heap; a 250MB batch will exhaust
  // memory if they are not released explicitly.
  if (source && 'close' in source) source.close();
}

/**
 * Renders a downscaled preview for the contact sheet.
 *
 * Cards display at roughly 180px, so encoding a full 2300x3000 PNG for each one
 * is wasted work on upload — the expensive full-resolution render is deferred
 * to export, where it is actually needed. Returns a data URL rather than an
 * object URL so there is no lifetime to manage for something this small.
 */
export async function renderFramePreview(
  file: File,
  frame: DeviceFrame,
  options: RenderOptions & { source?: ImageSource; maxHeight?: number } = {}
): Promise<string> {
  const { maxHeight = 420, source: provided, ...rest } = options;
  const screenImg = provided ?? (await decodeFile(file));
  try {
    throwIfAborted(rest.signal);

    const full = document.createElement('canvas');
    await renderFrameToCanvas(full, screenImg, frame, rest);
    throwIfAborted(rest.signal);

    // Downscale in one step. Quality matters little at thumbnail size, and the
    // multi-step box filter would cost more than it is worth here.
    const scale = Math.min(1, maxHeight / full.height);
    if (scale === 1) return full.toDataURL('image/png');

    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(full.width * scale));
    small.height = Math.max(1, Math.round(full.height * scale));
    const ctx = small.getContext('2d');
    if (!ctx) throw new Error('No preview canvas context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, small.width, small.height);
    return small.toDataURL('image/png');
  } finally {
    if (!provided) closeBitmap(screenImg);
  }
}

/**
 * Renders a framed image straight to a PNG blob at full resolution.
 *
 * Pass `source` to reuse a bitmap that was already decoded (detection decodes
 * every file to read its dimensions), which halves the decode work per image.
 */
export async function renderFrameToBlob(
  file: File,
  frame: DeviceFrame,
  options: RenderOptions & { source?: ImageSource } = {}
): Promise<Blob> {
  const provided = options.source;
  const screenImg = provided ?? (await decodeFile(file));
  try {
    throwIfAborted(options.signal);

    const canvas = document.createElement('canvas');
    await renderFrameToCanvas(canvas, screenImg, frame, options);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode PNG'));
      }, 'image/png');
    });
  } finally {
    // Only release what we decoded here; the caller owns anything it passed in.
    if (!provided) closeBitmap(screenImg);
  }
}
