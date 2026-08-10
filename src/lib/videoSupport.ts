/**
 * WebCodecs support gate.
 *
 * Split from renderVideo so the check is testable without constructing a real
 * encoder, and so the UI can refuse a video at drop time rather than failing
 * part-way through an encode.
 */

export const VIDEO_UNSUPPORTED_MESSAGE =
  'Video framing needs WebCodecs. Use Chrome, Edge, Safari 16.4+, or Firefox 130+.';

/** Codec string for H.264 High profile — the widest-playing MP4 encoding. */
export const H264_CODEC = 'avc1.640028';

/** Cheap synchronous gate: are the WebCodecs globals present at all? */
export function isVideoSupported(): boolean {
  const g = globalThis as Record<string, unknown>;
  return typeof g.VideoEncoder !== 'undefined' && typeof g.VideoDecoder !== 'undefined';
}

/**
 * Throws unless H.264 can actually be encoded at this size.
 *
 * The globals existing does not imply the codec is available, so this asks the
 * browser directly. Dimensions matter: some hardware encoders reject sizes
 * above their supported profile.
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
