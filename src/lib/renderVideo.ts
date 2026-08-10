export interface VideoInfo {
  width: number;
  height: number;
  /** Seconds. */
  duration: number;
  frameCount: number;
}

/**
 * Frames expected for a duration at a frame rate.
 *
 * Rounds up because a trailing partial second still contains frames, and
 * guards NaN because an unknown duration would otherwise surface to the user
 * as "NaN%" on the progress bar.
 */
export function estimateFrameCount(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.ceil(duration * fps);
}

/**
 * Reads dimensions and duration without decoding the whole file.
 *
 * Uses a <video> element rather than mp4box: metadata is all that device
 * detection needs, and the element handles every container the browser can
 * play, including ones mp4box does not parse.
 */
export function probeVideo(file: File): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      const duration = video.duration;
      // 30fps is a progress-bar estimate only, not a claim about the video's
      // true frame rate. The real frame count is not knowable without demuxing.
      // Task 6 will clamp progress to 1 precisely because this estimate can be
      // wrong for 60fps or higher-rate videos.
      resolve({
        // videoWidth is the display size, already accounting for any
        // rotation metadata a phone recording carries.
        width: video.videoWidth,
        height: video.videoHeight,
        duration,
        frameCount: estimateFrameCount(duration, 30),
      });
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read this video. It may be corrupt or use an unsupported codec.'));
    };

    video.src = url;
  });
}
