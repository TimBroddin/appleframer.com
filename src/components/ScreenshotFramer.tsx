import React, { useEffect, useState } from "react";
import { ImagePlus, Download, Trash2 } from "lucide-react";
import UploadZone from "./UploadZone";
import FramePreview from "./FramePreview";
import { DeviceFrame } from "../hooks/useFrames";
import { toast } from "sonner";
import JSZip from "jszip";
import { ffmpegClient, fetchFile } from '../ffmpegClient';

interface ScreenshotFramerProps {
  frames: DeviceFrame[];
  isLoading: boolean;
  error: string | null;
}

const ScreenshotFramer = ({
  frames,
  isLoading,
  error,
}: ScreenshotFramerProps) => {
  const TOLERANCE = 2;

  const [selectedFrame, setSelectedFrame] = useState<DeviceFrame | undefined>(
    undefined
  );
  const [selectedMediaIndex, setSelectedMediaIndex] = useState<number | null>(null);
  const [media, setMedia] = useState<Array<{ type: 'image' | 'video', file: File }>>([]);
  const [isExtractingFrame, setIsExtractingFrame] = useState(false);
  const [video, setVideo] = useState<File | null>(null);
  const [videoOutput, setVideoOutput] = useState<Blob | null>(null);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [videoFrame, setVideoFrame] = useState<Blob | null>(null);
  const [videoFrameFile, setVideoFrameFile] = useState<File | null>(null);

  // Update selectedFrame when frames are loaded
  useEffect(() => {
    if (frames.length > 0 && !selectedFrame) {
      setSelectedFrame(frames[0]);
    }
  }, [frames, selectedFrame]);

  const findFrameByScreenshotSize = (
    frames: DeviceFrame[],
    width: number,
    height: number
  ): DeviceFrame | undefined => {
    return frames.find((frame: DeviceFrame) => {
      const fw = frame.coordinates.screenshotWidth;
      const fh = frame.coordinates.screenshotHeight;
      return (
        typeof fw === "number" &&
        typeof fh === "number" &&
        Math.abs(fw - width) <= TOLERANCE &&
        Math.abs(fh - height) <= TOLERANCE
      );
    });
  };

  const extractVideoFrame = async (videoFile: File) => {
    setIsExtractingFrame(true);
    try {
      console.log('resetting ffmpeg');
      await ffmpegClient.reset();
      console.log('loading ffmpeg');
      await ffmpegClient.load();
      console.log('writing file');
      await ffmpegClient.writeFile('input.mp4', await fetchFile(videoFile));
      console.log('executing ffmpeg');
      // Extract the first frame as PNG
      await ffmpegClient.exec([
        "-i",
        "input.mp4",
        "-vframes",
        "1",
        "-f",
        "image2",
        "video.png"
      ]);
      console.log('reading file');
      const frameData = await ffmpegClient.readFile('video.png');
      console.log('creating blob');
      const blob = new Blob([frameData as Uint8Array], { type: 'image/png' });
      setVideoFrame(blob);
      // Create a File from the Blob for consistent preview
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
      console.error('Error extracting video frame:', error);
    } finally {
      setIsExtractingFrame(false);
    }
  };

  const handleFilesSelected = (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const videoFiles = files.filter((file) => file.type.startsWith('video/'));
    const newMedia: Array<{ type: 'image' | 'video', file: File }> = [];
    imageFiles.forEach((file) => newMedia.push({ type: 'image', file }));
    videoFiles.forEach((file) => newMedia.push({ type: 'video', file }));
    setMedia((prev) => {
      const updated = [...prev, ...newMedia];
      setSelectedMediaIndex(updated.length - 1);
      return updated;
    });
    // For images, auto-detect frame
    if (imageFiles.length > 0) {
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
      img.src = URL.createObjectURL(imageFiles[0]);
    }
    // For video, extract frame
    if (videoFiles.length > 0) {
      setVideo(videoFiles[0]);
      setVideoOutput(null);
      setVideoFrame(null);
      setVideoFrameFile(null);
      extractVideoFrame(videoFiles[0]);
      toast.info(`Video file selected: ${videoFiles[0].name}`);
    }
  };

  const handleRemoveMedia = (index: number) => {
    setMedia((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      if (selectedMediaIndex === index) {
        setSelectedMediaIndex(updated.length > 0 ? 0 : null);
      } else if (selectedMediaIndex !== null && index < selectedMediaIndex) {
        setSelectedMediaIndex(selectedMediaIndex - 1);
      }
      return updated;
    });
    // If removing a video, clear video state
    if (media[index]?.type === 'video') {
      setVideo(null);
      setVideoOutput(null);
      setVideoFrame(null);
      setVideoFrameFile(null);
    }
  };

  const handleSelectMedia = (index: number) => {
    setSelectedMediaIndex(index);
    if (media[index]?.type === 'video') {
      setVideo(media[index].file);
      // If frame not yet extracted, extract it
      if (!videoFrame) extractVideoFrame(media[index].file);
    }
  };

  // Helper to render a framed image for a given File and frame, returns a PNG blob
  const renderFramedImage = async (
    image: File,
    frame: DeviceFrame
  ): Promise<Blob> => {
    // Dynamically import FramePreview's draw logic
    // We'll inline the logic here for simplicity
    const loadImage = (src: string): Promise<HTMLImageElement> => {
      return new Promise((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    };
    const imageUrl = URL.createObjectURL(image);
    try {
      const frameName = frame.coordinates.name;
      const framePath = `/frames/${frameName}.png`;
      const maskPath = `/frames/${frameName}_mask.png`;
      const [screenImg, frameImg] = await Promise.all([
        loadImage(imageUrl),
        loadImage(framePath),
      ]);
      let maskImg: HTMLImageElement | null = null;
      try {
        maskImg = await loadImage(maskPath);
      } catch {
        // Mask doesn't exist or failed to fetch, continue without it
      }
      // Use original size for download
      const scale = 1;
      const canvas = document.createElement("canvas");
      canvas.width = frameImg.width * scale;
      canvas.height = frameImg.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No canvas context");
      // Create a temporary canvas for the masked screenshot
      const tempCanvas = document.createElement("canvas");
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) throw new Error("No temp canvas context");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const { x, y } = frame.coordinates;
      const screenshotX = parseInt(x) * scale;
      const screenshotY = parseInt(y) * scale;
      if (maskImg) {
        tempCtx.clearRect(0, 0, canvas.width, canvas.height);
        const maskCanvas = document.createElement("canvas");
        const maskCtx = maskCanvas.getContext("2d");
        if (!maskCtx) throw new Error("No mask canvas context");
        maskCanvas.width = screenImg.width * scale;
        maskCanvas.height = screenImg.height * scale;
        maskCtx.drawImage(maskImg, 0, 0, maskCanvas.width, maskCanvas.height);
        const maskData = maskCtx.getImageData(
          0,
          0,
          maskCanvas.width,
          maskCanvas.height
        );
        tempCtx.drawImage(
          screenImg,
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );
        const imageData = tempCtx.getImageData(
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );
        for (let i = 0; i < maskData.data.length; i += 4) {
          if (
            maskData.data[i] === 0 &&
            maskData.data[i + 1] === 0 &&
            maskData.data[i + 2] === 0
          ) {
            imageData.data[i + 3] = 0;
          }
        }
        tempCtx.putImageData(imageData, screenshotX, screenshotY);
        ctx.drawImage(tempCanvas, 0, 0);
      } else {
        ctx.drawImage(
          screenImg,
          screenshotX,
          screenshotY,
          screenImg.width * scale,
          screenImg.height * scale
        );
      }
      ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
        }, "image/png");
      });
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  };

  // Download all framed images as zip
  const handleDownloadZip = async () => {
    toast.info("Creating a zip...");
    const zip = new JSZip();
    for (let i = 0; i < media.length; i++) {
      const item = media[i];
      // Use the currently selected frame for all images
      const blob = await renderFramedImage(item.file, selectedFrame!);
      zip.file(`framed-${item.file.name.replace(/\.[^/.]+$/, "")}.png`, blob);
    }
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = "framed-screenshots.zip";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast.success("Zip created successfully!");
  };

  // Helper to get video duration
  const getVideoDuration = (file: File): Promise<number> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = function() {
        resolve(video.duration);
      };
      video.onerror = reject;
      video.src = URL.createObjectURL(file);
    });
  };

  // Helper to process video with frame overlay and mask using ffmpegClient
  const processVideoWithFrame = async () => {
    if (!video || !selectedFrame) return;
    setIsProcessingVideo(true);
    setFfmpegError(null);
    try {
      await ffmpegClient.reset();
      await ffmpegClient.load();
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
      // Get video duration
      const duration = await getVideoDuration(video);
      // Compose ffmpeg filter
      let filter;
      if (hasMask) {
        // 0: input.mp4, 1: frame.png, 2: mask.png
        filter = `\
          [0:v]format=rgba[vid]; \
          [2][vid]alphamerge[masked]; \
          color=color=0x00000000:size=${screenshotWidth}x${screenshotHeight}:d=${duration}[transparent]; \
          [transparent][masked]overlay=0:0[placed]; \
          color=color=0x00000000:size=${screenshotWidth + parseInt(x)}x${screenshotHeight + parseInt(y)}:d=${duration}[canvas]; \
          [canvas][placed]overlay=${x}:${y}[screenshot_on_canvas]; \
          [screenshot_on_canvas][1:v]overlay=0:0:format=auto[final]; \
          [final]pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2[out]`;
      } else {
        filter = `\
          [0:v]format=rgba[vid]; \
          color=color=0x00000000:size=${screenshotWidth + parseInt(x)}x${screenshotHeight + parseInt(y)}:d=${duration}[canvas]; \
          [canvas][vid]overlay=${x}:${y}[screenshot_on_canvas]; \
          [screenshot_on_canvas][1:v]overlay=0:0:format=auto[final]; \
          [final]pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2[out]`;
      }
      // Remove newlines and extra spaces for ffmpeg
      filter = filter.replace(/\s+/g, ' ');
      const args = hasMask
        ? [
            '-i', 'input.mp4',
            '-i', 'frame.png',
            '-i', 'mask.png',
            '-filter_complex', filter,
            '-map', '[out]',
            '-map', '0:a?',
            '-c:v', 'libx264',
            '-c:a', 'copy',
            '-shortest',
            '-t', duration.toString(),
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
            '-t', duration.toString(),
            'output.mp4',
          ];
      console.log(args.join(' '));
      const result = await ffmpegClient.exec(args);
      console.log('ffmpeg result', result);

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
  };

  if (isLoading) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl p-8 text-center">
          <p className="text-gray-500">Loading available frames...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl p-8 text-center">
          <p className="text-red-500">Error loading frames: {error}</p>
        </div>
      </div>
    );
  }

  // If no frames or no selectedFrame, show the uploader
  if (!frames.length || !selectedFrame) {
    return (
      <div className="w-full max-w-6xl">
        <div className="bg-white rounded-xl shadow-xl overflow-hidden transition-all duration-300">
          <UploadZone onFilesSelected={handleFilesSelected} />
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-6xl">
      {media.length === 0 && (
        <div className="mb-8 px-2 py-5 bg-gradient-to-r from-gray-50 via-white to-gray-100 border border-gray-200 rounded-2xl shadow flex flex-col items-center text-center relative overflow-hidden">
          <p className="text-base md:text-lg text-gray-700 max-w-3xl mx-auto mb-1">
            Frame your <span className="font-semibold text-black">iPhone</span>,{" "}
            <span className="font-semibold text-black">iPad</span>, and{" "}
            <span className="font-semibold text-black">Apple Watch</span>{" "}
            screenshots <b>or videos</b> in beautiful, realistic Apple device mockups.
          </p>
          <p className="text-sm text-gray-500 max-w-xl mx-auto">
            Just upload your screenshots or videos—AppleFramer auto-detects the device,
            supports batch processing, and lets you download your framed images or videos
            individually or as a zip. Perfect for App Store, marketing, or portfolio use.
          </p>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-xl overflow-hidden transition-all duration-300">
        {media.length === 0 ? (
          <UploadZone onFilesSelected={handleFilesSelected} accept="image/*,video/*" />
        ) : (
          <div className="flex flex-col md:flex-row min-h-[500px]">
            <div className="w-full md:w-3/4 p-6 flex flex-col items-center justify-center relative">
              {isExtractingFrame && media[selectedMediaIndex!]?.type === 'video' ? (
                <div className="flex flex-col items-center justify-center w-full h-full min-h-[300px]">
                  <div className="text-blue-600 font-medium text-lg mb-2">Extracting video frame, please wait...</div>
                  <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin mb-4"></div>
                </div>
              ) : selectedMediaIndex !== null && media[selectedMediaIndex]?.type === 'video' && videoFrameFile ? (
                <FramePreview
                  image={videoFrameFile}
                  frame={selectedFrame}
                />
              ) : selectedMediaIndex !== null && media[selectedMediaIndex]?.type === 'image' ? (
                <FramePreview
                  image={media[selectedMediaIndex].file}
                  frame={selectedFrame}
                />
              ) : null}
              {isProcessingVideo && media[selectedMediaIndex!]?.type === 'video' ? (
                <div className="flex flex-col items-center justify-center w-full h-full min-h-[100px]">
                  <div className="text-blue-600 font-medium text-lg mb-2">Processing video, please wait...</div>
                  <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-500 rounded-full animate-spin"></div>
                </div>
              ) : null}
              {media[selectedMediaIndex!]?.type === 'video' && !isProcessingVideo && !isExtractingFrame && (
                videoOutput ? (
                  <a
                    href={URL.createObjectURL(videoOutput)}
                    download={`framed-${media[selectedMediaIndex!].file.name.replace(/\.[^/.]+$/, '')}.mp4`}
                    className="w-full py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center justify-center transition-colors text-center mt-4"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Framed Video
                  </a>
                ) : (
                  <button
                    className="w-full py-2 px-4 bg-green-500 hover:bg-green-600 text-white rounded-lg flex items-center justify-center transition-colors mt-4"
                    onClick={processVideoWithFrame}
                    disabled={isProcessingVideo || isExtractingFrame}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Movie
                  </button>
                )
              )}
              {ffmpegError && <div className="text-red-500 mt-2">{ffmpegError}</div>}
              {media[selectedMediaIndex!]?.type === 'video' && (
                <button
                  className="mt-4 text-sm text-gray-500 hover:text-red-500"
                  onClick={() => {
                    handleRemoveMedia(selectedMediaIndex!);
                  }}
                >
                  Remove Video
                </button>
              )}
            </div>
            <div className="w-full md:w-1/4 bg-gray-50 p-4 border-t md:border-t-0 md:border-l border-gray-200">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-medium">Media</h3>
                <button
                  className="flex items-center text-sm text-blue-500 hover:text-blue-600"
                  onClick={() => document.getElementById("file-input")?.click()}
                >
                  <ImagePlus className="h-4 w-4 mr-1" />
                  Add more
                </button>
                <input
                  id="file-input"
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) {
                      handleFilesSelected(Array.from(e.target.files));
                    }
                  }}
                />
              </div>
              <div className="overflow-y-auto max-h-[400px] space-y-3">
                {media.map((item, index) => (
                  <div
                    key={index}
                    className={`flex items-center p-2 rounded-lg cursor-pointer transition-colors ${
                      selectedMediaIndex === index
                        ? "bg-blue-50 border border-blue-200"
                        : "hover:bg-gray-100"
                    }`}
                    onClick={() => handleSelectMedia(index)}
                  >
                    <div className="w-12 h-12 bg-gray-200 rounded-md overflow-hidden mr-3 flex-shrink-0 relative">
                      {item.type === 'image' ? (
                        <img
                          src={URL.createObjectURL(item.file)}
                          alt={`Preview ${index}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <>
                          {videoFrameFile && index === selectedMediaIndex ? (
                            <img
                              src={URL.createObjectURL(videoFrameFile)}
                              alt={`Video frame ${index}`}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <video
                              src={URL.createObjectURL(item.file)}
                              className="w-full h-full object-cover"
                              muted
                              preload="metadata"
                            />
                          )}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <svg className="w-8 h-8 text-white/80" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm truncate">{item.file.name}</p>
                      <p className="text-xs text-gray-500">
                        {Math.round(item.file.size / 1024)} KB
                      </p>
                    </div>
                    <button
                      className="ml-2 p-1 text-gray-400 hover:text-red-500 rounded-full hover:bg-gray-200 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveMedia(index);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              {selectedMediaIndex !== null && media[selectedMediaIndex]?.type === 'image' && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  {media.filter(m => m.type === 'image').length > 1 && (
                    <button
                      className="w-full mb-2 py-2 px-4 bg-green-500 hover:bg-green-600 text-white rounded-lg flex items-center justify-center transition-colors"
                      onClick={handleDownloadZip}
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download All as Zip
                    </button>
                  )}
                  <button
                    className="w-full py-2 px-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center justify-center transition-colors"
                    onClick={() => {
                      document.getElementById("download-button")?.click();
                    }}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download Framed Image
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ScreenshotFramer;
