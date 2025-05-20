import React, { useEffect, useState } from "react";
import { ImagePlus, Download, Trash2, Settings } from "lucide-react";
import UploadZone from "./UploadZone";
import FramePreview from "./FramePreview";
import FrameSettings from "./FrameSettings";
import { DeviceFrame } from "../hooks/useFrames";
import { toast } from "sonner";
import JSZip from "jszip";

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

  const [images, setImages] = useState<File[]>([]);
  const [selectedFrame, setSelectedFrame] = useState<DeviceFrame | undefined>(
    undefined
  );
  const [showSettings, setShowSettings] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(
    null
  );

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
    const allSizes = frames.map((f) => ({
      w: f.coordinates.screenshotWidth,
      h: f.coordinates.screenshotHeight,
    }));
    const found = frames.find((frame: DeviceFrame) => {
      const fw = frame.coordinates.screenshotWidth;
      const fh = frame.coordinates.screenshotHeight;
      return (
        typeof fw === "number" &&
        typeof fh === "number" &&
        Math.abs(fw - width) <= TOLERANCE &&
        Math.abs(fh - height) <= TOLERANCE
      );
    });
    return found;
  };

  const handleFilesSelected = (files: File[]) => {
    // Only accept image files
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
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
        setImages((prev) => {
          const newImages = [...prev, ...imageFiles];
          setSelectedImageIndex(newImages.length - 1);
          return newImages;
        });
      };
      img.src = URL.createObjectURL(imageFiles[0]);
    } else {
      setImages((prev) => {
        const newImages = [...prev, ...imageFiles];
        if (imageFiles.length > 0 && selectedImageIndex === null) {
          setSelectedImageIndex(newImages.length - 1);
        }
        return newImages;
      });
    }
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
    if (selectedImageIndex === index) {
      setSelectedImageIndex(images.length > 1 ? 0 : null);
    } else if (selectedImageIndex !== null && index < selectedImageIndex) {
      setSelectedImageIndex(selectedImageIndex - 1);
    }
  };

  const handleSelectImage = (index: number) => {
    setSelectedImageIndex(index);
  };

  const toggleSettings = () => {
    setShowSettings(!showSettings);
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
        // Mask doesn't exist, continue without it
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
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      // Use the currently selected frame for all images
      const blob = await renderFramedImage(image, selectedFrame!);
      zip.file(`framed-${image.name.replace(/\.[^/.]+$/, "")}.png`, blob);
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
      {images.length === 0 && (
        <div className="mb-8 px-2 py-5 bg-gradient-to-r from-gray-50 via-white to-gray-100 border border-gray-200 rounded-2xl shadow flex flex-col items-center text-center relative overflow-hidden">
          <p className="text-base md:text-lg text-gray-700 max-w-3xl mx-auto mb-1">
            Frame your <span className="font-semibold text-black">iPhone</span>,{" "}
            <span className="font-semibold text-black">iPad</span>, and{" "}
            <span className="font-semibold text-black">Apple Watch</span>{" "}
            screenshots in beautiful, realistic Apple device mockups.
          </p>
          <p className="text-sm text-gray-500 max-w-xl mx-auto">
            Just upload your screenshots—AppleFramer auto-detects the device,
            supports batch processing, and lets you download your framed images
            individually or as a zip. Perfect for App Store, marketing, or
            portfolio use.
          </p>
        </div>
      )}
      <div className="bg-white rounded-xl shadow-xl overflow-hidden transition-all duration-300">
        {images.length === 0 ? (
          <>
            <UploadZone onFilesSelected={handleFilesSelected} />
          </>
        ) : (
          <div className="flex flex-col md:flex-row min-h-[500px]">
            <div className="w-full md:w-3/4 p-6 flex items-center justify-center relative">
              {selectedImageIndex !== null && (
                <FramePreview
                  image={images[selectedImageIndex]}
                  frame={selectedFrame}
                />
              )}

              <button
                className="absolute top-4 right-4 p-2 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
                onClick={toggleSettings}
              >
                <Settings className="h-5 w-5 text-gray-600" />
              </button>
            </div>

            <div className="w-full md:w-1/4 bg-gray-50 p-4 border-t md:border-t-0 md:border-l border-gray-200">
              <div className="flex justify-between items-center mb-4">
                <h3 className="font-medium">Screenshots</h3>
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
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) {
                      handleFilesSelected(Array.from(e.target.files));
                    }
                  }}
                />
              </div>

              <div className="overflow-y-auto max-h-[400px] space-y-3">
                {images.map((image, index) => (
                  <div
                    key={index}
                    className={`flex items-center p-2 rounded-lg cursor-pointer transition-colors ${
                      selectedImageIndex === index
                        ? "bg-blue-50 border border-blue-200"
                        : "hover:bg-gray-100"
                    }`}
                    onClick={() => handleSelectImage(index)}
                  >
                    <div className="w-12 h-12 bg-gray-200 rounded-md overflow-hidden mr-3 flex-shrink-0">
                      <img
                        src={URL.createObjectURL(image)}
                        alt={`Preview ${index}`}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="flex-grow min-w-0">
                      <p className="text-sm truncate">{image.name}</p>
                      <p className="text-xs text-gray-500">
                        {Math.round(image.size / 1024)} KB
                      </p>
                    </div>
                    <button
                      className="ml-2 p-1 text-gray-400 hover:text-red-500 rounded-full hover:bg-gray-200 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveImage(index);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              {selectedImageIndex !== null && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  {images.length > 1 && (
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

      {showSettings && (
        <FrameSettings
          selectedFrame={selectedFrame}
          setSelectedFrame={setSelectedFrame}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
};

export default ScreenshotFramer;
