import React, { createContext, useContext, useState, useCallback } from 'react';
import { ffmpegClient, fetchFile } from '../ffmpegClient';
import { DeviceFrame } from '../hooks/useFrames';
import { toast } from 'sonner';

interface FfmpegContextType {
  isExtractingFrame: boolean;
  isProcessingVideo: boolean;
  ffmpegError: string | null;
  videoFrame: Blob | null;
  videoFrameFile: File | null;
  videoOutput: Blob | null;
  ffmpegLog: string | null;
  progress: number;
  extractVideoFrame: (
    videoFile: File,
    frames: DeviceFrame[],
    findFrameByScreenshotSize: (frames: DeviceFrame[], width: number, height: number) => DeviceFrame | undefined,
    setSelectedFrame: (frame: DeviceFrame) => void
  ) => Promise<void>;
  processVideoWithFrame: (params: {
    video: File,
    selectedFrame: DeviceFrame,
  }) => Promise<void>;
  setVideoOutput: React.Dispatch<React.SetStateAction<Blob | null>>;
  setVideoFrame: React.Dispatch<React.SetStateAction<Blob | null>>;
  setVideoFrameFile: React.Dispatch<React.SetStateAction<File | null>>;
  setFfmpegError: React.Dispatch<React.SetStateAction<string | null>>;
}

const FfmpegContext = createContext<FfmpegContextType | undefined>(undefined);

export const FfmpegProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isExtractingFrame, setIsExtractingFrame] = useState(false);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [videoFrame, setVideoFrame] = useState<Blob | null>(null);
  const [videoFrameFile, setVideoFrameFile] = useState<File | null>(null);
  const [videoOutput, setVideoOutput] = useState<Blob | null>(null);
  const [ffmpegLog, setFfmpegLog] = useState<string | null>(null);
  const [progress, setProgress] = useState<number>(0);

  const setupFfmpeg = useCallback(async () => {
    await ffmpegClient.reset();
    await ffmpegClient.load((progress) => {
      setProgress(progress);
    }, (message) => {
      setFfmpegLog(current => current ? `${current}\n${message}` : message);
    });
  }, []);

  const exec = useCallback(async (args: string[]) => {
    setFfmpegLog(null);
    setProgress(0);
    await ffmpegClient.exec(args);
    setFfmpegLog(null);
    setProgress(0);
  }, []);

  // Extract a frame from a video file
  const extractVideoFrame = useCallback(
    async (
      videoFile: File,
      frames: DeviceFrame[],
      findFrameByScreenshotSize: (frames: DeviceFrame[], width: number, height: number) => DeviceFrame | undefined,
      setSelectedFrame: (frame: DeviceFrame) => void
    ) => {
      setIsExtractingFrame(true);
      try {
        await setupFfmpeg();
        await ffmpegClient.writeFile('input.mp4', await fetchFile(videoFile));
        await exec([
          "-i",
          "input.mp4",
          "-vframes",
          "1",
          "-f",
          "image2",
          "video.png"
        ]);
        const frameData = await ffmpegClient.readFile('video.png');
        const blob = new Blob([frameData as Uint8Array], { type: 'image/png' });
        setVideoFrame(blob);
        const file = new File([blob], 'frame.png', { type: 'image/png' });
        setVideoFrameFile(file);
        // Auto-detect device frame
        const img = new window.Image();
        img.onload = () => {
          const detectedFrame = findFrameByScreenshotSize(
            frames,
            img.width,
            img.height
          );
          if (detectedFrame) {
            setSelectedFrame(detectedFrame);
            toast.success(
              `Auto-detected: ${detectedFrame.coordinates.name} (${img.width}x${img.height}px)`
            );
          } else {
            toast.warning(
              `No matching device found for size ${img.width}x${img.height}px`
            );
          }
        };
        img.src = URL.createObjectURL(blob);
      } catch (error) {
        setFfmpegError('Error extracting video frame');
        console.error('Error extracting video frame:', error);
      } finally {
        setIsExtractingFrame(false);
        setIsProcessingVideo(false);
      }
    },
    [exec, setupFfmpeg]
  );

  // Process video with frame overlay and mask
  const processVideoWithFrame = useCallback(
    async ({ video, selectedFrame }: { video: File, selectedFrame: DeviceFrame }) => {
      setIsProcessingVideo(true);
      setFfmpegError(null);
      try {
        await setupFfmpeg();
        await ffmpegClient.writeFile('input.mp4', await fetchFile(video));
        // Write frame overlay
        const frameName = selectedFrame.coordinates.name;
        const framePath = `/frames/${frameName}.png`;
        const frameResp = await fetch(framePath);
        if (!frameResp.ok) throw new Error('Failed to fetch frame overlay image');
        const frameBlob = await frameResp.blob();
        await ffmpegClient.writeFile('frame.png', new Uint8Array(await frameBlob.arrayBuffer()));
        // Try to write mask (optional)
        let hasMask = false;
        const maskPath = `/frames/${frameName}_mask.png`;
        let maskBlob: Blob | null = null;
        try {
          const maskResp = await fetch(maskPath);
          if (maskResp.ok) {
            maskBlob = await maskResp.blob();
            await ffmpegClient.writeFile('mask.png', new Uint8Array(await maskBlob.arrayBuffer()));
            hasMask = true;
          }
        } catch {
          // Mask doesn't exist or failed to fetch, continue without it
        }
        // Get coordinates for screenshot placement
        const { x, y, screenshotWidth, screenshotHeight } = selectedFrame.coordinates;
        if (typeof screenshotWidth !== 'number' || typeof screenshotHeight !== 'number') {
          throw new Error('Frame coordinates missing screenshotWidth or screenshotHeight');
        }

        // Compose ffmpeg filter
        let filter;
        if (hasMask) {
          filter = `
            [1]format=rgba[base_frame];
            [0]scale=-1:-1[scaled_video];
            [scaled_video][2]alphamerge[masked_video];
            [base_frame][masked_video]overlay=x=${x}:y=${y}[with_video];
            [with_video][1]overlay=x=0:y=0[out]
          `;
        } else {
          filter = `
            [1]format=rgba[base_frame];
            [0]scale=-1:-1[scaled_video];
            [base_frame][scaled_video]overlay=x=${x}:y=${y}[with_video];
            [with_video][1]overlay=x=0:y=0[out]
          `;
        }
        filter = filter.replace(/\s+/g, ' ');
        const args = hasMask
          ? [
              '-i', 'input.mp4',
              '-i', 'frame.png',
              '-i', 'mask.png',
              '-filter_complex', filter,
              '-map', '[out]',
              '-map', '0:a?',
              '-c:a', 'copy',
              '-shortest',
              'output.mp4',
            ]
          : [
              '-i', 'input.mp4',
              '-i', 'frame.png',
              '-filter_complex', filter,
              '-map', '[out]',
              '-map', '0:a?',
              '-c:v', 'libx264',
              '-c:a', 'copy',
              '-shortest',
              'output.mp4',
            ];
        await exec(args);
        const data = await ffmpegClient.readFile('output.mp4');
        const outBlob = new Blob([data as Uint8Array], { type: 'video/mp4' });
        setVideoOutput(outBlob);
        toast.success('Framed video created!');
      } catch (err: unknown) {
        if (err instanceof Error) {
          setFfmpegError(err.message);
        } else {
          setFfmpegError('Failed to process video');
        }
        toast.error('Failed to process video');
      } finally {
        setIsProcessingVideo(false);
      }
    },
    [exec, setupFfmpeg]
  );

  return (
    <FfmpegContext.Provider
      value={{
        isExtractingFrame,
        isProcessingVideo,
        ffmpegError,
        videoFrame,
        videoFrameFile,
        videoOutput,
        ffmpegLog,
        progress,
        extractVideoFrame,
        processVideoWithFrame,
        setVideoOutput,
        setVideoFrame,
        setVideoFrameFile,
        setFfmpegError,
      }}
    >
      {children}
    </FfmpegContext.Provider>
  );
};

export function useFfmpeg() {
  const ctx = useContext(FfmpegContext);
  if (!ctx) throw new Error('useFfmpeg must be used within a FfmpegProvider');
  return ctx;
} 