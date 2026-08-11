/**
 * WebCodecs support gate.
 *
 * Split from renderVideo so the check is testable without constructing a real
 * encoder, and so the UI can refuse a video at drop time rather than failing
 * part-way through an encode.
 */

export const VIDEO_UNSUPPORTED_MESSAGE =
  'Video framing needs WebCodecs. Use Chrome, Edge, Safari 16.4+, or Firefox 130+.';

/**
 * Shown when WebCodecs is present and working but refuses this particular
 * output size.
 *
 * Kept distinct from VIDEO_UNSUPPORTED_MESSAGE because the two are different
 * problems with different user responses: that one says "switch browsers", and
 * saying it here would send a user on Chrome — where WebCodecs is fully
 * available — to install a second browser that fails identically, since the
 * limit below is the codec level's, not the browser's. This one means the frame
 * is too large to encode even after downscaling, which the user cannot fix by
 * switching browsers and which should not happen for any shipped frame.
 */
export const VIDEO_SIZE_UNSUPPORTED_MESSAGE =
  'This device frame is too large for your browser to encode as video. Try a different device.';

/** Codec string for H.264 High profile — the widest-playing MP4 encoding. */
export const H264_CODEC = 'avc1.640028';

/**
 * Macroblocks the encoder will accept in a single frame.
 *
 * This is the binding constraint on output size, and it is an AREA limit rather
 * than a per-dimension one — which is why "cap the long edge" is not a correct
 * rule and was measured failing. `avc1.640028` asks for H.264 High profile at
 * level 4.0 (the trailing 0x28 == 40 == level 4.0), whose MaxFrameSize is 8192
 * macroblocks of 16x16 pixels.
 *
 * Measured in headless Chromium against VideoEncoder.isConfigSupported, by
 * sweeping the maximum accepted width at each of twelve heights:
 *
 *   1920x1088 ok    1632x1280 ok    1456x1440 ok    1296x1600 ok
 *   1088x1920 ok    1024x2048 ok     896x2304 ok     816x2560 ok
 *
 * Every one of those lands within a macroblock or two of 8192, from a 16:9
 * landscape frame to a 1:32 sliver — the product is conserved while the shape
 * is not, which is what makes this an area law. Predicting support with the
 * formula below then matched the browser on 700/700 random sizes in the range
 * device bezels actually occupy.
 *
 * Concretely, this is why the user's bug could not be fixed by scaling to a
 * standard video height: the iPhone 8 Plus frame scaled to 1096x1920 is 8280
 * macroblocks and is still rejected, despite 1088x1920 — 8 pixels narrower —
 * being fine.
 */
export const H264_MAX_MACROBLOCKS = 8192;

/** H.264 encodes in 16x16 macroblocks; a partial one still costs a whole block. */
const MACROBLOCK = 16;

/** Macroblocks a frame of this pixel size occupies. */
export function macroblockCount(width: number, height: number): number {
  return Math.ceil(width / MACROBLOCK) * Math.ceil(height / MACROBLOCK);
}

/** Whether a size fits within the encoder's per-frame macroblock budget. */
export function fitsMacroblockBudget(width: number, height: number): boolean {
  return macroblockCount(width, height) <= H264_MAX_MACROBLOCKS;
}

export interface OutputSize {
  width: number;
  height: number;
}

/**
 * The largest encodable size with `width`x`height`'s aspect ratio.
 *
 * Device bezels are far bigger than H.264 level 4.0 allows — 87 of the 98
 * shipped frames exceed 2048px on their long edge and the largest is 4760px —
 * so compositing at full bezel resolution and handing that to the encoder fails
 * on essentially every device. The composite still happens at full resolution;
 * this is only the size it is scaled down to on the way into the encoder, so
 * the output looks the same, just smaller.
 *
 * Both returned dimensions are even. H.264 rejects odd dimensions outright, and
 * because 4:2:0 chroma is subsampled by two there is no way to represent one.
 * Rounding DOWN to even rather than up matters: rounding up can cross a
 * macroblock boundary and push a size that just fit back over the budget.
 *
 * The search is a loop rather than a closed-form scale factor because the
 * budget is measured in whole macroblocks. Ceiling division makes the fit a
 * step function of the pixel size, so a continuous ratio can land a pixel or
 * two into the next macroblock row and overshoot; shrinking until it actually
 * fits is exact by construction. It converges in a handful of steps — each pass
 * removes at least a full macroblock of area — and the loop is bounded anyway.
 *
 * Never scales UP. A frame already within budget is returned at its own size
 * (evened), because enlarging it would invent detail and cost encode time for
 * nothing.
 */
export function encodableOutputSize(width: number, height: number): OutputSize {
  // Guard degenerate input rather than looping on it. A zero or negative
  // dimension cannot come from a loaded frame PNG, but it would otherwise spin.
  if (!(width > 0) || !(height > 0)) return { width: 2, height: 2 };

  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

  let outWidth = even(width);
  let outHeight = even(height);

  // Shrink along the longer edge's ratio until the area fits. Scaling both by
  // the same factor is what preserves the aspect ratio; recomputing from the
  // ORIGINAL dimensions each pass rather than from the previous result keeps
  // rounding error from compounding across iterations.
  let scale = 1;
  // 4096 passes is far more than the handful this needs; it exists so a
  // pathological aspect ratio cannot hang the encode instead of failing it.
  for (let guard = 0; guard < 4096; guard += 1) {
    if (fitsMacroblockBudget(outWidth, outHeight)) break;
    // The excess is an area ratio, so the linear correction is its square root.
    // Multiplying by slightly less than the exact root guarantees forward
    // progress even when the root rounds back to the same even pixel size.
    const excess = macroblockCount(outWidth, outHeight) / H264_MAX_MACROBLOCKS;
    scale = Math.min(scale / Math.sqrt(excess), scale - 0.001);
    outWidth = even(width * scale);
    outHeight = even(height * scale);
  }

  return { width: outWidth, height: outHeight };
}

/** Cheap synchronous gate: are the WebCodecs globals present at all? */
export function isVideoSupported(): boolean {
  const g = globalThis as Record<string, unknown>;
  return typeof g.VideoEncoder !== 'undefined' && typeof g.VideoDecoder !== 'undefined';
}

/**
 * Throws unless H.264 can actually be encoded at all.
 *
 * The globals existing does not imply the codec is available, so this asks the
 * browser directly. The default size is a plain 1080x1920 — well inside the
 * macroblock budget — because this gate answers "can this browser encode
 * H.264?", not "can it encode the frame we are about to use". The output size
 * is not even known here: it depends on the device frame, which is chosen
 * later. Failing this means WebCodecs is absent or broken, which is what
 * VIDEO_UNSUPPORTED_MESSAGE describes.
 */
export async function assertVideoSupported(width = 1080, height = 1920): Promise<void> {
  if (!isVideoSupported()) throw new Error(VIDEO_UNSUPPORTED_MESSAGE);

  const { supported } = await VideoEncoder.isConfigSupported({
    codec: H264_CODEC,
    width,
    height,
  });
  if (!supported) throw new Error(VIDEO_UNSUPPORTED_MESSAGE);
}
