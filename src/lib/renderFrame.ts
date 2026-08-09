import { DeviceFrame, getFramePath } from '../hooks/useFrames';

/**
 * The single canvas pipeline for compositing a screenshot into a device frame.
 *
 * This used to exist twice — once in FramePreview for the on-screen canvas and
 * once in ScreenshotFramer for the zip export — and the two copies had already
 * drifted apart. The render queue needs one authoritative implementation, so
 * both callers now come through here.
 */

export interface RenderOptions {
  /** Solid background behind the device, or null for transparent. */
  backgroundColor?: string | null;
  /** Abort signal — checked at each async boundary so superseded renders stop early. */
  signal?: AbortSignal;
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
    return { frameImg, maskImg };
  })();

  frameAssetCache.set(framePath, pending);
  // A failed load must not poison the cache for later retries.
  pending.catch(() => frameAssetCache.delete(framePath));
  return pending;
}

/**
 * Composites `screenImg` into `frame` on `canvas`, sizing the canvas to the
 * frame's natural dimensions.
 */
export async function renderFrameToCanvas(
  canvas: HTMLCanvasElement,
  screenImg: HTMLImageElement,
  frame: DeviceFrame,
  { backgroundColor = null, signal }: RenderOptions = {}
): Promise<void> {
  throwIfAborted(signal);

  const { frameImg, maskImg } = await loadFrameAssets(frame);
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

  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) throw new Error('No temp canvas context');
  tempCtx.imageSmoothingEnabled = false;

  const { x, y, screenshotWidth, screenshotHeight } = frame.coordinates;
  const screenshotX = parseInt(x);
  const screenshotY = parseInt(y);
  const targetWidth = screenshotWidth || screenImg.width;
  const targetHeight = screenshotHeight || screenImg.height;

  // Only inset when there's no mask — the mask already handles corner clipping.
  const EDGE_INSET = maskImg ? 0 : 3;
  const adjustedWidth = targetWidth - EDGE_INSET * 2;
  const adjustedHeight = targetHeight - EDGE_INSET * 2;
  const adjustedX = screenshotX + EDGE_INSET;
  const adjustedY = screenshotY + EDGE_INSET;

  if (maskImg) {
    tempCtx.clearRect(0, 0, canvas.width, canvas.height);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = adjustedWidth;
    maskCanvas.height = adjustedHeight;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) throw new Error('No mask canvas context');
    maskCtx.imageSmoothingEnabled = false;
    maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);

    const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    tempCtx.drawImage(screenImg, adjustedX, adjustedY, adjustedWidth, adjustedHeight);
    const imageData = tempCtx.getImageData(adjustedX, adjustedY, adjustedWidth, adjustedHeight);

    for (let i = 0; i < maskData.data.length; i += 4) {
      // Treat near-black as masked: some masks use (0,0,1) rather than pure black.
      const threshold = 10;
      if (
        maskData.data[i] < threshold &&
        maskData.data[i + 1] < threshold &&
        maskData.data[i + 2] < threshold
      ) {
        imageData.data[i + 3] = 0;
      }
    }

    tempCtx.putImageData(imageData, adjustedX, adjustedY);
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

/** Renders a framed image straight to a PNG blob. */
export async function renderFrameToBlob(
  file: File,
  frame: DeviceFrame,
  options: RenderOptions = {}
): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const screenImg = await loadImage(url);
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
    URL.revokeObjectURL(url);
  }
}

/** Reads a File's intrinsic pixel dimensions. */
export async function readImageSize(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { width: img.width, height: img.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
